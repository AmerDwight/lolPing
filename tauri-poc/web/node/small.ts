// node:net and node:url for main-process code in a page. net is only the teammate's MCP bridge, which this proof of
// concept leaves out: a server that can't listen, the way a blocked pipe would fail.
import { EventEmitter } from './events';

class Server extends EventEmitter {
  listen(..._args: unknown[]): this {
    setTimeout(() => this.emit('error', Object.assign(new Error('pipes are not available in lolPing on Tauri'), { code: 'ENOTSUP' })), 0);
    return this;
  }

  close(cb?: () => void): this {
    cb?.();
    return this;
  }

  address(): null {
    return null;
  }
}

export const createServer = (): Server => new Server();

export function createConnection(): EventEmitter {
  const s = new EventEmitter();
  setTimeout(() => s.emit('error', Object.assign(new Error('pipes are not available in lolPing on Tauri'), { code: 'ENOTSUP' })), 0);
  return s;
}

export const connect = createConnection;

export function fileURLToPath(u: string | URL): string {
  const url = typeof u === 'string' ? new URL(u) : u;
  const p = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1).replace(/\//g, '\\') : p;
}

export function pathToFileURL(p: string): URL {
  const fwd = p.replace(/\\/g, '/');
  return new URL(`file://${fwd.startsWith('/') ? '' : '/'}${encodeURI(fwd)}`);
}

const GlobalURL = URL;
const GlobalSearchParams = URLSearchParams;
export { GlobalURL as URL, GlobalSearchParams as URLSearchParams };
export default { createServer, createConnection, connect, fileURLToPath, pathToFileURL, URL: GlobalURL };
