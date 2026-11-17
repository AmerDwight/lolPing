import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The app's lolping:// handler (src/main/appProtocol.ts), unchanged, on the Tauri stand-ins for protocol and net. A fake
// shell sends requests the way the Rust shell does and reads files for the stand-in's fs.
vi.mock('electron', () => import('../../tauri-poc/web/electron/protocol'));

interface Reply {
  status: number;
  headers: [string, string][];
  body: string;
}

const HASH = '0123456789abcdef0123456789abcdef';
let dir: string;
let replies: Map<number, Reply>;

function fakeShell(): void {
  const invoke = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === 'sys_async' && args.op === 'fs.readFile') {
      const { path } = args.args as { path: string };
      return readFileSync(path).toString('base64');
    }
    if (cmd === 'scheme_reply') replies.set(args.id as number, args as unknown as Reply);
    return null;
  };
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
}

async function get(id: number, url: string): Promise<Reply | undefined> {
  const core = (window as unknown as { __core: Record<string, (...a: unknown[]) => void> }).__core;
  core.scheme(id, url);
  await vi.waitFor(() => expect(replies.has(id)).toBe(true));
  return replies.get(id);
}

beforeAll(fakeShell);
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  replies = new Map();
  dir = mkdtempSync(join(tmpdir(), 'lolping-scheme-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('protocol stand-in', () => {
  it('serves an emote from the data folder through the app handler', async () => {
    const still = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
    writeFileSync(join(dir, `${HASH}.webp`), still);
    const { serveAppScheme } = await import('../../src/main/appProtocol');
    serveAppScheme({ rendererRoot: null, emoteDirs: () => [dir] });
    const r = await get(1, `lolping://emotes/${HASH}.webp`);
    expect(r?.status).toBe(200);
    expect(Object.fromEntries(r?.headers ?? [])).toMatchObject({ 'content-type': 'image/webp', 'cache-control': 'no-store' });
    expect([...Buffer.from(r?.body ?? '', 'base64')]).toEqual([...still]);
  });

  it('answers not found for a file the folder lacks and for names the app does not serve', async () => {
    const { serveAppScheme } = await import('../../src/main/appProtocol');
    serveAppScheme({ rendererRoot: null, emoteDirs: () => [dir] });
    expect((await get(2, `lolping://emotes/${HASH}.webp`))?.status).toBe(404);
    expect((await get(3, 'lolping://emotes/../settings.json'))?.status).toBe(404);
  });

  it('answers not found once the app has taken its handler back', async () => {
    writeFileSync(join(dir, `${HASH}.webp`), 'still');
    const { serveAppScheme } = await import('../../src/main/appProtocol');
    const { protocol } = await import('../../tauri-poc/web/electron/protocol');
    serveAppScheme({ rendererRoot: null, emoteDirs: () => [dir] });
    protocol.unhandle('lolping');
    expect((await get(4, `lolping://emotes/${HASH}.webp`))?.status).toBe(404);
  });
});
