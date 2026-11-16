import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Electron app's InputBridge, unchanged, on the Tauri stand-ins for child_process and readline, as the core page
// runs it. A fake shell answers the proc_* commands and records what reaches the process's stdin.
vi.mock('node:child_process', () => import('../../tauri-poc/web/node/childProcess'));
vi.mock('node:readline', () => import('../../tauri-poc/web/node/readline'));

interface Shell {
  stdin: string[];
  ended: boolean;
  output(line: string): void;
}

const b64 = (s: string): string => globalThis.Buffer.from(s).toString('base64');

function fakeShell(): Shell {
  const shell: Shell = {
    stdin: [],
    ended: false,
    output: (line) => {
      const core = (window as unknown as { __core: Record<string, (...a: unknown[]) => void> }).__core;
      core.proc(1, 'stdout', b64(`${line}\n`));
    },
  };
  const invoke = async (cmd: string, args: { data?: string }): Promise<unknown> => {
    if (cmd === 'proc_spawn') return 4242;
    if (cmd === 'proc_write' && args.data) shell.stdin.push(globalThis.Buffer.from(args.data, 'base64').toString());
    if (cmd === 'proc_end') shell.ended = true;
    return null;
  };
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  return shell;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('child_process stand-in', () => {
  it('lets InputBridge send the helper its config once the helper is ready', async () => {
    const shell = fakeShell();
    const { InputBridge } = await import('../../src/main/inputBridge');
    const bridge = new InputBridge({ command: 'hook-helper' });
    bridge.start();
    await settle();
    bridge.send({ type: 'setEnabled', enabled: false });
    shell.output('{"type":"ready","version":1}');
    await settle();
    expect(bridge.status).toBe('running');
    expect(shell.stdin.map((l) => JSON.parse(l))).toEqual([{ type: 'setEnabled', enabled: false }]);
  });

  it('stops counting as writable once stdin is ended', async () => {
    const shell = fakeShell();
    const { spawn } = await import('../../tauri-poc/web/node/childProcess');
    const child = spawn('hook-helper');
    expect([child.stdin.writable, child.stdin.destroyed]).toEqual([true, false]);
    child.stdin.end();
    await settle();
    expect([child.stdin.writable, child.stdin.destroyed, shell.ended]).toEqual([false, true, true]);
  });
});
