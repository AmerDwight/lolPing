/** The part of Tauri's page bridge used here: commands defined in src-tauri/src/main.rs. */
interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** Calls a Tauri command. Tauri sets up its bridge before any page script, so it is there by the first call. */
export function invoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return Promise.reject(new Error(`not running in Tauri: ${cmd}`));
  return tauri.invoke(cmd, args) as Promise<T>;
}
