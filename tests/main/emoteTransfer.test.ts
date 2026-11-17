import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSEMBLY_TIMEOUT_MS, BLOB_PART_BYTES, EMOTE_CHUNK_BYTES, EmoteTransfer, LAN_TOTAL_CHUNKS_PER_TICK, MAX_ASSEMBLIES, MAX_PENDING_BYTES,
  REASKS_MAX, type BlobKind, type EmoteTransferDeps,
} from '../../src/main/emoteTransfer';
import { EMOTE_CHUNKS_MAX, EMOTE_NEED_MAX, SOUND_CHUNKS_MAX, type BlobMsg, type ChunkMsg, type WantMsg } from '../../src/shared/roomProtocol';
import { muxWebpAnimation } from '../../src/shared/webpAnim';
import { opusSound } from './fixtures/opusSample';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A lossy WebP still whose headers are all the checks read; `size` lets a test build a multi-chunk file. */
const still = (size = 600, seed = 7): Uint8Array => {
  const out = new Uint8Array(size).fill(seed);
  out.set([...ascii('RIFF'), ...le32(size - 8), ...ascii('WEBPVP8 '), ...le32(size - 20), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(160), ...le16(120)]);
  return out;
};
const hashOf = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 32);

/** An 8 x 6 lossy WebP frame, as libwebp writes one. */
const FRAME = Uint8Array.from(Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoIAAYAAsBMJaACdLoAA5gA/uwmX18AU9Uf/OJfyR+gXaAAAAA=', 'base64'));
/**
 * A shared animation that passes its checks: a few real frames, then an XMP chunk of `pad` bytes, which readers skip, to
 * make it as many chunks long as a test needs. `seed` makes each one different.
 */
function animFile(pad = 0, seed = 1): Uint8Array {
  const anim = muxWebpAnimation([{ file: FRAME, ms: 100 }, { file: FRAME, ms: 100 + seed }], 8, 6) as Uint8Array;
  const extra = Uint8Array.from([...ascii('XMP '), ...le32(pad), ...new Uint8Array(pad).fill(seed), ...(pad & 1 ? [0] : [])]);
  const out = new Uint8Array(anim.length + extra.length);
  out.set(anim);
  out.set(extra, anim.length);
  out.set(le32(out.length - 8), 4);
  return out;
}
/** Every chunk of `bytes`, as the announcer sends them. */
const chunksOf = (h: string, bytes: Uint8Array): ChunkMsg[] => {
  const n = Math.ceil(bytes.length / EMOTE_CHUNK_BYTES);
  return Array.from({ length: n }, (_, i) => chunkOf(h, i, n, bytes.subarray(i * EMOTE_CHUNK_BYTES, (i + 1) * EMOTE_CHUNK_BYTES)));
};

/** The member whose custom emote we are receiving. */
const ANNOUNCER = 'aaaaaaaaaaaaaaaa';
/** Long enough for the first want's two re-asks, 3 s apart. */
const REASK_MS_TWICE = 6200;
/** The member receiving our still, in the serving tests. */
const REQUESTER = 'bbbbbbbbbbbbbbbb';

const chunkOf = (h: string, i: number, n: number, part: Uint8Array, peer = ANNOUNCER): ChunkMsg =>
  ({ peer, seq: 1, ts: 0, t: 'chunk', h, i, n, b: Buffer.from(part).toString('base64') });
const blobOf = (h: string, i: number, n: number, part: Uint8Array, peer = ANNOUNCER): BlobMsg =>
  ({ peer, seq: 1, ts: 0, t: 'blob', h, i, n, b: Buffer.from(part).toString('base64') });
const wantOf = (h: string, need: number[]): WantMsg =>
  ({ peer: REQUESTER, seq: 1, ts: 0, t: 'want', to: ANNOUNCER, h, need });

type Out = { kind: 'lan' | 'shared'; to?: string; body: Record<string, unknown> };

/** Fake room + library. The clock runs on vitest's fake timers, so tick() and the re-ask spacing are driven by the test. */
function harness() {
  const out: Out[] = [];
  const files = new Map<string, Uint8Array>();
  const cache = new Map<string, Uint8Array>();
  const routes = new Map<string, 'lan' | 'shared' | null>();
  const kinds = new Map<string, BlobKind>(); // what each cached hash was stored as
  const reads = { still: 0 };
  const state = { enabled: true, tokens: 10, announced: [] as string[], sounds: [] as string[], anims: [] as string[] };
  const deps: EmoteTransferDeps = {
    now: Date.now,
    have: (h) => files.has(h) || cache.has(h),
    blob: (h) => {
      reads.still++;
      return files.get(h) ?? null;
    },
    announced: () => state.announced,
    announcedSounds: () => state.sounds,
    announcedAnims: () => state.anims,
    enabled: () => state.enabled,
    put: (h, b, kind) => {
      cache.set(h, b);
      kinds.set(h, kind);
    },
    routeOf: (peer) => routes.get(peer) ?? null,
    sendToLan: (peer, body) => void out.push({ kind: 'lan', to: peer, body }),
    broadcastShared: (body) => void out.push({ kind: 'shared', body }),
    spareSharedToken: (keep) => (state.tokens >= keep + 1 ? (state.tokens--, true) : false),
  };
  const t = new EmoteTransfer(deps);
  return {
    t, out, cache, kinds, files, routes, reads,
    setEnabled: (on: boolean) => (state.enabled = on),
    setTokens: (n: number) => (state.tokens = n),
    setAnnounced: (list: string[]) => (state.announced = list),
    setSounds: (list: string[]) => (state.sounds = list),
    setAnims: (list: string[]) => (state.anims = list),
  };
}

/** The sender's chunks for `h` assembled back into whole bytes, the way a receiver would. */
function sentFile(out: Out[], h: string): Uint8Array {
  const chunks = out.filter((o) => o.body.t === 'chunk' && o.body.h === h);
  const n = chunks[0].body.n as number;
  const parts = new Map<number, Uint8Array>(chunks.map((c) => [c.body.i as number, Buffer.from(c.body.b as string, 'base64')]));
  const full = new Uint8Array(n * EMOTE_CHUNK_BYTES);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const part = parts.get(i)!;
    full.set(part, at);
    at += part.length;
  }
  return full.subarray(0, at);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('EmoteTransfer: receiving', () => {
  it('prefetches an announced hash it does not have, then reassembles the still into the cache', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES + 10); // two chunks
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    expect(h.out).toEqual([{ kind: 'lan', to: ANNOUNCER, body: { t: 'want', to: ANNOUNCER, h: hash, need: [] } }]);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect([...h.cache.keys()]).toEqual([hash]);
    expect(h.cache.get(hash)).toEqual(bytes);
    expect(h.t.stats.assembling).toBe(0);
  });

  it('never asks for what is already here', () => {
    const h = harness();
    const bytes = still();
    h.files.set(hashOf(bytes), bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(bytes)]);
    expect(h.out).toHaveLength(0);
  });

  it('ignores chunks from a member that never announced the hash, and keeps only the true content', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES), 'cccccccccccccccc')); // not an announcer
    expect(h.cache.size).toBe(0);

    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    const wrong = still(EMOTE_CHUNK_BYTES * 2, 9);
    h.t.onChunk(chunkOf(hash, 1, 2, wrong.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.size).toBe(0); // the hash check refuses the substituted bytes, and the failed assembly is gone

    h.t.announced(ANNOUNCER, [hash]); // the next presence starts over
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.get(hash)).toEqual(bytes);
  });

  it('drops an assembly whose sender contradicts itself about the chunk count', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 3, bytes.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.t.stats.assembling).toBe(0);
    expect(h.cache.size).toBe(0);
  });

  it('ignores everything while Show friends’ custom emotes is off', () => {
    const h = harness();
    h.setEnabled(false);
    const bytes = still();
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 1, bytes));
    expect(h.out).toHaveLength(0);
    expect(h.cache.size).toBe(0);
  });

  it('stops at the assembly cap and at the pending-byte cap', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const seen = new Set<string>();
    for (let n = 0; n < MAX_ASSEMBLIES + 3 && seen.size < MAX_ASSEMBLIES + 1; n++) {
      const hash = hashOf(still(600, n + 1));
      seen.add(hash);
      h.t.announced(ANNOUNCER, [hash]);
    }
    expect(h.t.stats.assembling).toBe(MAX_ASSEMBLIES);

    const h2 = harness();
    h2.routes.set(ANNOUNCER, 'lan');
    const first = hashOf(still(400_000));
    h2.t.announced(ANNOUNCER, [first]); // waits for its second chunk, holding 200 KB of the 256 KB budget
    h2.t.onChunk(chunkOf(first, 0, 2, still(400_000).subarray(0, 200_000)));
    const other = hashOf(still(400_000, 3));
    h2.t.announced(ANNOUNCER, [other]); // an empty assembly may wait; its bytes may not
    h2.t.onChunk(chunkOf(other, 0, 2, still(400_000, 3).subarray(0, 200_000))); // 400 KB pending would pass the cap
    expect(h2.t.stats.assembling).toBe(2);
    expect(h2.cache.size).toBe(0); // nothing entered the over-budget assembly
  });

  it('re-asks three times with the missing indexes, then waits for the next presence', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 3);
    const hash = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.out.length = 0;
    h.t.onChunk(chunkOf(hash, 0, 3, bytes.subarray(0, EMOTE_CHUNK_BYTES)));

    await vi.advanceTimersByTimeAsync(3000);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(1);
    expect(h.out.at(-1)!.body).toMatchObject({ t: 'want', to: ANNOUNCER, h: hash, need: [1, 2] });

    for (let n = 0; n < REASKS_MAX - 1; n++) {
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.out.at(-1)!.body.t).toBe('want');
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.t.stats.assembling).toBe(0); // gave up
    h.out.length = 0;
    h.t.announced(ANNOUNCER, [hash]); // the next presence starts over
    expect(h.out.some((o) => o.body.t === 'want')).toBe(true);
  });

  it('re-asks a want that never got a chunk, then gives up the same way', async () => {
    const h = harness();
    const hash = hashOf(still());
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    h.out.length = 0;
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(0); // nothing for almost three seconds
    await vi.advanceTimersByTimeAsync(1);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.t.stats.assembling).toBe(0); // three re-asks, no chunks: the next presence tries again
  });

  it('sends wants over relays only while five ping tokens stay, the rest on later ticks', async () => {
    const h = harness();
    const hashes = Array.from({ length: 9 }, (_, n) => hashOf(still(600, n + 1))); // a full wheel, met on joining
    h.routes.set(ANNOUNCER, 'shared');
    h.setTokens(7); // two wants' worth above the keep mark
    h.t.announced(ANNOUNCER, hashes);
    expect(h.out.filter((o) => o.body.t === 'want')).toHaveLength(2); // the rest wait: pings keep their five
    expect(h.t.stats.assembling).toBe(9);

    h.setTokens(100);
    await vi.advanceTimersByTimeAsync(100);
    const asked = h.out.filter((o) => o.body.t === 'want').map((o) => o.body.h);
    expect(new Set(asked)).toEqual(new Set(hashes)); // each held-back want went once, not as a re-ask
    expect(asked).toHaveLength(9);
  });

  it('drops an assembly after its timeout, and when the announcer leaves', async () => {
    const h = harness();
    const hash = hashOf(still(EMOTE_CHUNK_BYTES * 2));
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hash]);
    await vi.advanceTimersByTimeAsync(ASSEMBLY_TIMEOUT_MS + 1000);
    expect(h.t.stats.assembling).toBe(0);

    h.t.announced(ANNOUNCER, [hash]);
    h.t.memberGone(ANNOUNCER);
    expect(h.t.stats.assembling).toBe(0);
  });
});

describe('EmoteTransfer: serving', () => {
  it('answers a want over LAN, chunk by chunk, until the whole still is sent', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2 + 5);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'lan')).toHaveLength(2); // two chunks per requester per tick
    await vi.advanceTimersByTimeAsync(100);
    expect(sentFile(h.out, hash)).toEqual(bytes);
    expect(h.t.stats.sending).toBe(0);
  });

  it('sends only the asked indexes', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, [2]));
    await vi.advanceTimersByTimeAsync(100);
    const chunks = h.out.filter((o) => o.body.t === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toMatchObject({ t: 'chunk', h: hash, i: 2, n: 4 });
  });

  it('never serves a hash that is not in our own current announcement', async () => {
    const h = harness();
    const bytes = still();
    h.files.set(hashOf(bytes), bytes);
    h.setAnnounced([]);
    h.t.onWant(wantOf(hashOf(bytes), []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out).toHaveLength(0);
  });

  it('broadcasts relay chunks only while five ping tokens stay, and stops when the hash leaves the wheel', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 6);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'shared');
    h.setAnnounced([hash]);
    h.setTokens(6); // one chunk's worth above the keep mark
    h.out.length = 0;

    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'shared')).toHaveLength(1); // a second would dip below the keep mark

    h.setAnnounced([]); // the emote left our wheel
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.kind === 'shared')).toHaveLength(1);
    expect(h.t.stats.sending).toBe(0);
  });

  it('merges a second want for the same hash instead of resending what is queued', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.out.length = 0;

    h.t.onWant(wantOf(hash, [1]));
    h.t.onWant(wantOf(hash, [1, 3]));
    await vi.advanceTimersByTimeAsync(100);
    const chunks = h.out.filter((o) => o.body.t === 'chunk');
    expect(chunks.map((c) => c.body.i).sort()).toEqual([1, 3]); // index 1 queued once
  });
});

describe('EmoteTransfer: audit regressions', () => {
  it('serves nothing while Show friends’ custom emotes is off, and drops pending work on the next tick', async () => {
    const h = harness();
    const bytes = still();
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    h.setEnabled(false);
    h.t.onWant(wantOf(hash, [])); // an attacker pulling at our stills while the switch is off: nothing leaves
    expect(h.out).toHaveLength(0);
    expect(h.reads.still).toBe(0);

    h.setEnabled(true);
    h.t.onWant(wantOf(hash, []));
    h.setEnabled(false);
    const announced2 = hashOf(still(EMOTE_CHUNK_BYTES * 3));
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [announced2]); // a pending assembly...
    await vi.advanceTimersByTimeAsync(100);
    expect(h.t.stats).toEqual({ assembling: 0, sending: 0 }); // ...is dropped, not paused, and no re-ask wants go out
  });

  it('a straggler chunk for a still already stored opens no zombie assembly', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 2);
    const hash = hashOf(bytes);
    h.cache.set(hash, bytes); // already here
    h.t.onChunk(chunkOf(hash, 0, 2, bytes.subarray(0, EMOTE_CHUNK_BYTES)));
    expect(h.t.stats.assembling).toBe(0);
  });

  it('caps the whole LAN egress at LAN_TOTAL_CHUNKS_PER_TICK, however many requesters ask', async () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 6);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.setAnnounced([hash]);
    for (let n = 0; n < 6; n++) {
      const peer = `${n}`.repeat(16);
      h.routes.set(peer, 'lan');
      h.t.onWant({ ...wantOf(hash, []), peer });
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.body.t === 'chunk')).toHaveLength(LAN_TOTAL_CHUNKS_PER_TICK);
  });

  it('reads the still from its source once per queue, whatever the want flood', () => {
    const h = harness();
    const bytes = still(EMOTE_CHUNK_BYTES * 4);
    const hash = hashOf(bytes);
    h.files.set(hash, bytes);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hash]);
    for (let n = 0; n < 50; n++) h.t.onWant(wantOf(hash, []));
    expect(h.reads.still).toBe(1);
  });
});

describe('EmoteTransfer: shared sounds', () => {
  /** Every chunk of `bytes`, as its announcer would send them. */
  const deliver = (h: ReturnType<typeof harness>, bytes: Uint8Array, peer = ANNOUNCER): void => {
    const n = Math.ceil(bytes.length / EMOTE_CHUNK_BYTES);
    for (let i = 0; i < n; i++) h.t.onChunk(chunkOf(hashOf(bytes), i, n, bytes.subarray(i * EMOTE_CHUNK_BYTES, (i + 1) * EMOTE_CHUNK_BYTES), peer));
  };

  it('prefetches an announced emote’s sound after its still, and stores each as what it is', () => {
    const h = harness();
    const image = still();
    const sound = opusSound(1);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(image)], [hashOf(sound)]);
    expect(h.out.map((o) => o.body.h)).toEqual([hashOf(image), hashOf(sound)]);
    deliver(h, image);
    deliver(h, sound);
    expect(h.cache.get(hashOf(sound))).toEqual(sound);
    expect([h.kinds.get(hashOf(image)), h.kinds.get(hashOf(sound))]).toEqual(['still', 'sound']);
    expect(h.t.stats.assembling).toBe(0);
  });

  it('says which sound a member announced for an emote, until their presence or their leaving says otherwise', () => {
    const h = harness();
    const [a, b, sound] = [hashOf(still(600, 1)), hashOf(still(600, 2)), hashOf(opusSound(1))];
    h.t.announced(ANNOUNCER, [a, b], ['', sound]);
    expect(h.t.soundFor(ANNOUNCER, a)).toBeNull();
    expect(h.t.soundFor(ANNOUNCER, b)).toBe(sound);
    expect(h.t.soundFor(REQUESTER, b)).toBeNull(); // the same image on another member's wheel has that member's sound, or none
    h.t.announced(ANNOUNCER, [a, b]);
    expect(h.t.soundFor(ANNOUNCER, b)).toBeNull();
    h.t.announced(ANNOUNCER, [a, b], ['', sound]);
    h.t.memberGone(ANNOUNCER);
    expect(h.t.soundFor(ANNOUNCER, b)).toBeNull();
  });

  it('keeps a finished sound only when it is Ogg Opus of a sound’s length', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const image = still(600, 3);
    const long = opusSound(60, 1, 2); // small on the wire, a minute once decoded
    const notOpus = still(700, 4); // announced as a sound, but an image
    h.t.announced(ANNOUNCER, [hashOf(image), hashOf(still(600, 5))], [hashOf(long), hashOf(notOpus)]);
    deliver(h, long);
    deliver(h, notOpus);
    expect(h.cache.size).toBe(0);
    expect(h.t.stats.assembling).toBe(2); // the two stills are still wanted; both sounds were dropped
  });

  it('takes a sound of up to SOUND_CHUNKS_MAX chunks, and no still that claims more than a still can have', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const sound = opusSound(5, 2, 60); // a full-size shared sound
    expect(Math.ceil(sound.length / EMOTE_CHUNK_BYTES)).toBeGreaterThan(EMOTE_CHUNKS_MAX);
    expect(Math.ceil(sound.length / EMOTE_CHUNK_BYTES)).toBeLessThanOrEqual(SOUND_CHUNKS_MAX);
    const image = still(600, 6);
    h.t.announced(ANNOUNCER, [hashOf(image)], [hashOf(sound)]);
    deliver(h, sound);
    expect(h.cache.get(hashOf(sound))).toEqual(sound);
    h.t.onChunk(chunkOf(hashOf(image), 0, EMOTE_CHUNKS_MAX + 1, image));
    expect(h.cache.has(hashOf(image))).toBe(false);
    h.t.onChunk(chunkOf(hashOf(image), 0, 1, image)); // the oversized claim opened nothing that contradicts this one
    expect(h.cache.get(hashOf(image))).toEqual(image);
  });

  it('lets the first announcement decide what a hash is when two members disagree', () => {
    const h = harness();
    const OTHER = 'cccccccccccccccc';
    h.routes.set(ANNOUNCER, 'lan');
    h.routes.set(OTHER, 'lan');
    const sound = opusSound(1, 7);
    h.t.announced(ANNOUNCER, [hashOf(still(600, 8))], [hashOf(sound)]);
    h.t.announced(OTHER, [hashOf(sound)]); // the same bytes, called a still
    deliver(h, sound, OTHER);
    expect(h.cache.size).toBe(0);
    deliver(h, sound);
    expect(h.kinds.get(hashOf(sound))).toBe('sound');
  });

  it('serves our own shared sound to a want, and stops once the hash leaves our announcement', async () => {
    const h = harness();
    const sound = opusSound(2, 9);
    const hash = hashOf(sound);
    h.files.set(hash, sound);
    h.routes.set(REQUESTER, 'lan');
    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.out).toHaveLength(0); // not announced: not served

    h.setSounds([hash]);
    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.filter((o) => o.body.t === 'chunk')).toHaveLength(2);
    h.setSounds([]); // the sound was replaced or removed while its chunks were queued
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.out.filter((o) => o.body.t === 'chunk')).toHaveLength(2);
    expect(h.t.stats.sending).toBe(0);

    h.setSounds([hash]);
    h.t.onWant(wantOf(hash, []));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sentFile(h.out.slice(2), hash)).toEqual(sound);
  });
});

describe('EmoteTransfer: blob parts over relays', () => {
  const partsOf = (bytes: Uint8Array): Uint8Array[] =>
    Array.from({ length: Math.ceil(bytes.length / BLOB_PART_BYTES) }, (_, i) => bytes.subarray(i * BLOB_PART_BYTES, (i + 1) * BLOB_PART_BYTES));

  it('says blob parts are welcome when it asks over a relay, never over LAN, and assembles them', () => {
    const h = harness();
    const sound = opusSound(5, 4, 60); // three parts
    const image = still(600, 4);
    h.routes.set(ANNOUNCER, 'shared');
    h.routes.set(REQUESTER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(image)], [hashOf(sound)]);
    h.t.announced(REQUESTER, [hashOf(still(600, 5))]);
    expect(h.out.map((o) => [o.kind, o.body.big])).toEqual([['shared', true], ['shared', true], ['lan', undefined]]);

    const parts = partsOf(sound);
    expect(parts).toHaveLength(3);
    parts.forEach((part, i) => h.t.onBlob(blobOf(hashOf(sound), i, 3, part)));
    expect(h.cache.get(hashOf(sound))).toEqual(sound);
    expect(h.kinds.get(hashOf(sound))).toBe('sound');
  });

  it('finishes from whichever arrives whole first, chunks or blob parts, and checks the result the same way', () => {
    const h = harness();
    const image = still(EMOTE_CHUNK_BYTES * 2, 6);
    const hash = hashOf(image);
    h.routes.set(ANNOUNCER, 'shared');
    h.t.announced(ANNOUNCER, [hash]);
    h.t.onChunk(chunkOf(hash, 0, 2, image.subarray(0, EMOTE_CHUNK_BYTES))); // someone on an older app asked too
    h.t.onBlob(blobOf(hash, 0, 1, image));
    expect(h.cache.get(hash)).toEqual(image);
    h.t.onChunk(chunkOf(hash, 1, 2, image.subarray(EMOTE_CHUNK_BYTES))); // the straggler opens nothing
    expect(h.t.stats.assembling).toBe(0);

    const wrong = still(EMOTE_CHUNK_BYTES * 2, 7);
    h.t.announced(ANNOUNCER, [hashOf(wrong)]);
    h.t.onBlob(blobOf(hashOf(wrong), 0, 1, image)); // not the bytes the hash names
    expect(h.cache.has(hashOf(wrong))).toBe(false);
  });

  it('answers a relay want that welcomes blob parts with those, three for a full sound, and an older want with chunks', async () => {
    const h = harness();
    const sound = opusSound(5, 8, 60);
    const hash = hashOf(sound);
    h.files.set(hash, sound);
    h.routes.set(REQUESTER, 'shared');
    h.setSounds([hash]);
    h.setTokens(1000);
    h.t.onWant({ ...wantOf(hash, []), big: true });
    await vi.advanceTimersByTimeAsync(1000);
    const sent = h.out.filter((o) => o.body.h === hash);
    expect(sent.map((o) => o.body.t)).toEqual(['blob', 'blob', 'blob']);
    expect(new Uint8Array(Buffer.concat(sent.map((o) => Buffer.from(o.body.b as string, 'base64'))))).toEqual(sound);

    h.out.length = 0;
    h.t.onWant(wantOf(hash, [])); // an app that doesn't read blob parts
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.out.every((o) => o.body.t === 'chunk')).toBe(true);
    expect(sentFile(h.out, hash)).toEqual(sound);
  });

  it('answers a LAN want in chunks even when it welcomes blob parts: they fit no LAN packet', async () => {
    const h = harness();
    const image = still(EMOTE_CHUNK_BYTES * 2, 9);
    h.files.set(hashOf(image), image);
    h.routes.set(REQUESTER, 'lan');
    h.setAnnounced([hashOf(image)]);
    h.t.onWant({ ...wantOf(hashOf(image), []), big: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.out.map((o) => o.body.t)).toEqual(['chunk', 'chunk']);
  });

  it('does not re-ask while the announcer is sending something else, then asks once it has gone quiet', async () => {
    const h = harness();
    const first = still(600, 10);
    const second = still(600, 11);
    h.routes.set(ANNOUNCER, 'shared');
    h.setTokens(1000);
    h.t.announced(ANNOUNCER, [hashOf(first), hashOf(second), hashOf(still(600, 12))]);
    h.out.length = 0;
    // The announcer works through its queue: a part of something arrives every two seconds, never of the third still.
    await vi.advanceTimersByTimeAsync(2000);
    h.t.onBlob(blobOf(hashOf(first), 0, 1, first));
    await vi.advanceTimersByTimeAsync(2000);
    h.t.onBlob(blobOf(hashOf(second), 0, 1, second));
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.out).toHaveLength(0); // six seconds without its own bytes, and not one want spent

    await vi.advanceTimersByTimeAsync(1100);
    expect(h.out.map((o) => o.body)).toEqual([expect.objectContaining({ t: 'want', need: [], big: true })]);
  });

  it('falls back to chunks from the second re-ask, in case the relays refuse the longer messages', async () => {
    const h = harness();
    const image = still(EMOTE_CHUNK_BYTES * 2, 13);
    const hash = hashOf(image);
    h.routes.set(ANNOUNCER, 'shared');
    h.setTokens(1000);
    h.t.announced(ANNOUNCER, [hash]);
    await vi.advanceTimersByTimeAsync(REASK_MS_TWICE);
    expect(h.out.map((o) => o.body.big)).toEqual([true, true, undefined]);
    h.t.onChunk(chunkOf(hash, 0, 2, image.subarray(0, EMOTE_CHUNK_BYTES)));
    h.t.onChunk(chunkOf(hash, 1, 2, image.subarray(EMOTE_CHUNK_BYTES)));
    expect(h.cache.get(hash)).toEqual(image);
  });
});

describe('EmoteTransfer: shared animations', () => {
  const stillHash = 'c'.repeat(32);

  it('fetches a member’s animation once its anims message names it, in more chunks than a still or sound may have', () => {
    const h = harness();
    const anim = animFile(40_000); // 54 chunks
    const animHash = hashOf(anim);
    h.routes.set(ANNOUNCER, 'lan');
    h.files.set(stillHash, still());
    h.t.announced(ANNOUNCER, [stillHash]);
    h.t.announcedAnims(ANNOUNCER, [[stillHash, animHash]]);
    expect(h.out.filter((o) => o.body.t === 'want').map((o) => o.body.h)).toEqual([animHash]);
    for (const c of chunksOf(animHash, anim)) h.t.onChunk(c);
    expect(h.cache.get(animHash)).toEqual(anim);
    expect(h.kinds.get(animHash)).toBe('anim');
    expect(h.t.animFor(ANNOUNCER, stillHash)).toBe(animHash);
  });

  it('drops a finished animation that fails its checks, such as a still WebP', () => {
    const h = harness();
    const bytes = still(2000);
    const fake = hashOf(bytes);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announcedAnims(ANNOUNCER, [[stillHash, fake]]);
    for (const c of chunksOf(fake, bytes)) h.t.onChunk(c);
    expect(h.cache.has(fake)).toBe(false);
  });

  it('keeps a member’s animations across presences for the stills it still announces', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const other = 'd'.repeat(32);
    h.t.announced(ANNOUNCER, [stillHash, other]);
    h.t.announcedAnims(ANNOUNCER, [[stillHash, 'e'.repeat(32)], [other, 'f'.repeat(32)]]);
    h.t.announced(ANNOUNCER, [stillHash]);
    expect(h.t.animFor(ANNOUNCER, stillHash)).toBe('e'.repeat(32));
    expect(h.t.animFor(ANNOUNCER, other)).toBeNull();
  });

  it('assembles at most two animations at once; the third waits for the next presence', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    const pairs: [string, string][] = [1, 2, 3].map((n) => [String(n).repeat(32), hashOf(animFile(0, n))]);
    h.t.announced(ANNOUNCER, pairs.map(([s]) => s));
    h.out.length = 0;
    h.t.announcedAnims(ANNOUNCER, pairs);
    expect(h.out.filter((o) => o.body.t === 'want').map((o) => o.body.h)).toEqual([pairs[0][1], pairs[1][1]]);
    for (const c of chunksOf(pairs[0][1], animFile(0, 1))) h.t.onChunk(c);
    h.out.length = 0;
    h.t.announced(ANNOUNCER, pairs.map(([s]) => s)); // the next presence: one is here, so the third may start
    expect(h.out.filter((o) => o.body.t === 'want').map((o) => o.body.h)).toEqual([pairs[2][1]]);
  });

  it('serves our own animation to a member who asks for it, and nothing we don’t announce', () => {
    const h = harness();
    const anim = animFile(5000);
    const animHash = hashOf(anim);
    h.files.set(animHash, anim);
    h.routes.set(REQUESTER, 'lan');
    h.t.onWant(wantOf(animHash, []));
    vi.advanceTimersByTime(1000);
    expect(h.out).toHaveLength(0);
    h.setAnims([animHash]);
    h.t.onWant(wantOf(animHash, []));
    vi.advanceTimersByTime(2000);
    expect(sentFile(h.out, animHash)).toEqual(anim);
  });

  it('asks again for at most 64 of an animation’s missing chunks at a time', () => {
    const h = harness();
    const anim = animFile(100_000); // 134 chunks
    const animHash = hashOf(anim);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announcedAnims(ANNOUNCER, [[stillHash, animHash]]);
    h.t.onChunk(chunksOf(animHash, anim)[0]);
    h.out.length = 0;
    vi.advanceTimersByTime(3200);
    const want = h.out.find((o) => o.body.t === 'want');
    expect((want?.body.need as number[]).length).toBe(EMOTE_NEED_MAX);
    expect((want?.body.need as number[])[0]).toBe(1);
  });

  it('refuses blob parts past what a still or sound can have, and takes an animation’s', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'shared');
    const s = still(600);
    h.t.announced(ANNOUNCER, [hashOf(s)]);
    h.t.onBlob(blobOf(hashOf(s), 0, 4, s.subarray(0, 300)));
    expect(h.t.stats.assembling).toBe(1); // only the prefetch's own assembly: the part was refused
    const anim = animFile(20_000);
    const animHash = hashOf(anim);
    h.t.announcedAnims(ANNOUNCER, [[hashOf(s), animHash]]);
    const n = Math.ceil(anim.length / BLOB_PART_BYTES);
    expect(n).toBeGreaterThan(3);
    for (let i = 0; i < n; i++) h.t.onBlob(blobOf(animHash, i, n, anim.subarray(i * BLOB_PART_BYTES, (i + 1) * BLOB_PART_BYTES)));
    expect(h.cache.get(animHash)).toEqual(anim);
  });

  it('counts animations in the sync progress', () => {
    const h = harness();
    h.routes.set(ANNOUNCER, 'lan');
    h.files.set(stillHash, still());
    h.t.announced(ANNOUNCER, [stillHash]);
    h.t.announcedAnims(ANNOUNCER, [[stillHash, hashOf(animFile())]]);
    expect(h.t.progress()).toEqual({ have: 1, total: 2 });
    expect(h.t.progressOf(ANNOUNCER)).toEqual({ have: 1, total: 2 });
  });
});

describe('EmoteTransfer: progress and Sync now', () => {
  it('counts every still and shared sound the others announce once, and how many are here', () => {
    const h = harness();
    const OTHER = 'cccccccccccccccc';
    const [a, b] = [still(600, 20), still(600, 21)];
    const sound = opusSound(1, 20);
    h.routes.set(ANNOUNCER, 'lan');
    h.routes.set(OTHER, 'lan');
    expect(h.t.progress()).toEqual({ have: 0, total: 0 });
    h.t.announced(ANNOUNCER, [hashOf(a), hashOf(b)], [hashOf(sound), '']);
    h.t.announced(OTHER, [hashOf(a)]); // the same image on two wheels is one file
    expect(h.t.progress()).toEqual({ have: 0, total: 3 });
    h.t.onChunk(chunkOf(hashOf(a), 0, 1, a));
    h.t.onChunk(chunkOf(hashOf(sound), 0, 1, sound));
    expect(h.t.progress()).toEqual({ have: 2, total: 3 });
    h.t.memberGone(ANNOUNCER);
    expect(h.t.progress()).toEqual({ have: 1, total: 1 });
    h.setEnabled(false);
    expect(h.t.progress()).toBeNull(); // nothing is fetched while the switch is off
  });

  it('asks again at once for what had been given up, and from the start for what is under way', async () => {
    const h = harness();
    const [a, b] = [still(EMOTE_CHUNK_BYTES * 2, 22), still(600, 23)];
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(a), hashOf(b)]);
    h.t.onChunk(chunkOf(hashOf(a), 0, 2, a.subarray(0, EMOTE_CHUNK_BYTES)));
    await vi.advanceTimersByTimeAsync(3000 * (REASKS_MAX + 2)); // both gave up: nothing more until the next presence
    expect(h.t.stats.assembling).toBe(0);
    h.out.length = 0;

    h.t.resync();
    expect(h.out.map((o) => o.body)).toEqual([
      expect.objectContaining({ t: 'want', h: hashOf(a), need: [] }), expect.objectContaining({ t: 'want', h: hashOf(b), need: [] }),
    ]);
    h.t.onChunk(chunkOf(hashOf(b), 0, 1, b));
    h.out.length = 0;
    h.t.resync(); // one is here now; the other is under way and is asked for again on the next tick
    await vi.advanceTimersByTimeAsync(100);
    expect(h.out.map((o) => o.body.h)).toEqual([hashOf(a)]);
  });
});

describe('EmoteTransfer: a LAN that carries packets one way', () => {
  it('asks a silent LAN member through the relays on the first re-ask, welcoming blob parts, and takes the answer from there', async () => {
    const h = harness();
    const image = still(600, 30);
    h.routes.set(ANNOUNCER, 'lan');
    h.setTokens(1000);
    h.t.announced(ANNOUNCER, [hashOf(image)]);
    expect(h.out.map((o) => o.kind)).toEqual(['lan']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.out.map((o) => [o.kind, o.body.big])).toEqual([['lan', undefined], ['shared', true]]);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.out.map((o) => o.kind)).toEqual(['lan', 'shared', 'lan', 'shared']); // both ways in turn until it gives up
    h.t.onBlob(blobOf(hashOf(image), 0, 1, image)); // the relay's answer
    expect(h.cache.get(hashOf(image))).toEqual(image);
  });

  it('answers a want on the path it arrived by, whatever path we would reach the asker on', async () => {
    const h = harness();
    const image = still(600, 31);
    h.files.set(hashOf(image), image);
    h.setAnnounced([hashOf(image)]);
    h.setTokens(1000);
    h.routes.set(REQUESTER, 'lan'); // we hear them on LAN, but they asked through a relay: our LAN packets don't reach them
    h.t.onWant({ ...wantOf(hashOf(image), []), big: true }, 'shared');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.out.map((o) => [o.kind, o.body.t])).toEqual([['shared', 'blob']]);

    h.out.length = 0;
    h.routes.set(REQUESTER, 'shared');
    h.t.onWant(wantOf(hashOf(image), []), 'lan'); // and the other way round
    await vi.advanceTimersByTimeAsync(200);
    expect(h.out.map((o) => [o.kind, o.body.t])).toEqual([['lan', 'chunk']]);
  });

  it('counts what is here of one member’s wheel', () => {
    const h = harness();
    const [a, b] = [still(600, 32), still(600, 33)];
    const sound = opusSound(1, 32);
    h.routes.set(ANNOUNCER, 'lan');
    h.t.announced(ANNOUNCER, [hashOf(a), hashOf(b)], [hashOf(sound), '']);
    h.t.announced(REQUESTER, []);
    expect(h.t.progressOf(ANNOUNCER)).toEqual({ have: 0, total: 3 });
    h.t.onChunk(chunkOf(hashOf(a), 0, 1, a));
    expect(h.t.progressOf(ANNOUNCER)).toEqual({ have: 1, total: 3 });
    expect(h.t.progressOf(REQUESTER)).toBeNull(); // nothing on their wheel to fetch
    expect(h.t.progressOf('nobody')).toBeNull();
  });
});
