// window.__core: where the shell delivers to the core page (process output, UDP packets, window events, IPC from other
// pages, tray and menu clicks). Each stand-in registers the calls it handles.

type Handler = (...args: never[]) => void;

declare global {
  interface Window {
    __core?: Record<string, Handler>;
  }
}

const handlers: Record<string, Handler> = {};

export function onShell(name: string, fn: Handler): void {
  handlers[name] = fn;
}

if (typeof window !== 'undefined') window.__core = handlers;
