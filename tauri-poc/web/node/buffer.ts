// node:buffer for main-process code in a page: the encodings and methods src/main uses, on Uint8Array.

type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  // Node ignores characters outside the alphabet and accepts either alphabet without padding.
  const clean = s.replace(/[^A-Za-z0-9+/\-_]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encode(s: string, enc: Encoding = 'utf8'): Uint8Array {
  switch (enc) {
    case 'hex': {
      const n = Math.floor(s.length / 2);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const v = parseInt(s.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(v)) return out.subarray(0, i);
        out[i] = v;
      }
      return out;
    }
    case 'base64':
    case 'base64url':
      return fromBase64(s);
    case 'latin1':
    case 'binary':
    case 'ascii': {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    default:
      return utf8Encoder.encode(s);
  }
}

class BufferImpl extends Uint8Array {
  override toString(enc: Encoding = 'utf8', start = 0, end = this.length): string {
    const u = this.subarray(start, end);
    switch (enc) {
      case 'hex':
        return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
      case 'base64':
        return toBase64(u);
      case 'base64url':
        return toBase64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      case 'latin1':
      case 'binary':
      case 'ascii': {
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
        return s;
      }
      default:
        return utf8Decoder.decode(u);
    }
  }

  /** Node's slice shares memory, unlike Uint8Array's. */
  override slice(start?: number, end?: number): BufferImpl {
    return this.subarray(start, end) as BufferImpl;
  }

  equals(other: Uint8Array): boolean {
    return compare(this, other) === 0;
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const part = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + target.length - targetStart));
    target.set(part, targetStart);
    return part.length;
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) };
  }

  private dv(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  readUInt8(o = 0): number { return this.dv().getUint8(o); }
  readUInt16BE(o = 0): number { return this.dv().getUint16(o); }
  readUInt16LE(o = 0): number { return this.dv().getUint16(o, true); }
  readUInt32BE(o = 0): number { return this.dv().getUint32(o); }
  readUInt32LE(o = 0): number { return this.dv().getUint32(o, true); }
  writeUInt8(v: number, o = 0): number { this.dv().setUint8(o, v); return o + 1; }
  writeUInt16BE(v: number, o = 0): number { this.dv().setUint16(o, v); return o + 2; }
  writeUInt16LE(v: number, o = 0): number { this.dv().setUint16(o, v, true); return o + 2; }
  writeUInt32BE(v: number, o = 0): number { this.dv().setUint32(o, v); return o + 4; }
  writeUInt32LE(v: number, o = 0): number { this.dv().setUint32(o, v, true); return o + 4; }
}

function view(u: Uint8Array): BufferImpl {
  return new BufferImpl(u.buffer as ArrayBuffer, u.byteOffset, u.byteLength);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

type Source = string | ArrayLike<number> | ArrayBufferLike | Iterable<number>;

const statics = {
  from(value: Source, encOrOffset?: Encoding | number, length?: number): BufferImpl {
    if (typeof value === 'string') return view(encode(value, (encOrOffset as Encoding | undefined) ?? 'utf8'));
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      const offset = typeof encOrOffset === 'number' ? encOrOffset : 0;
      return new BufferImpl(value as ArrayBuffer, offset, length ?? value.byteLength - offset);
    }
    const list = ArrayBuffer.isView(value) ? (value as Uint8Array) : Array.from(value as ArrayLike<number>);
    const b = new BufferImpl(list.length);
    b.set(list);
    return b;
  },
  /** The same memory as `u`, typed as a Buffer. */
  view,
  compare,
  alloc(size: number, fill?: number | string): BufferImpl {
    const b = new BufferImpl(size);
    if (typeof fill === 'number') b.fill(fill);
    else if (typeof fill === 'string' && fill.length > 0) {
      const f = encode(fill);
      for (let i = 0; i < size; i++) b[i] = f[i % f.length];
    }
    return b;
  },
  allocUnsafe: (size: number): BufferImpl => new BufferImpl(size),
  isBuffer: (v: unknown): v is BufferImpl => v instanceof BufferImpl,
  byteLength: (s: string | Uint8Array, enc?: Encoding): number => (typeof s === 'string' ? encode(s, enc).length : s.byteLength),
  concat(list: readonly Uint8Array[], total?: number): BufferImpl {
    const size = total ?? list.reduce((n, u) => n + u.length, 0);
    const out = new BufferImpl(size);
    let at = 0;
    for (const u of list) {
      if (at >= size) break;
      out.set(u.subarray(0, size - at), at);
      at += Math.min(u.length, size - at);
    }
    return out;
  },
};

interface BufferConstructor {
  new (size: number): BufferImpl;
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): BufferImpl;
  readonly prototype: BufferImpl;
  from: typeof statics.from;
  view: typeof view;
  compare: typeof compare;
  alloc: typeof statics.alloc;
  allocUnsafe: typeof statics.allocUnsafe;
  isBuffer: typeof statics.isBuffer;
  byteLength: typeof statics.byteLength;
  concat: typeof statics.concat;
}

// Node's statics replace Uint8Array's (Buffer.from takes an encoding), which a subclass can't declare: put on afterwards.
export const Buffer = Object.assign(BufferImpl, statics) as unknown as BufferConstructor;
export type Buffer = BufferImpl;

/** Uint8Array to Buffer without copying (a Buffer stays as it is). */
export const asBuffer = (u: Uint8Array): Buffer => (u instanceof BufferImpl ? u : view(u));

export default { Buffer };
