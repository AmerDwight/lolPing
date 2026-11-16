// node:fs and node:fs/promises for main-process code in a page: the shell's file calls, blocking ones through a sync XHR.
import { sysAsync, sysSync } from '../sys';
import { Buffer } from './buffer';

type Enc = 'utf8' | 'utf-8' | 'base64' | 'hex' | 'latin1';
type ReadOpts = Enc | { encoding?: Enc | null; flag?: string } | null | undefined;
type WriteOpts = Enc | { encoding?: Enc | null; flag?: string; mode?: number } | null | undefined;
type Data = string | Uint8Array;

const encodingOf = (o: ReadOpts | WriteOpts): Enc | undefined =>
  typeof o === 'string' ? o : (o?.encoding ?? undefined);

const toB64 = (data: Data, o?: WriteOpts): string =>
  (typeof data === 'string' ? Buffer.from(data, encodingOf(o) ?? 'utf8') : Buffer.view(data)).toString('base64');

const fromB64 = (b64: string, o?: ReadOpts): Buffer | string => {
  const b = Buffer.from(b64, 'base64');
  const enc = encodingOf(o);
  return enc ? b.toString(enc) : b;
};

const str = (p: string | URL): string => (typeof p === 'string' ? p : decodeURIComponent(p.pathname));

interface RawStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export class Stats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtime: Date;

  constructor(private readonly raw: RawStat) {
    this.size = raw.size;
    this.mtimeMs = raw.mtimeMs;
    this.mtime = new Date(raw.mtimeMs);
  }

  isFile(): boolean {
    return this.raw.isFile;
  }

  isDirectory(): boolean {
    return this.raw.isDirectory;
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

interface RawEntry {
  name: string;
  isDirectory: boolean;
}

export class Dirent {
  constructor(readonly name: string, private readonly dir: boolean) {}

  isFile(): boolean {
    return !this.dir;
  }

  isDirectory(): boolean {
    return this.dir;
  }
}

type DirOpts = { withFileTypes?: boolean; encoding?: string } | string | undefined;
const entries = (list: RawEntry[], o: DirOpts): string[] | Dirent[] =>
  typeof o === 'object' && o.withFileTypes ? list.map((e) => new Dirent(e.name, e.isDirectory)) : list.map((e) => e.name);

// --- blocking ------------------------------------------------------------------------------------------------------

export function existsSync(p: string | URL): boolean {
  try {
    return sysSync<boolean>('fs.exists', { path: str(p) });
  } catch {
    return false;
  }
}

export function readFileSync(p: string | URL, o?: ReadOpts): Buffer | string {
  return fromB64(sysSync<string>('fs.readFile', { path: str(p) }), o);
}

export function writeFileSync(p: string | URL, data: Data, o?: WriteOpts): void {
  sysSync('fs.writeFile', { path: str(p), data: toB64(data, o) });
}

export function appendFileSync(p: string | URL, data: Data, o?: WriteOpts): void {
  sysSync('fs.writeFile', { path: str(p), data: toB64(data, o), append: true });
}

export function mkdirSync(p: string | URL, o?: { recursive?: boolean } | number): void {
  sysSync('fs.mkdir', { path: str(p), recursive: typeof o === 'object' && !!o.recursive });
}

export function readdirSync(p: string | URL, o?: DirOpts): string[] | Dirent[] {
  return entries(sysSync<RawEntry[]>('fs.readdir', { path: str(p) }), o);
}

export function rmSync(p: string | URL, o?: { recursive?: boolean; force?: boolean }): void {
  sysSync('fs.rm', { path: str(p), recursive: !!o?.recursive, force: !!o?.force });
}

export function unlinkSync(p: string | URL): void {
  sysSync('fs.rm', { path: str(p) });
}

export function statSync(p: string | URL, o?: { throwIfNoEntry?: boolean }): Stats | undefined {
  try {
    return new Stats(sysSync<RawStat>('fs.stat', { path: str(p) }));
  } catch (e) {
    if (o?.throwIfNoEntry === false && (e as { code?: string }).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function accessSync(p: string | URL): void {
  sysSync('fs.stat', { path: str(p) });
}

export function copyFileSync(from: string | URL, to: string | URL): void {
  sysSync('fs.copyFile', { path: str(from), to: str(to) });
}

export function renameSync(from: string | URL, to: string | URL): void {
  sysSync('fs.rename', { path: str(from), to: str(to) });
}

// --- promises ------------------------------------------------------------------------------------------------------

export const promises = {
  async readFile(p: string | URL, o?: ReadOpts): Promise<Buffer | string> {
    return fromB64(await sysAsync<string>('fs.readFile', { path: str(p) }), o);
  },
  async writeFile(p: string | URL, data: Data, o?: WriteOpts): Promise<void> {
    await sysAsync('fs.writeFile', { path: str(p), data: toB64(data, o) });
  },
  async appendFile(p: string | URL, data: Data, o?: WriteOpts): Promise<void> {
    await sysAsync('fs.writeFile', { path: str(p), data: toB64(data, o), append: true });
  },
  async mkdir(p: string | URL, o?: { recursive?: boolean } | number): Promise<undefined> {
    await sysAsync('fs.mkdir', { path: str(p), recursive: typeof o === 'object' && !!o.recursive });
    return undefined;
  },
  async readdir(p: string | URL, o?: DirOpts): Promise<string[] | Dirent[]> {
    return entries(await sysAsync<RawEntry[]>('fs.readdir', { path: str(p) }), o);
  },
  async rm(p: string | URL, o?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await sysAsync('fs.rm', { path: str(p), recursive: !!o?.recursive, force: !!o?.force });
  },
  async unlink(p: string | URL): Promise<void> {
    await sysAsync('fs.rm', { path: str(p) });
  },
  async stat(p: string | URL): Promise<Stats> {
    return new Stats(await sysAsync<RawStat>('fs.stat', { path: str(p) }));
  },
  async rename(from: string | URL, to: string | URL): Promise<void> {
    await sysAsync('fs.rename', { path: str(from), to: str(to) });
  },
  async copyFile(from: string | URL, to: string | URL): Promise<void> {
    await sysAsync('fs.copyFile', { path: str(from), to: str(to) });
  },
  async access(p: string | URL): Promise<void> {
    await sysAsync('fs.stat', { path: str(p) });
  },
  async lstat(p: string | URL): Promise<Stats> {
    return promises.stat(p);
  },
  /** File modes are a POSIX matter the teammate's pipe uses; nothing to do here. */
  async chmod(): Promise<void> {},
  /** File handles are only the macOS updater's. */
  async open(): Promise<never> {
    throw Object.assign(new Error('file handles are not available in lolPing on Tauri'), { code: 'ENOSYS' });
  },
};

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export default {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync, unlinkSync, statSync, accessSync,
  copyFileSync, renameSync, promises, constants, Stats, Dirent,
};
