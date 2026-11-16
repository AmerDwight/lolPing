// The first module in the core page: Node's globals (process, Buffer, Node-style timers) from the shell's start-up info,
// before any of src/main runs.
import { setBoot, type BootInfo } from './bootInfo';
import { Buffer } from './node/buffer';
import { EventEmitter } from './node/events';
import { sysSync } from './sys';
import { invoke } from './tauri';

const info = sysSync<BootInfo>('info');
setBoot(info);

// What electron-builder's portable launcher sets: a portable lolPing keeps its data in a `data` folder beside the exe.
const env: Record<string, string> = { ...info.env, PORTABLE_EXECUTABLE_DIR: info.exeDir };

const started = performance.now();
const proc = Object.assign(new EventEmitter(), {
  platform: info.platform,
  arch: info.arch === 'x86_64' ? 'x64' : info.arch === 'aarch64' ? 'arm64' : info.arch,
  env,
  execPath: info.exe,
  resourcesPath: info.resources,
  argv: [info.exe, ...info.args],
  pid: info.pid,
  type: 'browser',
  version: 'v22.0.0',
  versions: { node: '22.0.0', electron: '44.0.0', chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '' },
  release: { name: 'node' },
  cwd: (): string => info.exeDir,
  chdir: (): void => undefined,
  exit: (code = 0): void => void invoke('quit', { code }).catch(() => undefined),
  nextTick: (fn: (...a: unknown[]) => void, ...a: unknown[]): void => queueMicrotask(() => fn(...a)),
  hrtime: Object.assign((prev?: [number, number]): [number, number] => {
    const ns = Math.round(performance.now() * 1e6) - (prev ? prev[0] * 1e9 + prev[1] : 0);
    return [Math.floor(ns / 1e9), ns % 1e9];
  }, { bigint: (): bigint => BigInt(Math.round(performance.now() * 1e6)) }),
  uptime: (): number => (performance.now() - started) / 1000,
  memoryUsage: (): Record<string, number> => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  getSystemVersion: (): string => '',
  emitWarning: (w: unknown): void => console.warn(w),
  stdout: { write: (s: unknown): boolean => (console.log(String(s)), true) },
  stderr: { write: (s: unknown): boolean => (console.error(String(s)), true) },
  umask: (): number => 0,
});

/** Node's timers return an object with unref(); src/main calls it. */
class Timeout {
  constructor(readonly id: number) {}
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

const idOf = (t: unknown): number | undefined => (t instanceof Timeout ? t.id : typeof t === 'number' ? t : undefined);
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
type Fn = (...a: unknown[]) => void;

const g = globalThis as unknown as Record<string, unknown>;
g.process = proc;
g.global = globalThis;
g.Buffer = Buffer;
g.setTimeout = (fn: Fn, ms?: number, ...a: unknown[]): Timeout => new Timeout(nativeSetTimeout(fn, ms, ...a));
g.setInterval = (fn: Fn, ms?: number, ...a: unknown[]): Timeout => new Timeout(nativeSetInterval(fn, ms, ...a));
g.clearTimeout = (t: unknown): void => nativeClearTimeout(idOf(t));
g.clearInterval = (t: unknown): void => nativeClearInterval(idOf(t));
g.setImmediate = (fn: Fn, ...a: unknown[]): Timeout => new Timeout(nativeSetTimeout(fn, 0, ...a));
g.clearImmediate = (t: unknown): void => nativeClearTimeout(idOf(t));

// The main process's console goes to the shell's log too, where a test or a bug report can read it.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    original(...args);
    const msg = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    invoke('log', { msg: `[${level}] ${msg}` }).catch(() => undefined);
  };
}
window.addEventListener('error', (e) => console.error('uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => console.error('unhandled rejection', e.reason));
