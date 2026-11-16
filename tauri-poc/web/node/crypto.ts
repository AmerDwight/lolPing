// node:crypto for main-process code in a page. Room packets are sealed and signed synchronously, which Web Crypto
// can't do, so this is the noble libraries: AES-256-GCM, Ed25519, HKDF, scrypt and the SHA family.
import { gcm } from '@noble/ciphers/aes.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { Buffer } from './buffer';

type Data = string | Uint8Array;
type Encoding = 'hex' | 'base64' | 'base64url' | 'latin1';

const bytes = (d: Data, enc?: 'utf8' | 'hex' | 'base64' | 'latin1'): Uint8Array =>
  typeof d === 'string' ? Buffer.from(d, enc) : d;

const HASHES = { sha256, sha512, sha1, md5 } as const;
type HashName = keyof typeof HASHES;

function hashOf(name: string): (typeof HASHES)[HashName] {
  const h = HASHES[name.toLowerCase().replace('-', '') as HashName];
  if (!h) throw new Error(`Digest method not supported: ${name}`);
  return h;
}

interface Updatable {
  update(b: Uint8Array): unknown;
  digest(): Uint8Array;
}

class Hash {
  constructor(private readonly h: Updatable) {}

  update(data: Data, enc?: 'utf8' | 'hex' | 'base64' | 'latin1'): this {
    this.h.update(bytes(data, enc));
    return this;
  }

  digest(): Buffer;
  digest(enc: Encoding): string;
  digest(enc?: Encoding): Buffer | string {
    const out = Buffer.view(this.h.digest());
    return enc ? out.toString(enc) : out;
  }
}

export const createHash = (alg: string): Hash => new Hash(hashOf(alg).create());

export const createHmac = (alg: string, key: Data): Hash => new Hash(hmac.create(hashOf(alg), bytes(key)));

export function randomBytes(n: number): Buffer;
export function randomBytes(n: number, cb: (err: Error | null, b: Buffer) => void): void;
export function randomBytes(n: number, cb?: (err: Error | null, b: Buffer) => void): Buffer | void {
  const out = new Buffer(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  if (!cb) return out;
  queueMicrotask(() => cb(null, out));
}

/** randomInt(max) or randomInt(min, max): an integer in [min, max), without modulo bias. */
export function randomInt(a: number, b?: number): number {
  const [min, max] = b === undefined ? [0, a] : [a, b];
  const range = max - min;
  if (!(range > 0) || range > 2 ** 32) throw new RangeError('randomInt: bad range');
  const limit = Math.floor(2 ** 32 / range) * range;
  const u = new Uint32Array(1);
  do crypto.getRandomValues(u);
  while (u[0] >= limit);
  return min + (u[0] % range);
}

export const randomUUID = (): string => crypto.randomUUID();

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- AES-256-GCM: Node's streaming cipher over noble's one-shot one; update() holds the data until final() ------------

class GcmCipher {
  private readonly parts: Uint8Array[] = [];
  private aad: Uint8Array | undefined;
  private tag: Uint8Array | undefined;

  constructor(private readonly key: Uint8Array, private readonly iv: Uint8Array, private readonly decrypt: boolean) {}

  setAAD(aad: Uint8Array): this {
    this.aad = aad;
    return this;
  }

  setAuthTag(tag: Uint8Array): this {
    this.tag = tag;
    return this;
  }

  getAuthTag(): Buffer {
    if (!this.tag) throw new Error('getAuthTag before final');
    return Buffer.from(this.tag);
  }

  update(data: Data): Buffer {
    this.parts.push(bytes(data));
    return Buffer.alloc(0);
  }

  final(): Buffer {
    const input = Buffer.concat(this.parts);
    const c = gcm(this.key, this.iv, this.aad);
    if (this.decrypt) {
      if (!this.tag) throw new Error('Unsupported state or unable to authenticate data');
      try {
        return Buffer.view(c.decrypt(Buffer.concat([input, this.tag])));
      } catch {
        throw new Error('Unsupported state or unable to authenticate data');
      }
    }
    const sealed = c.encrypt(input);
    this.tag = sealed.subarray(sealed.length - 16);
    return Buffer.view(sealed.subarray(0, sealed.length - 16));
  }
}

function gcmOnly(alg: string, key: Uint8Array): void {
  if (alg.toLowerCase() !== 'aes-256-gcm' || key.length !== 32) throw new Error(`cipher not supported here: ${alg}`);
}

export function createCipheriv(alg: string, key: Uint8Array, iv: Uint8Array): GcmCipher {
  gcmOnly(alg, key);
  return new GcmCipher(key, iv, false);
}

export function createDecipheriv(alg: string, key: Uint8Array, iv: Uint8Array): GcmCipher {
  gcmOnly(alg, key);
  return new GcmCipher(key, iv, true);
}

// --- Ed25519 keys, as DER the way roomCrypto imports and exports them ------------------------------------------------

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

const startsWith = (b: Uint8Array, prefix: Uint8Array): boolean =>
  b.length >= prefix.length && prefix.every((v, i) => b[i] === v);

export class KeyObject {
  readonly asymmetricKeyType = 'ed25519';

  constructor(readonly type: 'private' | 'public', readonly raw: Uint8Array) {}

  export(o: { format: 'der'; type: 'spki' | 'pkcs8' }): Buffer {
    if (o.format !== 'der') throw new Error('only DER export is supported here');
    if (this.type === 'public' && o.type === 'spki') return Buffer.concat([SPKI_ED25519, this.raw]);
    if (this.type === 'private' && o.type === 'pkcs8') return Buffer.concat([PKCS8_ED25519, this.raw]);
    throw new Error(`cannot export a ${this.type} key as ${o.type}`);
  }
}

interface DerKey {
  key: Uint8Array;
  format: 'der';
  type: 'pkcs8' | 'spki';
}

export function createPrivateKey(o: DerKey): KeyObject {
  if (o.format !== 'der' || o.type !== 'pkcs8' || o.key.length !== 48 || !startsWith(o.key, PKCS8_ED25519)) {
    throw new Error('only Ed25519 PKCS#8 DER keys are supported here');
  }
  return new KeyObject('private', Uint8Array.from(o.key.subarray(16)));
}

export function createPublicKey(o: KeyObject | DerKey): KeyObject {
  if (o instanceof KeyObject) {
    return o.type === 'public' ? o : new KeyObject('public', ed25519.getPublicKey(o.raw));
  }
  if (o.format !== 'der' || o.type !== 'spki' || o.key.length !== 44 || !startsWith(o.key, SPKI_ED25519)) {
    throw new Error('only Ed25519 SPKI DER keys are supported here');
  }
  // Like Node, a point off the curve is accepted here and fails at verify.
  return new KeyObject('public', Uint8Array.from(o.key.subarray(12)));
}

export function sign(_alg: null | undefined, data: Uint8Array, key: KeyObject): Buffer {
  if (key.type !== 'private') throw new Error('sign needs a private key');
  return Buffer.view(ed25519.sign(data, key.raw));
}

/** Strict RFC 8032 checks, like OpenSSL's. */
export function verify(_alg: null | undefined, data: Uint8Array, key: KeyObject, sig: Uint8Array): boolean {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  try {
    return ed25519.verify(sig, data, pub.raw, { zip215: false });
  } catch {
    return false; // a public key that is not a point
  }
}

// --- key derivation -------------------------------------------------------------------------------------------------

export function hkdfSync(digest: string, ikm: Data, salt: Data, info: Data, keylen: number): ArrayBuffer {
  const out = hkdf(hashOf(digest), bytes(ikm), bytes(salt), bytes(info), keylen);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

interface ScryptOptions {
  N?: number;
  r?: number;
  p?: number;
  maxmem?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
}

type ScryptCallback = (err: Error | null, key: Buffer) => void;

export function scrypt(password: Data, salt: Data, keylen: number, opts: ScryptOptions | ScryptCallback, cb?: ScryptCallback): void {
  const done = typeof opts === 'function' ? opts : cb;
  const o = typeof opts === 'function' ? {} : opts;
  if (!done) throw new TypeError('scrypt needs a callback');
  scryptAsync(bytes(password), bytes(salt), {
    N: o.N ?? o.cost ?? 16384, r: o.r ?? o.blockSize ?? 8, p: o.p ?? o.parallelization ?? 1, dkLen: keylen,
    maxmem: o.maxmem ?? 32 * 1024 * 1024 * 4,
  }).then((k) => done(null, Buffer.view(k)), (e: unknown) => done(e instanceof Error ? e : new Error(String(e)), Buffer.alloc(0)));
}

export default {
  createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv,
  createPrivateKey, createPublicKey, sign, verify, hkdfSync, scrypt, KeyObject,
};
