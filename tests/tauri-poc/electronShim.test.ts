import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_READY } from '../../tauri-poc/web/channels';
import { toDisplays } from '../../tauri-poc/web/displays';
import { BrowserWindow, dispatchIpc, ipcMain, screen } from '../../tauri-poc/web/electronShim';

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

let calls: Call[];
let finishCreate: () => void;

/** Resolves once every queued command has run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  calls = [];
  let created: Promise<void> = Promise.resolve();
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
        calls.push({ cmd, args });
        if (cmd === 'win_create') {
          created = new Promise<void>((resolve) => {
            finishCreate = resolve;
          });
          return created;
        }
        return Promise.resolve();
      },
    },
  });
  screen.update(toDisplays([{ id: 1, x: 0, y: 0, width: 2560, height: 1440, scale: 1.25, primary: true }]));
});

afterEach(() => vi.unstubAllGlobals());

describe('BrowserWindow', () => {
  it('makes the window at the physical size of its DIP bounds when the page loads', async () => {
    const win = new BrowserWindow({ x: 0, y: 0, width: 2048, height: 1151, transparent: true, focusable: false });
    void win.loadURL('lolping://app/overlay/index.html');
    const create = calls.find((c) => c.cmd === 'win_create');
    expect(create?.args?.opts).toMatchObject({
      url: 'overlay/index.html', x: 0, y: 0, width: 2560, height: 1439, transparent: true, focusable: false, overlay: true,
    });
  });

  it('runs the calls made before the window exists after it does, in order', async () => {
    const win = new BrowserWindow({ width: 100, height: 100 });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true);
    void win.loadURL('lolping://app/overlay/index.html');
    await settle();
    expect(calls.map((c) => c.cmd)).toEqual(['win_create']);
    finishCreate();
    win.showInactive();
    await settle();
    expect(calls.slice(1).map((c) => c.args?.op)).toEqual(['ignoreMouse', 'topmost', 'show']);
  });

  it('drops messages to a page that has not loaded, like Electron', async () => {
    const win = new BrowserWindow();
    void win.loadURL('lolping://app/overlay/index.html');
    finishCreate();
    win.webContents.send('wheel:cancel', null);
    await settle();
    expect(calls.some((c) => c.cmd === 'win_send')).toBe(false);
  });

  it('reports the page ready, then delivers its messages to ipcMain with the sender', async () => {
    const win = new BrowserWindow();
    const loaded = vi.fn();
    win.webContents.on('did-finish-load', loaded);
    void win.loadURL('lolping://app/overlay/index.html');
    finishCreate();
    dispatchIpc(win.label, PAGE_READY, null);
    expect(loaded).toHaveBeenCalledOnce();
    expect(win.webContents.isLoading()).toBe(false);

    const got = vi.fn();
    ipcMain.on('overlay:idle', got);
    dispatchIpc(win.label, 'overlay:idle', true);
    expect(got).toHaveBeenCalledWith({ sender: win.webContents }, true);
    expect(BrowserWindow.fromWebContents(win.webContents)).toBe(win);

    win.webContents.send('wheel:cancel', null);
    await settle();
    expect(calls.at(-1)).toEqual({ cmd: 'win_send', args: { label: win.label, channel: 'wheel:cancel', payload: null } });
  });

  it('stops sending window calls once destroyed', async () => {
    const win = new BrowserWindow();
    void win.loadURL('lolping://app/overlay/index.html');
    finishCreate();
    win.destroy();
    win.hide();
    await settle();
    expect(calls.filter((c) => c.cmd === 'win_op').map((c) => c.args?.op)).toEqual(['destroy']);
    expect(win.isDestroyed()).toBe(true);
    expect(BrowserWindow.fromWebContents(win.webContents)).toBeNull();
  });
});
