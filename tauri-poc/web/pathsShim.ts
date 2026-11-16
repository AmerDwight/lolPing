// What src/main/overlayManager.ts uses of src/main/paths.ts. The build points its `./paths` import here.
import type { Platform } from '../../src/shared/platform';
import type { BrowserWindow } from './electronShim';

export type Page = 'overlay' | 'settings' | 'text' | 'panel' | 'teammate';

// Set from the shell before any main-process code runs; the bundle keeps imports live, as ES modules do.
export let IS_MAC = false;
export let IS_LINUX = false;

export function setPlatform(p: Platform): void {
  IS_MAC = p === 'mac';
  IS_LINUX = p === 'linux';
}

/** The preload is the overlay shim the shell injects, so there is no file to name. */
export const preloadPath = (_name: Page): string => '';

export function loadPage(win: BrowserWindow, page: Page, hash = ''): Promise<void> {
  return win.loadURL(`lolping://app/${page}/index.html${hash ? `#${hash}` : ''}`);
}
