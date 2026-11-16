// What src/main/overlayManager.ts uses of Electron, built on the Tauri shell. The build points `electron` here.
import type { Rect } from '../../src/main/coords';
import { PAGE_READY } from './channels';
import { dipToPhys, type ShimDisplay } from './displays';
import { EventEmitter } from './events';
import { invoke } from './tauri';

const APP_PAGE = /^lolping:\/\/app\/(.+)$/;

interface WindowOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  transparent?: boolean;
  focusable?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
}

const windows = new Map<string, BrowserWindow>();
let seq = 0;

const log = (msg: string): void => {
  invoke('log', { msg }).catch(() => undefined);
};

export class WebContents extends EventEmitter {
  loaded = false;

  constructor(readonly owner: BrowserWindow) {
    super();
  }

  isLoading(): boolean {
    return !this.loaded;
  }

  /** Like Electron, a message to a page that hasn't loaded yet is lost. */
  send(channel: string, payload: unknown): void {
    if (!this.loaded) return;
    this.owner.queue('win_send', { label: this.owner.label, channel, payload: payload ?? null });
  }
}

class Screen extends EventEmitter {
  private displays: ShimDisplay[] = [];

  getAllDisplays(): ShimDisplay[] {
    return this.displays;
  }

  getPrimaryDisplay(): ShimDisplay {
    const d = this.displays.find((x) => x.primary) ?? this.displays[0];
    if (!d) throw new Error('no displays yet');
    return d;
  }

  dipToScreenRect(_win: unknown, rect: Rect): Rect {
    return dipToPhys(rect, this.displays);
  }

  /** New monitors from the shell. A change after the first list is Electron's display-metrics-changed. */
  update(list: ShimDisplay[]): void {
    const first = this.displays.length === 0;
    this.displays = list;
    if (!first) this.emit('display-metrics-changed');
  }
}

export const screen = new Screen();
export const ipcMain = new EventEmitter();

export class BrowserWindow extends EventEmitter {
  readonly label = `w${++seq}`;
  readonly webContents = new WebContents(this);
  private destroyed = false;
  private visible = false;
  private bounds: Rect;
  /** Tauri commands for this window made before it existed, run in order once it does. */
  private chain: Promise<void>;
  private open: () => void = () => undefined;
  private created = false;
  private waiting = 0;

  static fromWebContents(wc: WebContents): BrowserWindow | null {
    return windows.has(wc.owner.label) ? wc.owner : null;
  }

  constructor(private readonly opts: WindowOptions = {}) {
    super();
    this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 800, height: opts.height ?? 600 };
    this.chain = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    windows.set(this.label, this);
  }

  /** The Tauri window is made here, since Tauri needs the page when it makes one. */
  loadURL(url: string): Promise<void> {
    const page = APP_PAGE.exec(url)?.[1];
    if (!page) return Promise.reject(new Error(`not an app page: ${url}`));
    const p = dipToPhys(this.bounds, screen.getAllDisplays());
    const created = invoke('win_create', {
      opts: {
        label: this.label,
        url: page,
        x: Math.round(p.x),
        y: Math.round(p.y),
        width: Math.round(p.width),
        height: Math.round(p.height),
        transparent: this.opts.transparent ?? false,
        focusable: this.opts.focusable ?? true,
        alwaysOnTop: this.opts.alwaysOnTop ?? false,
        skipTaskbar: this.opts.skipTaskbar ?? false,
        overlay: page.startsWith('overlay/'),
      },
    });
    const opened = (): void => {
      this.created = true;
      this.open();
    };
    created.then(opened, (e: unknown) => {
      log(`win_create ${this.label}: ${String(e)}`);
      opened();
    });
    return created;
  }

  /**
   * Once the window exists and nothing is waiting, a call goes straight out: the shell runs these commands in the order
   * they arrive, so waiting for each answer would only add a round trip per call (the wheel opened 12 ms later).
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

  setHiddenInMissionControl(): void {
    // macOS only, and not part of this proof of concept.
  }

  showInactive(): void {
    this.visible = true;
    this.op('show', {});
  }

  show(): void {
    this.showInactive();
  }

  hide(): void {
    this.visible = false;
    this.op('hide', {});
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  setBounds(r: Rect): void {
    this.bounds = { ...r };
    this.op('bounds', { ...dipToPhys(r, screen.getAllDisplays()) });
  }

  getBounds(): Rect {
    return { ...this.bounds };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.op('destroy', {});
    this.destroyed = true;
    windows.delete(this.label);
  }

  private op(op: string, args: Record<string, unknown>): void {
    if (this.destroyed) return;
    this.queue('win_op', { label: this.label, op, args });
  }
}

/** A message from a page's preload stand-in, through the shell: ipcRenderer.send arriving at ipcMain. */
export function dispatchIpc(label: string, channel: string, payload: unknown): void {
  const win = windows.get(label);
  if (!win) return;
  if (channel === PAGE_READY) {
    log(`page ready in ${label}`);
    win.webContents.loaded = true;
    win.webContents.emit('did-finish-load');
    win.emit('ready-to-show');
    return;
  }
  ipcMain.emit(channel, { sender: win.webContents }, payload);
}
