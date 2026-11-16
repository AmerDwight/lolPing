// Calls into the shell's `sys` handler (src-tauri/src/main.rs): synchronous ones for the Node APIs that block (a sync
// XHR to the shell's lolpingsys protocol), asynchronous ones through a Tauri command.
import { invoke } from './tauri';

/** A Node-style error, with the `code` that fs and child_process callers test. */
export type NodeError = Error & { code: string };

interface Failure {
  code?: unknown;
  message?: unknown;
}

export function nodeError(e: unknown): NodeError {
  if (e instanceof Error && typeof (e as Partial<NodeError>).code === 'string') return e as NodeError;
  const f: Failure = typeof e === 'object' && e !== null ? (e as Failure) : { message: String(e) };
  const err = new Error(typeof f.message === 'string' ? f.message : String(e)) as NodeError;
  err.code = typeof f.code === 'string' ? f.code : 'EIO';
  return err;
}

// Windows serves custom schemes as http://<scheme>.localhost, Linux and macOS as <scheme>://localhost.
const base = (): string =>
  location.protocol === 'http:' || location.protocol === 'https:' ? 'http://lolpingsys.localhost/' : 'lolpingsys://localhost/';

type Answer<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function sysSync<T>(op: string, args: Record<string, unknown> = {}): T {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `${base()}${op}?a=${encodeURIComponent(JSON.stringify(args))}`, false);
  xhr.send();
  if (xhr.status !== 200) throw nodeError({ code: 'EIO', message: `${op}: the shell answered ${xhr.status}` });
  const answer = JSON.parse(xhr.responseText) as Answer<T>;
  if (!answer.ok) throw nodeError(answer);
  return answer.value;
}

export function sysAsync<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('sys_async', { op, args }).catch((e: unknown) => {
    throw nodeError(e);
  });
}
