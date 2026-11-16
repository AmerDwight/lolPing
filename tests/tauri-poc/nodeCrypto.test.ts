import * as node from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Buffer as PageBuffer } from '../../tauri-poc/web/node/buffer';
import * as page from '../../tauri-poc/web/node/crypto';

// The page's node:crypto has to give the bytes Node gives: an Electron peer opens what a Tauri peer sealed.
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');

describe('page crypto', () => {
  it('hashes as Node does', () => {
    for (const alg of ['sha256', 'sha512', 'sha1', 'md5']) {
      const data = Buffer.from('lolping room ' + alg);
      expect(page.createHash(alg).update(data).update('tail').digest('hex'))
        .toBe(node.createHash(alg).update(data).update('tail').digest('hex'));
    }
    expect(page.createHmac('sha256', 'k').update('x').digest('base64')).toBe(node.createHmac('sha256', 'k').update('x').digest('base64'));
  });

  it('derives the same HKDF keys as Node, empty salt included', () => {
    const ikm = node.randomBytes(32);
    for (const info of ['msg', 'sig-room']) {
      expect(Buffer.from(page.hkdfSync('sha256', ikm, PageBuffer.alloc(0), info, 32)))
        .toEqual(Buffer.from(node.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32)));
    }
  });

  it('derives the same scrypt key as Node with the room parameters', async () => {
    const opts = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
    const want = node.scryptSync('ABCD-EFGH-IJKL', 'lolping/room/v1', 32, opts);
    const got = await new Promise<Uint8Array>((resolve, reject) =>
      page.scrypt('ABCD-EFGH-IJKL', 'lolping/room/v1', 32, opts, (e, k) => (e ? reject(e) : resolve(k))));
    expect(Buffer.from(got)).toEqual(want);
  }, 30_000);

  it('seals AES-256-GCM exactly as Node does, and each opens the other', () => {
    const key = node.randomBytes(32);
    const iv = node.randomBytes(12);
    const aad = Buffer.from([1]);
    const plain = Buffer.from('{"t":"ping","id":"danger"}');
    const n = node.createCipheriv('aes-256-gcm', key, iv);
    n.setAAD(aad);
    const nodeCt = Buffer.concat([n.update(plain), n.final()]);
    const nodeTag = n.getAuthTag();
    const p = page.createCipheriv('aes-256-gcm', key, iv);
    p.setAAD(aad);
    const pageCt = PageBuffer.concat([p.update(plain), p.final()]);
    expect(Buffer.from(pageCt)).toEqual(nodeCt);
    expect(Buffer.from(p.getAuthTag())).toEqual(nodeTag);

    const d = page.createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(aad);
    d.setAuthTag(nodeTag);
    expect(Buffer.from(PageBuffer.concat([d.update(nodeCt), d.final()]))).toEqual(plain);
  });

  it('refuses a tampered packet, as Node does', () => {
    const key = node.randomBytes(32);
    const iv = node.randomBytes(12);
    const c = page.createCipheriv('aes-256-gcm', key, iv);
    const ct = PageBuffer.concat([c.update(Buffer.from('hello')), c.final()]);
    ct[0] ^= 1;
    const d = page.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(c.getAuthTag());
    d.update(ct);
    expect(() => d.final()).toThrow();
  });

  it('signs with the same Ed25519 key and signature as Node, and each verifies the other', () => {
    const der = { key: Buffer.concat([PKCS8, seed]), format: 'der' as const, type: 'pkcs8' as const };
    const nodeKey = node.createPrivateKey(der);
    const pageKey = page.createPrivateKey(der);
    const nodeSpki = node.createPublicKey(nodeKey).export({ format: 'der', type: 'spki' });
    expect(Buffer.from(page.createPublicKey(pageKey).export({ format: 'der', type: 'spki' }))).toEqual(nodeSpki);

    const body = Buffer.from('member hello');
    const nodeSig = node.sign(null, body, nodeKey);
    expect(Buffer.from(page.sign(null, body, pageKey))).toEqual(nodeSig);
    const pagePub = page.createPublicKey({ key: nodeSpki, format: 'der', type: 'spki' });
    expect(page.verify(null, body, pagePub, nodeSig)).toBe(true);
    expect(page.verify(null, Buffer.from('member hellp'), pagePub, nodeSig)).toBe(false);
    expect(node.verify(null, body, node.createPublicKey({ key: nodeSpki, format: 'der', type: 'spki' }), page.sign(null, body, pageKey))).toBe(true);
  });

  it('takes a public key that is not on the curve, as Node does, and verifies nothing with it', () => {
    const bad = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 0xff)]);
    const body = Buffer.from('x');
    const sig = node.sign(null, body, node.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' }));
    expect(node.verify(null, body, node.createPublicKey({ key: bad, format: 'der', type: 'spki' }), sig)).toBe(false);
    expect(page.verify(null, body, page.createPublicKey({ key: bad, format: 'der', type: 'spki' }), sig)).toBe(false);
  });

  it('keeps randomInt inside its range', () => {
    for (let i = 0; i < 500; i++) {
      const v = page.randomInt(8);
      expect(v >= 0 && v < 8 && Number.isInteger(v)).toBe(true);
      const w = page.randomInt(-3, 3);
      expect(w >= -3 && w < 3).toBe(true);
    }
    expect(page.randomBytes(9)).toHaveLength(9);
  });
});

describe('page Buffer', () => {
  it('encodes and decodes as Node does', () => {
    const samples = ['', 'a', 'lolPing 房間 ✓', 'ÿ\u0000x'];
    for (const s of samples) {
      for (const enc of ['utf8', 'hex', 'base64', 'base64url', 'latin1'] as const) {
        const n = Buffer.from(s, 'utf8');
        expect(PageBuffer.from(s, 'utf8').toString(enc)).toBe(n.toString(enc));
        expect(Buffer.from(PageBuffer.from(n.toString(enc), enc))).toEqual(Buffer.from(n.toString(enc), enc));
      }
    }
    expect(Buffer.from(PageBuffer.from('ZZ==', 'base64'))).toEqual(Buffer.from('ZZ==', 'base64'));
  });

  it('keeps Node\'s memory sharing: subarray and slice are views, typed as Buffer', () => {
    const b = PageBuffer.from([1, 2, 3, 4, 5]);
    const s = b.slice(1, 3);
    s[0] = 9;
    expect(b[1]).toBe(9);
    expect(b.subarray(2)).toBeInstanceOf(PageBuffer);
    expect(PageBuffer.concat([b.subarray(0, 2), PageBuffer.from('ab')]).toString('hex')).toBe('01096162');
    expect(PageBuffer.from([0, 0, 1, 2]).readUInt32BE(0)).toBe(258);
  });
});
