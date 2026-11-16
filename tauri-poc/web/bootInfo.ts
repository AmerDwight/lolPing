// What the shell says about this machine at start-up (its `info` call), read once by boot.ts before any app code.
import type { Monitor } from './displays';

export interface BootInfo {
  /** As Node's process.platform names it. */
  platform: 'win32' | 'darwin' | 'linux';
  arch: string;
  pid: number;
  exe: string;
  exeDir: string;
  args: string[];
  env: Record<string, string>;
  /** Where the hook helper was written: process.resourcesPath. */
  resources: string;
  /** Electron's appData: %APPDATA% on Windows, ~/.config on Linux. */
  appData: string;
  home: string;
  temp: string;
  downloads: string;
  version: string;
  monitors: Monitor[];
}

let info: BootInfo | null = null;

export function setBoot(i: BootInfo): void {
  info = i;
}

export function boot(): BootInfo {
  if (!info) throw new Error('boot.ts has not run');
  return info;
}
