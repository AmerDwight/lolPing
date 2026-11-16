// Electron's main-process API on the Tauri shell, for src/main as it is. build-web.mjs points `electron` here for the
// core page. What the app doesn't use on Windows or Linux is a harmless stand-in.
import type { Rect } from '../../../src/main/coords';
import { boot } from '../bootInfo';
import { PAGE_READY } from '../channels';
import { dipToPhys, physToDip, sameMonitors, toDisplays, type Monitor, type ShimDisplay } from '../displays';
import { onShell } from '../hub';
import { EventEmitter } from '../node/events';
import { join } from '../node/path';
import { sysAsync, sysSync } from '../sys';
import { invoke } from '../tauri';
import { decodeWire, encodeWire } from '../wire';
import { NativeImage, nativeImage } from './image';

export { nativeImage, NativeImage };

const APP_ROOT = '/__lolping_app__';
const APP_PAGE = /^lolping:\/\/app\/([^#?]+)([#?].*)?$/;

const log = (msg: string): void => {
  invoke('log', { msg }).catch(() => undefined);
};

/** An Electron event object: listeners may call preventDefault(). */
function preventable(extra: Record<string, unknown> = {}): { defaultPrevented: boolean; preventDefault(): void } & Record<string, unknown> {
  const e = {
    ...extra,
    defaultPrevented: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
  };
  return e;
}

// --- app ------------------------------------------------------------------------------------------------------------

class App extends EventEmitter {
  readonly isPackaged = true;
  readonly commandLine = { appendSwitch: (): void => undefined, hasSwitch: (): boolean => false, getSwitchValue: (): string => '' };
  readonly dock = undefined;
  private paths: Record<string, string> | null = null;
  private quitting = false;

  private allPaths(): Record<string, string> {
    if (!this.paths) {
      const b = boot();
      const userData = join(b.appData, 'lolPing');
      this.paths = {
        appData: b.appData, userData, sessionData: userData, logs: join(userData, 'logs'), temp: b.temp, home: b.home,
        downloads: b.downloads, desktop: join(b.home, 'Desktop'), documents: join(b.home, 'Documents'), exe: b.exe,
        module: b.exe, crashDumps: join(userData, 'Crashpad'),
      };
    }
    return this.paths;
  }

  getPath(name: string): string {
    const p = this.allPaths()[name];
    if (!p) throw new Error(`Failed to get '${name}' path`);
    return p;
  }

  setPath(name: string, p: string): void {
    this.allPaths()[name] = p;
  }

  getVersion(): string {
    return __LOLPING_VERSION__;
  }

  getName(): string {
    return 'lolPing';
  }

  getLocale(): string {
    return navigator.language;
  }

  getSystemLocale(): string {
    return navigator.language;
  }

  getPreferredSystemLanguages(): string[] {
    return [...navigator.languages];
  }

  getAppPath(): string {
    return APP_ROOT;
  }

  whenReady(): Promise<void> {
    return Promise.resolve();
  }

  isReady(): boolean {
    return true;
  }

  requestSingleInstanceLock(): boolean {
    return true;
  }

  hasSingleInstanceLock(): boolean {
    return true;
  }

  releaseSingleInstanceLock(): void {
    // one copy per data folder is not enforced in this proof of concept
  }

  setAppUserModelId(): void {}

  setLoginItemSettings(): void {}

  getLoginItemSettings(): { openAtLogin: boolean; wasOpenedAtLogin: boolean } {
    return { openAtLogin: false, wasOpenedAtLogin: false };
  }

  focus(): void {}

  relaunch(): void {}

  setAboutPanelOptions(): void {}

  /** Electron's order: before-quit (preventable), will-quit, then exit. */
  quit(): void {
    if (this.quitting) return;
    const e = preventable();
    this.emit('before-quit', e);
    if (e.defaultPrevented) return;
    this.quitting = true;
    this.emit('will-quit', preventable());
    this.exit(0);
  }

  exit(code = 0): void {
    this.quitting = true;
    invoke('quit', { code }).catch(() => undefined);
  }
}

export const app = new App();

// --- screen ---------------------------------------------------------------------------------------------------------

class Screen extends EventEmitter {
  private displays: ShimDisplay[] = [];
  private monitors: Monitor[] = [];
  private polling = false;

  private list(): ShimDisplay[] {
    if (this.monitors.length === 0) this.set(boot().monitors, false);
    if (!this.polling) {
      this.polling = true;
      // Tauri has no display-change event: look every 2 s, as OverlayManager also does before each wheel.
      setInterval(() => {
        sysAsync<Monitor[]>('monitors').then((m) => this.set(m, true), () => undefined);
      }, 2000);
    }
    return this.displays;
  }

  private set(next: Monitor[], notify: boolean): void {
    if (this.monitors.length > 0 && sameMonitors(this.monitors, next)) return;
    const before = new Set(this.displays.map((d) => d.id));
    this.monitors = next;
    this.displays = toDisplays(next);
    if (!notify) return;
    const now = new Set(this.displays.map((d) => d.id));
    for (const d of this.displays) if (!before.has(d.id)) this.emit('display-added', preventable(), d);
    for (const id of before) if (!now.has(id)) this.emit('display-removed', preventable(), { id });
    for (const d of this.displays) if (before.has(d.id)) this.emit('display-metrics-changed', preventable(), d, ['bounds', 'workArea', 'scaleFactor']);
  }

  getAllDisplays(): ShimDisplay[] {
    return this.list();
  }

  getPrimaryDisplay(): ShimDisplay {
    const list = this.list();
    const d = list.find((x) => x.primary) ?? list[0];
    if (!d) throw new Error('no displays');
    return d;
  }

  getDisplayNearestPoint(p: { x: number; y: number }): ShimDisplay {
    const list = this.list();
    const dist = (d: ShimDisplay): number => {
      const dx = Math.max(d.bounds.x - p.x, 0, p.x - (d.bounds.x + d.bounds.width));
      const dy = Math.max(d.bounds.y - p.y, 0, p.y - (d.bounds.y + d.bounds.height));
      return dx * dx + dy * dy;
    };
    return list.reduce((a, b) => (dist(b) < dist(a) ? b : a), this.getPrimaryDisplay());
  }

  getDisplayMatching(r: Rect): ShimDisplay {
    return this.getDisplayNearestPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  }

  getCursorScreenPoint(): { x: number; y: number } {
    const p = physToDip(sysSync<{ x: number; y: number }>('cursor'), this.list());
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  dipToScreenPoint(p: { x: number; y: number }): { x: number; y: number } {
    const r = dipToPhys({ ...p, width: 0, height: 0 }, this.list());
    return { x: Math.round(r.x), y: Math.round(r.y) };
  }

  screenToDipPoint(p: { x: number; y: number }): { x: number; y: number } {
    return physToDip(p, this.list());
  }

  dipToScreenRect(_win: unknown, r: Rect): Rect {
    return dipToPhys(r, this.list());
  }

  screenToDipRect(_win: unknown, r: Rect): Rect {
    const p = physToDip(r, this.list());
    const d = this.getDisplayNearestPoint(p);
    return { x: p.x, y: p.y, width: r.width / d.scaleFactor, height: r.height / d.scaleFactor };
  }
}

export const screen = new Screen();

// --- windows --------------------------------------------------------------------------------------------------------

interface WindowOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  title?: string;
  show?: boolean;
  frame?: boolean;
  transparent?: boolean;
  focusable?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  resizable?: boolean;
  webPreferences?: { preload?: string };
}

const windows = new Map<string, BrowserWindow>();
let windowSeq = 0;
let focused: BrowserWindow | null = null;

export class WebContents extends EventEmitter {
  readonly id: number;
  loaded = false;
  url = '';
  private cssSeq = 0;

  constructor(readonly owner: BrowserWindow) {
    super();
    this.id = owner.id;
  }

  /** Like Electron, a message to a page that hasn't loaded yet is lost. */
  send(channel: string, ...args: unknown[]): void {
    if (!this.loaded || this.owner.isDestroyed()) return;
    this.owner.queue('win_send', { label: this.owner.label, channel, args: encodeWire(args) });
  }

  isLoading(): boolean {
    return !this.loaded;
  }

  isDestroyed(): boolean {
    return this.owner.isDestroyed();
  }

  getURL(): string {
    return this.url;
  }

  setWindowOpenHandler(): void {
    // a Tauri page can't open windows of its own
  }

  insertCSS(): Promise<string> {
    return Promise.resolve(`css${++this.cssSeq}`);
  }

  removeInsertedCSS(): Promise<void> {
    return Promise.resolve();
  }

  executeJavaScript(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  focus(): void {
    this.owner.focus();
  }

  setBackgroundThrottling(): void {}

  setAudioMuted(): void {}

  openDevTools(): void {}

  reload(): void {}
}

export class BrowserWindow extends EventEmitter {
  readonly id = ++windowSeq;
  readonly label = `w${this.id}`;
  readonly webContents: WebContents;
  private destroyed = false;
  private visible = false;
  private shownOnce = false;
  private bounds: Rect;
  private readonly placed: boolean;
  /** Tauri commands for this window made before it existed, run in order once it does. */
  private chain: Promise<void>;
  private open: () => void = () => undefined;
  private created = false;
  private waiting = 0;

  static getAllWindows(): BrowserWindow[] {
    return [...windows.values()];
  }

  static fromWebContents(wc: WebContents): BrowserWindow | null {
    return windows.get(wc.owner.label) ?? null;
  }

  static getFocusedWindow(): BrowserWindow | null {
    return focused && !focused.destroyed ? focused : null;
  }

  constructor(private readonly opts: WindowOptions = {}) {
    super();
    this.webContents = new WebContents(this);
    this.placed = opts.x !== undefined && opts.y !== undefined;
    const width = opts.width ?? 800;
    const height = opts.height ?? 600;
    if (this.placed) this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width, height };
    else {
      const wa = screen.getPrimaryDisplay().workArea;
      this.bounds = { x: wa.x + (wa.width - width) / 2, y: wa.y + (wa.height - height) / 2, width, height };
    }
    this.chain = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    windows.set(this.label, this);
  }

  /** The Tauri window is made here, since Tauri needs the page when it makes one. */
  loadURL(url: string): Promise<void> {
    const m = APP_PAGE.exec(url);
    if (!m) return Promise.reject(new Error(`not an app page: ${url}`));
    this.webContents.url = url;
    const page = m[1] + (m[2] ?? '');
    const preload = this.opts.webPreferences?.preload?.replace(/\\/g, '/').split('/').pop()?.replace(/\.js$/, '') ?? null;
    const p = this.placed ? dipToPhys(this.bounds, screen.getAllDisplays()) : null;
    const created = invoke('win_create', {
      opts: {
        label: this.label, url: page, title: this.opts.title ?? 'lolPing', physical: p !== null,
        x: p?.x ?? 0, y: p?.y ?? 0, width: p?.width ?? this.bounds.width, height: p?.height ?? this.bounds.height,
        minWidth: this.opts.minWidth ?? null, minHeight: this.opts.minHeight ?? null,
        decorations: this.opts.frame !== false && !this.opts.transparent, transparent: !!this.opts.transparent,
        focusable: this.opts.focusable !== false, alwaysOnTop: !!this.opts.alwaysOnTop, skipTaskbar: !!this.opts.skipTaskbar,
        resizable: this.opts.resizable !== false, preload,
      },
    });
    const opened = (): void => {
      this.created = true;
      this.open();
    };
    created.then(opened, (e: unknown) => {
      log(`win_create ${this.label} ${page}: ${String(e)}`);
      opened();
    });
    if (this.opts.show !== false) created.then(() => this.show(), () => undefined); // Electron shows a window unless told not to
    return created;
  }

  loadFile(file: string): Promise<void> {
    return this.loadURL(`lolping://app/${file.replace(/\\/g, '/').split('/renderer/').pop() ?? file}`);
  }

  /**
   * Once the window exists and nothing is waiting, a call goes straight out: the shell runs these commands in the order
   * they arrive, so waiting for each answer would only add a round trip per call.
   */
  queue(cmd: string, args: Record<string, unknown>): void {
    const fail = (e: unknown): void => log(`${cmd} ${this.label}: ${String(e)}`);
    if (this.created && this.waiting === 0) {
      invoke(cmd, args).catch(fail);
      return;
    }
    this.waiting++;
    this.chain = this.chain
      .then(() => invoke(cmd, args))
      .catch(fail)
      .finally(() => {
        this.waiting--;
      });
  }

  private op(op: string, args: Record<string, unknown> = {}): void {
    if (this.destroyed) return;
    this.queue('win_op', { label: this.label, op, args });
  }

  /** A page that said it is ready (PAGE_READY from its preload). */
  pageReady(): void {
    this.webContents.loaded = true;
    this.webContents.emit('dom-ready');
    this.webContents.emit('did-finish-load');
    if (!this.shownOnce) {
      this.shownOnce = true;
      this.emit('ready-to-show');
    }
  }

  /** The shell's window events. */
  shellEvent(ev: string): void {
    if (ev === 'close') {
      const e = preventable();
      this.emit('close', e);
      if (!e.defaultPrevented) this.destroy();
    } else if (ev === 'closed') {
      this.destroyed = true;
      windows.delete(this.label);
      if (focused === this) focused = null;
      this.emit('closed');
    } else if (ev === 'focus') {
      focused = this;
      this.emit('focus');
    } else if (ev === 'blur') {
      if (focused === this) focused = null;
      this.emit('blur');
    }
  }

  show(): void {
    this.visible = true;
    this.op('show');
    this.op('focus');
    this.emit('show');
  }

  showInactive(): void {
    this.visible = true;
    this.op('show');
    this.emit('show');
  }

  hide(): void {
    this.visible = false;
    this.op('hide');
    this.emit('hide');
  }

  focus(): void {
    this.op('focus');
  }

  blur(): void {}

  close(): void {
    if (!this.destroyed) this.shellEvent('close');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.op('destroy');
    this.destroyed = true;
    windows.delete(this.label);
    if (!this.created) this.emit('closed');
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed;
  }

  isFocused(): boolean {
    return focused === this;
  }

  isMinimized(): boolean {
    if (!this.created || this.destroyed) return false;
    try {
      return sysSync<{ minimized: boolean } | null>('win.state', { label: this.label })?.minimized ?? false;
    } catch {
      return false;
    }
  }

  isMaximized(): boolean {
    return false;
  }

  minimize(): void {
    this.op('minimize');
  }

  restore(): void {
    this.op('restore');
  }

  setBounds(r: Partial<Rect>): void {
    this.bounds = { ...this.bounds, ...r };
    this.op('bounds', { ...dipToPhys(this.bounds, screen.getAllDisplays()) });
  }

  getBounds(): Rect {
    return { ...this.bounds };
  }

  getContentBounds(): Rect {
    return this.getBounds();
  }

  setSize(width: number, height: number): void {
    this.setBounds({ width, height });
  }

  getSize(): [number, number] {
    return [this.bounds.width, this.bounds.height];
  }

  setPosition(x: number, y: number): void {
    this.setBounds({ x, y });
  }

  getPosition(): [number, number] {
    return [this.bounds.x, this.bounds.y];
  }

  center(): void {}

  setTitle(title: string): void {
    this.op('title', { title });
  }

  setIgnoreMouseEvents(on: boolean): void {
    this.op('ignoreMouse', { on });
  }

  /** Electron's level argument has no Tauri counterpart: Windows has one topmost band. */
  setAlwaysOnTop(on: boolean): void {
    this.op('topmost', { on });
  }

  setContentProtection(on: boolean): void {
    this.op('contentProtection', { on });
  }

  setVisibleOnAllWorkspaces(on: boolean): void {
    this.op('allWorkspaces', { on });
  }

  // Window chrome Electron draws (Mica, the caption overlay, macOS vibrancy) or that Tauri sets at creation.
  setHiddenInMissionControl(): void {}
  setSkipTaskbar(): void {}
  setFocusable(): void {}
  setOpacity(): void {}
  setBackgroundColor(): void {}
  setBackgroundMaterial(): void {}
  setTitleBarOverlay(): void {}
  setVibrancy(): void {}
  setMenu(): void {}
  removeMenu(): void {}
  setMenuBarVisibility(): void {}
  setAutoHideMenuBar(): void {}
  setResizable(): void {}
  setMinimumSize(): void {}
  setShape(): void {}
  moveTop(): void {}
  flashFrame(): void {}
}

onShell('win', ((label: string, ev: string) => windows.get(label)?.shellEvent(ev)) as never);

// --- IPC ------------------------------------------------------------------------------------------------------------

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class IpcMain extends EventEmitter {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, fn: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, fn);
  }

  handleOnce(channel: string, fn: Handler): void {
    this.handle(channel, (e, ...a) => {
      this.removeHandler(channel);
      return fn(e, ...a);
    });
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

export const ipcMain = new IpcMain();

const argsOf = (raw: unknown): unknown[] => {
  const v = decodeWire(raw);
  return Array.isArray(v) ? v : [];
};

onShell('ipc', ((label: string, channel: string, raw: unknown) => {
  const win = windows.get(label);
  if (!win) return;
  if (channel === PAGE_READY) return win.pageReady();
  const event = { sender: win.webContents, senderFrame: null, reply: (ch: string, ...a: unknown[]) => win.webContents.send(ch, ...a) };
  ipcMain.emit(channel, event, ...argsOf(raw));
}) as never);

onShell('invoke', ((id: number, label: string, channel: string, raw: unknown) => {
  const reply = (ok: boolean, value: unknown, error: string | null): void => {
    invoke('ipc_reply', { id, ok, value: value ?? null, error }).catch(() => undefined);
  };
  const fn = ipcMain.handlers.get(channel);
  if (!fn) return reply(false, null, `No handler registered for '${channel}'`);
  const win = windows.get(label);
  Promise.resolve()
    .then(() => fn({ sender: win?.webContents, senderFrame: null }, ...argsOf(raw)))
    .then((v) => reply(true, encodeWire(v), null), (e: unknown) => reply(false, null, e instanceof Error ? e.message : String(e)));
}) as never);

// --- menus and the tray ---------------------------------------------------------------------------------------------

interface ItemOptions {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  role?: string;
  click?: (item: MenuItem, win: undefined, event: Record<string, unknown>) => void;
  submenu?: ItemOptions[] | Menu;
}

let itemSeq = 0;
const liveItems = new Map<string, MenuItem>();

export class MenuItem {
  readonly id: string;
  label: string;
  type: NonNullable<ItemOptions['type']>;
  checked: boolean;
  enabled: boolean;
  visible: boolean;
  readonly click?: ItemOptions['click'];
  readonly submenu?: Menu;

  constructor(o: ItemOptions) {
    this.id = `m${++itemSeq}`;
    this.label = o.label ?? o.role ?? '';
    this.type = o.type ?? (o.submenu ? 'submenu' : 'normal');
    this.checked = !!o.checked;
    this.enabled = o.enabled !== false;
    this.visible = o.visible !== false;
    this.click = o.click;
    if (o.submenu) this.submenu = o.submenu instanceof Menu ? o.submenu : Menu.buildFromTemplate(o.submenu);
  }
}

interface MenuSpec {
  id: string;
  kind: 'normal' | 'checkbox' | 'separator' | 'submenu';
  label: string;
  enabled: boolean;
  checked: boolean;
  items: MenuSpec[];
}

export class Menu {
  readonly items: MenuItem[] = [];

  static buildFromTemplate(template: ItemOptions[]): Menu {
    const m = new Menu();
    for (const o of template) m.append(new MenuItem(o));
    return m;
  }

  static setApplicationMenu(): void {}

  static getApplicationMenu(): null {
    return null;
  }

  append(item: MenuItem): void {
    this.items.push(item);
  }

  popup(): void {}

  closePopup(): void {}

  /** The menu as the shell builds it; the ids find the items again when one is clicked. */
  spec(): MenuSpec[] {
    return this.items.filter((i) => i.visible).map((i) => {
      liveItems.set(i.id, i);
      const kind = i.type === 'separator' ? 'separator' : i.type === 'checkbox' || i.type === 'radio' ? 'checkbox' : i.submenu ? 'submenu' : 'normal';
      return { id: i.id, kind, label: i.label, enabled: i.enabled, checked: i.checked, items: i.submenu?.spec() ?? [] };
    });
  }
}

onShell('menu', ((id: string) => {
  const item = liveItems.get(id);
  if (!item) return;
  if (item.type === 'checkbox') item.checked = !item.checked; // Electron flips it before the click handler runs
  if (item.type === 'radio') item.checked = true;
  item.click?.(item, undefined, {});
}) as never);

let liveTray: Tray | null = null;

const trayIcon = (img: NativeImage): { rgba: string; width: number; height: number } | null => {
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  let s = '';
  const rgba = img.toRgba();
  for (let i = 0; i < rgba.length; i += 0x8000) s += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
  return { rgba: btoa(s), width, height };
};

export class Tray extends EventEmitter {
  private destroyed = false;

  constructor(image: NativeImage) {
    super();
    liveTray = this;
    this.setImage(image);
  }

  private set(args: Record<string, unknown>): void {
    if (this.destroyed) return;
    invoke('tray_set', { icon: null, tooltip: null, menu: null, ...args }).catch((e: unknown) => log(`tray_set: ${String(e)}`));
  }

  setImage(image: NativeImage): void {
    this.set({ icon: trayIcon(image) });
  }

  setToolTip(tooltip: string): void {
    this.set({ tooltip });
  }

  setContextMenu(menu: Menu | null): void {
    this.set({ menu: menu ? menu.spec() : [] });
  }

  setTitle(): void {}

  popUpContextMenu(): void {}

  getBounds(): Rect {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (liveTray === this) liveTray = null;
    invoke('tray_destroy').catch(() => undefined);
  }
}

onShell('tray', ((kind: string) => liveTray?.emit(kind, preventable())) as never);

// --- the rest of the API the app touches ----------------------------------------------------------------------------

export const clipboard = {
  readText: (): string => sysSync<string>('clipboard.read'),
  writeText: (text: string): void => void sysSync('clipboard.write', { text }),
  /** Rich clipboard items are the teammate's; text is kept. */
  write(items: unknown[]): Promise<void> {
    const text = items.map((i) => (i as { text?: string }).text).find((t) => typeof t === 'string');
    if (text !== undefined) clipboard.writeText(text);
    return Promise.resolve();
  },
};

export class ClipboardItem {
  constructor(readonly items: Record<string, unknown>) {}
}

export const shell = {
  openExternal: (url: string): Promise<void> => sysAsync('open', { target: url }),
  openPath: (path: string): Promise<string> => sysAsync('open', { target: path }).then(() => '', (e: Error) => e.message),
  showItemInFolder: (path: string): void => void sysAsync('reveal', { path }).catch(() => undefined),
  beep: (): void => undefined,
};

export const dialog = {
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> => Promise.resolve({ canceled: true, filePaths: [] }),
  showMessageBox: (): Promise<{ response: number; checkboxChecked: boolean }> => Promise.resolve({ response: 0, checkboxChecked: false }),
  showErrorBox: (title: string, body: string): void => log(`error box: ${title}: ${body}`),
};

/** The settings page checks that a hotkey is free this way; the helper owns the keys, so anything is free here. */
export const globalShortcut = {
  register: (): boolean => true,
  unregister: (): void => undefined,
  unregisterAll: (): void => undefined,
  isRegistered: (): boolean => false,
};

class NativeTheme extends EventEmitter {
  themeSource = 'system';

  constructor() {
    super();
    if (typeof matchMedia !== 'undefined') matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.emit('updated'));
  }

  get shouldUseDarkColors(): boolean {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  }
}

export const nativeTheme = new NativeTheme();
export const powerMonitor = new EventEmitter();

/** No OS secret store in this proof of concept: the teammate reports that keys can't be kept. */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): never => {
    throw new Error('Encryption is not available');
  },
  decryptString: (): never => {
    throw new Error('Decryption is not available');
  },
};

export const systemPreferences = {
  isTrustedAccessibilityClient: (): boolean => true,
  getMediaAccessStatus: (): string => 'granted',
  askForMediaAccess: (): Promise<boolean> => Promise.resolve(true),
};

/** Tauri serves the app's pages itself (lolping://app becomes its own scheme), so the app's handler isn't needed. */
export const protocol = {
  registerSchemesAsPrivileged: (): void => undefined,
  handle: (): void => undefined,
  unhandle: (): void => undefined,
};

export const net = { fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => fetch(input, init) };

export const session = { defaultSession: { setPermissionRequestHandler: (): void => undefined } };

export default {
  app, screen, BrowserWindow, ipcMain, Menu, MenuItem, Tray, nativeImage, clipboard, ClipboardItem, shell, dialog,
  globalShortcut, nativeTheme, powerMonitor, safeStorage, systemPreferences, protocol, net, session,
};
