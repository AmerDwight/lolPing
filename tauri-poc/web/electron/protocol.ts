// Electron's protocol and net modules for the core page. The shell sends each lolping:// request here and the handler the
// app gave protocol.handle (src/main/appProtocol.ts) answers it, so imported and cached emotes are served by the app's
// own rules.
import { onShell } from '../hub';
import { Buffer } from '../node/buffer';
import { promises } from '../node/fs';
import { extname } from '../node/path';
import { fileURLToPath } from '../node/small';
import { invoke } from '../tauri';

type Handler = (request: Request) => Response | Promise<Response>;

const handlers = new Map<string, Handler>();

export const protocol = {
  // Tauri's scheme is registered by the shell; the privileges it needs (CORS) are set there.
  registerSchemesAsPrivileged: (): void => undefined,
  handle: (scheme: string, fn: Handler): void => {
    handlers.set(scheme, fn);
  },
  unhandle: (scheme: string): void => {
    handlers.delete(scheme);
  },
};

const TYPES: Record<string, string> = {
  '.webp': 'image/webp', '.gif': 'image/gif', '.png': 'image/png', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
};

/** Electron's net.fetch: file:// from the disk through the shell, anything else through the page's fetch. */
export const net = {
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('file:')) return fetch(input, init);
    const path = fileURLToPath(url);
    const bytes = await promises.readFile(path); // rejects when missing, as Electron's does
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'Content-Type': type } });
  },
};

function request(url: string): Request {
  try {
    return new Request(url);
  } catch {
    // An engine that won't build a Request for an unknown scheme: the app's handler only reads the URL.
    return { url, method: 'GET', headers: new Headers() } as unknown as Request;
  }
}

async function answer(id: number, url: string): Promise<void> {
  let status = 404;
  let headers: [string, string][] = [];
  let body = '';
  try {
    const fn = handlers.get(url.slice(0, url.indexOf(':')));
    if (fn) {
      const res = await fn(request(url));
      status = res.status;
      headers = [...res.headers];
      body = Buffer.view(new Uint8Array(await res.arrayBuffer())).toString('base64');
    }
  } catch (e) {
    status = 500;
    invoke('log', { msg: `lolping:// ${url}: ${(e as Error).message}` }).catch(() => undefined);
  }
  await invoke('scheme_reply', { id, status, headers, body }).catch(() => undefined);
}

onShell('scheme', ((id: number, url: string) => void answer(id, url)) as never);
