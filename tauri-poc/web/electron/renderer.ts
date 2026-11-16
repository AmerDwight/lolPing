// Electron's renderer-side API (contextBridge, ipcRenderer) on the Tauri shell, for src/preload as it is. Each preload
// is built with `electron` pointing here and runs before its page's own scripts.
import { PAGE_READY } from '../channels';
import { invoke } from '../tauri';
import { decodeWire, encodeWire } from '../wire';

type Listener = (event: unknown, ...args: unknown[]) => void;

declare global {
  interface Window {
    /** The shell's webContents.send lands here. */
    __lolpingIpc?: { dispatch(channel: string, args: unknown): void };
  }
}

const listeners = new Map<string, Listener[]>();

interface IpcRenderer {
  on(channel: string, fn: Listener): IpcRenderer;
  once(channel: string, fn: Listener): IpcRenderer;
  removeListener(channel: string, fn: Listener): IpcRenderer;
  off(channel: string, fn: Listener): IpcRenderer;
  removeAllListeners(channel?: string): IpcRenderer;
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sendSync(): never;
}

export const ipcRenderer: IpcRenderer = {
  on(channel: string, fn: Listener): IpcRenderer {
    listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
    return ipcRenderer;
  },
  once(channel: string, fn: Listener): IpcRenderer {
    const once: Listener = (e, ...a) => {
      ipcRenderer.removeListener(channel, once);
      fn(e, ...a);
    };
    return ipcRenderer.on(channel, once);
  },
  removeListener(channel: string, fn: Listener): IpcRenderer {
    listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== fn));
    return ipcRenderer;
  },
  off(channel: string, fn: Listener): IpcRenderer {
    return ipcRenderer.removeListener(channel, fn);
  },
  removeAllListeners(channel?: string): IpcRenderer {
    if (channel === undefined) listeners.clear();
    else listeners.delete(channel);
    return ipcRenderer;
  },
  send(channel: string, ...args: unknown[]): void {
    invoke('ipc_send', { channel, args: encodeWire(args) }).catch(() => undefined);
  },
  /** Rejects as Electron does, with the main side's error message inside. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return invoke<unknown>('ipc_invoke', { channel, args: encodeWire(args) }).then(decodeWire, (e: unknown) => {
      throw new Error(`Error invoking remote method '${channel}': Error: ${String(e)}`);
    });
  },
  sendSync(): never {
    throw new Error('sendSync is not available in lolPing on Tauri');
  },
};

export const contextBridge = {
  exposeInMainWorld(name: string, api: unknown): void {
    Object.defineProperty(window, name, { value: Object.freeze(api), configurable: false, enumerable: true });
  },
};

export const webUtils = { getPathForFile: (): string => '' };

window.__lolpingIpc = {
  dispatch(channel, raw) {
    const args = decodeWire(raw);
    const event = { sender: ipcRenderer };
    for (const fn of listeners.get(channel) ?? []) fn(event, ...(Array.isArray(args) ? args : []));
  },
};

// Module scripts have run by DOMContentLoaded, so the page's listeners are in place: Electron's did-finish-load.
document.addEventListener('DOMContentLoaded', () => ipcRenderer.send(PAGE_READY));

export default { ipcRenderer, contextBridge, webUtils };
