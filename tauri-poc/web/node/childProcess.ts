// node:child_process for main-process code in a page: processes the shell starts with piped stdio.
import { onShell } from '../hub';
import { nodeError } from '../sys';
import { invoke } from '../tauri';
import { Buffer } from './buffer';
import { EventEmitter } from './events';

class Readable extends EventEmitter {
  private enc: 'utf8' | null = null;
  readonly readable = true;

  setEncoding(enc: 'utf8'): this {
    this.enc = enc;
    return this;
  }

  push(chunk: Buffer): void {
    this.emit('data', this.enc ? chunk.toString(this.enc) : chunk);
  }

  finish(): void {
    this.emit('end');
    this.emit('close');
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  destroy(): this {
    return this;
  }
}

class Writable extends EventEmitter {
  private ended = false;

  constructor(private readonly id: number) {
    super();
  }

  // Callers check these before writing, as src/main/inputBridge.ts does: without them nothing reaches the process.
  get writable(): boolean {
    return !this.ended;
  }

  get destroyed(): boolean {
    return this.ended;
  }

  write(data: string | Uint8Array, enc?: string | ((e?: Error | null) => void), cb?: (e?: Error | null) => void): boolean {
    const done = typeof enc === 'function' ? enc : cb;
    if (this.ended) {
      const e = nodeError({ code: 'EPIPE', message: 'write after end' });
      queueMicrotask(() => (done ? done(e) : this.emit('error', e)));
      return false;
    }
    const b = typeof data === 'string' ? Buffer.from(data) : Buffer.view(data);
    invoke('proc_write', { id: this.id, data: b.toString('base64') }).then(
      () => done?.(null),
      (e: unknown) => (done ? done(nodeError(e)) : this.emit('error', nodeError(e))),
    );
    return true;
  }

  end(data?: string | Uint8Array): this {
    if (data !== undefined) this.write(data);
    if (!this.ended) {
      this.ended = true;
      invoke('proc_end', { id: this.id }).catch(() => undefined);
    }
    return this;
  }

  destroy(): this {
    return this.end();
  }
}

export class ChildProcess extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly stdin: Writable;
  readonly stdout = new Readable();
  readonly stderr = new Readable();

  constructor(readonly id: number) {
    super();
    this.stdin = new Writable(id);
  }

  kill(_signal?: string): boolean {
    this.killed = true;
    invoke('proc_kill', { id: this.id }).catch(() => undefined);
    return true;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

const running = new Map<number, ChildProcess>();
let nextId = 1;

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: unknown;
  windowsHide?: boolean;
  timeout?: number;
}

export function spawn(command: string, args: readonly string[] = [], opts: SpawnOptions = {}): ChildProcess {
  const cp = new ChildProcess(nextId++);
  running.set(cp.id, cp);
  const env = opts.env
    ? Object.fromEntries(Object.entries(opts.env).filter((kv): kv is [string, string] => kv[1] !== undefined))
    : null;
  invoke<number>('proc_spawn', { id: cp.id, command, args: [...args], cwd: opts.cwd ?? null, env }).then(
    (pid) => {
      cp.pid = pid;
      cp.emit('spawn');
    },
    (e: unknown) => {
      running.delete(cp.id);
      cp.emit('error', nodeError(e));
      cp.emit('close', -2, null);
    },
  );
  return cp;
}

onShell('proc', ((id: number, kind: string, data: string | number | null) => {
  const cp = running.get(id);
  if (!cp) return;
  if (kind === 'stdout' && typeof data === 'string') cp.stdout.push(Buffer.from(data, 'base64'));
  else if (kind === 'stderr' && typeof data === 'string') cp.stderr.push(Buffer.from(data, 'base64'));
  else if (kind === 'exit') {
    running.delete(id);
    cp.exitCode = typeof data === 'number' ? data : null;
    cp.signalCode = data === null && cp.killed ? 'SIGTERM' : null;
    cp.stdout.finish();
    cp.stderr.finish();
    cp.emit('exit', cp.exitCode, cp.signalCode);
    cp.emit('close', cp.exitCode, cp.signalCode);
  }
}) as never);

type ExecCallback = (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void;

export function execFile(
  file: string, args?: readonly string[] | SpawnOptions | ExecCallback, opts?: (SpawnOptions & { encoding?: string }) | ExecCallback,
  cb?: ExecCallback,
): ChildProcess {
  const list = Array.isArray(args) ? args : [];
  const o = (typeof opts === 'object' ? opts : typeof args === 'object' && !Array.isArray(args) ? args : {}) as SpawnOptions;
  const done = [args, opts, cb].find((x): x is ExecCallback => typeof x === 'function');
  const cp = spawn(file, list, o);
  let out = '';
  let err = '';
  cp.stdout.setEncoding('utf8');
  cp.stderr.setEncoding('utf8');
  cp.stdout.on('data', (d: string) => (out += d));
  cp.stderr.on('data', (d: string) => (err += d));
  const timer = o.timeout ? setTimeout(() => cp.kill(), o.timeout) : null;
  let failed: Error | null = null;
  cp.on('error', (e: Error) => (failed = e));
  cp.on('close', (code: number | null) => {
    if (timer) clearTimeout(timer);
    if (!done) return;
    if (failed) return done(failed, out, err);
    if (code === 0) return done(null, out, err);
    const e = Object.assign(new Error(`Command failed: ${file} ${list.join(' ')}\n${err}`), { code: code ?? 'SIGTERM', killed: cp.killed });
    done(e, out, err);
  });
  return cp;
}

export function exec(command: string, opts?: SpawnOptions | ExecCallback, cb?: ExecCallback): ChildProcess {
  const win = typeof process !== 'undefined' && process.platform === 'win32';
  const [file, args] = win ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]];
  return execFile(file, args, opts as SpawnOptions, cb ?? (typeof opts === 'function' ? opts : undefined));
}

const blocking = (): never => {
  throw new Error('synchronous child processes are not available in lolPing on Tauri');
};
export const spawnSync = blocking;
export const execFileSync = blocking;
export const execSync = blocking;

export default { spawn, execFile, exec, spawnSync, execFileSync, execSync, ChildProcess };
