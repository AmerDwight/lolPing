// src/preload/overlay.ts on Tauri: the same `window.overlay`, carried by the shell instead of Electron's IPC.
// The shell runs this before the overlay page's own scripts.
import type { OverlayApi } from '../../src/preload/overlay';
import {
  OVERLAY_ASSETS, OVERLAY_CHANNELS, OVERLAY_EMOTED, OVERLAY_IDLE, OVERLAY_PINGED, OVERLAY_SHARE, type OverlayChannel, type OverlayEvents,
} from '../../src/shared/ipc';
import { PAGE_READY } from './channels';
import { invoke } from './tauri';

declare global {
  interface Window {
    overlay: OverlayApi;
    /** The shell's webContents.send lands here. */
    __lolpingOverlay?: { dispatch(channel: string, payload: unknown): void };
  }
}

const listeners = new Map<string, Array<(payload: unknown) => void>>();

const send = (channel: string, payload: unknown): void => {
  invoke('ipc_send', { channel, payload: payload ?? null }).catch(() => undefined);
};

const api: OverlayApi = {
  on<C extends OverlayChannel>(channel: C, cb: (payload: OverlayEvents[C]) => void): void {
    if (!OVERLAY_CHANNELS.includes(channel)) throw new Error(`unknown overlay channel: ${channel}`);
    listeners.set(channel, [...(listeners.get(channel) ?? []), (p) => cb(p as OverlayEvents[C])]);
  },
  reportMissingAssets(names) {
    send(OVERLAY_ASSETS, names);
  },
  reportPing(id, x, y) {
    send(OVERLAY_PINGED, { id, x, y });
  },
  reportEmote(ref, x, y) {
    send(OVERLAY_EMOTED, { ref, x, y });
  },
  reportShare(id, share) {
    send(OVERLAY_SHARE, { id, share: share ? Array.from(share) : null });
  },
  reportIdle(idle) {
    send(OVERLAY_IDLE, idle);
  },
};

window.overlay = api;
window.__lolpingOverlay = {
  dispatch(channel, payload) {
    for (const cb of listeners.get(channel) ?? []) cb(payload);
  },
};
// Module scripts have run by DOMContentLoaded, so the page's listeners are in place.
document.addEventListener('DOMContentLoaded', () => send(PAGE_READY, null));
