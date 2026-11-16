// node:dgram for main-process code in a page: UDP sockets in the shell, for the local-network room.
import { onShell } from '../hub';
import { nodeError } from '../sys';
import { invoke } from '../tauri';
import { Buffer } from './buffer';
import { EventEmitter } from './events';

const sockets = new Map<number, Socket>();
let nextId = 1;

type SendCallback = (err: Error | null, bytes?: number) => void;

export class Socket extends EventEmitter {
  readonly id = nextId++;
  private local: { address: string; port: number } | null = null;
  private closed = false;

  constructor() {
    super();
    sockets.set(this.id, this);
  }

  bind(port?: number | { port?: number; address?: string }, address?: string | (() => void), cb?: () => void): this {
    const o = typeof port === 'object' ? port : { port, address: typeof address === 'string' ? address : undefined };
    const done = typeof address === 'function' ? address : cb;
    invoke<{ address: string; port: number }>('udp_bind', { id: this.id, port: o.port ?? 0, address: o.address ?? '0.0.0.0' }).then(
      (local) => {
        if (this.closed) return void invoke('udp_close', { id: this.id }).catch(() => undefined);
        this.local = local;
        this.emit('listening');
        done?.();
      },
      (e: unknown) => this.emit('error', nodeError(e)),
    );
    return this;
  }

  setBroadcast(on: boolean): void {
    invoke('udp_broadcast', { id: this.id, on }).catch(() => undefined);
  }

  /** send(msg, port, host, cb) or send(msg, offset, length, port, host, cb). */
  send(msg: string | Uint8Array, ...rest: unknown[]): void {
    let data = typeof msg === 'string' ? Buffer.from(msg) : Buffer.view(msg);
    let i = 0;
    if (typeof rest[2] === 'number') {
      data = data.subarray(rest[0] as number, (rest[0] as number) + (rest[1] as number)) as Buffer;
      i = 2;
    }
    const port = rest[i] as number;
    const host = typeof rest[i + 1] === 'string' ? (rest[i + 1] as string) : '127.0.0.1';
    const cb = rest.find((x): x is SendCallback => typeof x === 'function');
    if (this.closed) {
      queueMicrotask(() => cb?.(nodeError({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING', message: 'Not running' })));
      return;
    }
    invoke('udp_send', { id: this.id, data: data.toString('base64'), host, port }).then(
      () => cb?.(null, data.length),
      (e: unknown) => cb?.(nodeError(e)),
    );
  }

  close(cb?: () => void): this {
    if (this.closed) throw nodeError({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING', message: 'Not running' });
    this.closed = true;
    sockets.delete(this.id);
    invoke('udp_close', { id: this.id }).catch(() => undefined);
    queueMicrotask(() => {
      this.emit('close');
      cb?.();
    });
    return this;
  }

  address(): { address: string; port: number; family: 'IPv4' } {
    if (!this.local) throw nodeError({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING', message: 'Not running' });
    return { ...this.local, family: 'IPv4' };
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

onShell('udp', ((id: number, data: string, address: string, port: number) => {
  const b = Buffer.from(data, 'base64');
  sockets.get(id)?.emit('message', b, { address, port, family: 'IPv4', size: b.length });
}) as never);

export function createSocket(type: string | { type: string }, listener?: (msg: Buffer, rinfo: unknown) => void): Socket {
  const t = typeof type === 'string' ? type : type.type;
  if (t !== 'udp4') throw new Error(`only udp4 sockets here, not ${t}`);
  const s = new Socket();
  if (listener) s.on('message', listener);
  return s;
}

export default { createSocket, Socket };
