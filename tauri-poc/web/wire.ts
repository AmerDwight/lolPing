// IPC payloads between pages go through the shell as JSON, which has no bytes. Electron's structured clone carries
// typed arrays (emote files, shared stills), so they travel tagged as base64 and come back as Uint8Array.

const TAG = '__lolpingBytes';

const toB64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** A JSON-safe copy of `v`: bytes tagged, undefined dropped as JSON does (null inside arrays). */
export function encodeWire(v: unknown): unknown {
  if (v instanceof Uint8Array) return { [TAG]: toB64(v) };
  if (v instanceof ArrayBuffer) return { [TAG]: toB64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { [TAG]: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encodeWire(x)));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') out[k] = encodeWire(x);
    return out;
  }
  return v;
}

export function decodeWire(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeWire);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o[TAG] === 'string' && Object.keys(o).length === 1) return fromB64(o[TAG]);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeWire(x);
    return out;
  }
  return v;
}
