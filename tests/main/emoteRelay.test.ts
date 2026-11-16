import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EmoteTransfer, type BlobKind } from '../../src/main/emoteTransfer';
import { RelayTransport } from '../../src/main/relayTransport';
import { deriveRoomKeys } from '../../src/main/roomCrypto';
import { RoomManager } from '../../src/main/roomManager';
import { makeRoomCode } from '../../src/shared/roomCode';
import { startFakeRelay } from './fixtures/fakeRelay';
import { opusSound } from './fixtures/opusSample';

// Two rooms meeting through a relay on loopback, each with custom emotes and their shared sounds on the wheel, under the
// real relay cap of 5 sends a second. What is measured is how long both sides take to have everything.
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const still = (size: number, seed: number): Uint8Array => {
  const out = new Uint8Array(size).fill(seed);
  out.set([...ascii('RIFF'), ...le32(size - 8), ...ascii('WEBPVP8 '), ...le32(size - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(160), ...le16(120)]);
  return out;
};
const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);

interface Side {
  room: RoomManager;
  transfer: EmoteTransfer;
  got: Map<string, BlobKind>;
  sent: { blob: number; chunk: number };
}

/** `count` full-size stills, each with a full-size sound. `blobs: false` loses every blob part, as a relay that refuses long messages would. */
function side(name: string, url: string, seed: number, count: number, blobs = true): Side {
  const stills = Array.from({ length: count }, (_, i) => still(11_000, seed + i));
  const sounds = Array.from({ length: count }, (_, i) => opusSound(5, seed + i, 55));
  const own = new Map<string, Uint8Array>([...stills, ...sounds].map((b) => [hashOf(b), b]));
  const got = new Map<string, BlobKind>();
  const sent = { blob: 0, chunk: 0 };
  const room = new RoomManager({
    transports: [new RelayTransport({ urls: [url] })], now: Date.now, randomBytes: (n) => randomBytes(n), deriveKeys: deriveRoomKeys,
    appVersion: '0.6.0', profile: () => ({ name, color: 1, rgb: null, limit: 0, nf: [] }),
    resolveTarget: () => ({ displayId: 1, width: 1000, height: 500 }),
    announceEmotes: () => stills.map(hashOf), announceSounds: () => sounds.map(hashOf),
  });
  const transfer = new EmoteTransfer({
    now: Date.now, enabled: () => true, have: (h) => got.has(h), blob: (h) => own.get(h) ?? null,
    announced: () => stills.map(hashOf), announcedSounds: () => sounds.map(hashOf), put: (h, _b, kind) => void got.set(h, kind),
    routeOf: (p) => room.routeKind(p), sendToLan: (p, b) => room.sendToLan(p, b),
    broadcastShared: (body) => {
      if (body.t === 'blob' || body.t === 'chunk') sent[body.t]++;
      if (body.t !== 'blob' || blobs) room.broadcastShared(body);
    },
    spareSharedToken: (keep) => room.spareSharedToken(keep),
  });
  room.on('emotes', (p: string, h: string[], s: string[]) => transfer.announced(p, h, s));
  room.on('want', (w: Parameters<EmoteTransfer['onWant']>[0], via: 'lan' | 'shared') => transfer.onWant(w, via));
  room.on('chunk', (c: Parameters<EmoteTransfer['onChunk']>[0]) => transfer.onChunk(c));
  room.on('blob', (c: Parameters<EmoteTransfer['onBlob']>[0]) => transfer.onBlob(c));
  room.on('memberGone', (p: string) => transfer.memberGone(p));
  return { room, transfer, got, sent };
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let relay: Awaited<ReturnType<typeof startFakeRelay>> | null = null;
let sides: Side[] = [];
afterEach(async () => {
  for (const s of sides) {
    s.transfer.stop();
    s.room.quit();
  }
  sides = [];
  await relay?.close();
  relay = null;
});

describe('custom emotes and their sounds over a relay', () => {
  it('fills both sides’ full wheels, nine stills and nine sounds each way, in well under half a minute', async () => {
    relay = await startFakeRelay();
    const a = side('Ana', relay.url, 1, 9);
    const b = side('Ben', relay.url, 100, 9);
    sides.push(a, b);
    const code = makeRoomCode(randomBytes(9));
    await Promise.all([a.room.join(code), b.room.join(code)]);
    await until(() => a.got.size === 18 && b.got.size === 18, 25_000);
    expect([...a.got.values()].filter((k) => k === 'sound')).toHaveLength(9);
    expect(a.sent.chunk + b.sent.chunk).toBe(0); // blob parts carried all of it
    expect(a.sent.blob).toBe(9 * 2 + 9 * 3); // two parts for an 11 KB still, three for a full sound
  }, 40_000);

  it('still arrives in chunks when the long messages are lost', async () => {
    relay = await startFakeRelay();
    const a = side('Ana', relay.url, 1, 1, false);
    const b = side('Ben', relay.url, 100, 0);
    sides.push(a, b);
    const code = makeRoomCode(randomBytes(9));
    await Promise.all([a.room.join(code), b.room.join(code)]);
    await until(() => b.got.size === 2, 40_000);
    expect(a.sent.chunk).toBeGreaterThan(0);
    expect([...b.got.values()].sort()).toEqual(['sound', 'still']);
  }, 60_000);
});
