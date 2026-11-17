import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_MAX_BYTES, CACHE_MAX_FILES, EmoteCache } from '../../src/main/emoteCache';

const HASH = (n: number): string => n.toString(16).padStart(32, '0');
const stillOf = (n: number, size: number): Uint8Array => new Uint8Array(size).fill(n + 1);
const webpNames = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.webp'));
const NAME = /^([0-9a-f]{32})\.webp$/;

let dir: string;
let cache: EmoteCache;
let clock: number;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'lolping-emote-cache-')), 'emote-cache');
  clock = Date.now() + 5000;
  cache = new EmoteCache(dir, () => clock);
});

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('EmoteCache', () => {
  it('stores a verified still and finds it again after a relaunch', async () => {
    expect(await cache.put(HASH(1), stillOf(1, 100))).toBe(true);
    expect(cache.has(HASH(1))).toBe(true);
    expect(cache.has(HASH(2))).toBe(false);

    const again = new EmoteCache(dir, () => clock);
    await again.present();
    expect(again.has(HASH(1))).toBe(true);
  });

  it('keeps shared sounds as .ogg under their own caps, in the same folder as the stills', async () => {
    const sounds = new EmoteCache(dir, () => clock, 'ogg');
    await cache.put(HASH(1), stillOf(1, 100));
    expect(await sounds.put(HASH(1), stillOf(2, 50))).toBe(true);
    expect(await sounds.put(HASH(2), stillOf(3, 50))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`${HASH(1)}.ogg`, `${HASH(1)}.webp`, `${HASH(2)}.ogg`]);
    expect(cache.has(HASH(2))).toBe(false); // a sound is not a still

    const stillsAgain = new EmoteCache(dir, () => clock);
    const soundsAgain = new EmoteCache(dir, () => clock, 'ogg');
    await stillsAgain.present();
    await soundsAgain.present();
    expect([stillsAgain.has(HASH(1)), stillsAgain.has(HASH(2))]).toEqual([true, false]);
    expect([soundsAgain.has(HASH(1)), soundsAgain.has(HASH(2))]).toEqual([true, true]);
  });

  it('keeps shared animations as .anim.webp under caps of their own, apart from the stills', async () => {
    const anims = new EmoteCache(dir, () => clock, 'anim.webp', { files: 2, bytes: 1000 });
    await cache.put(HASH(1), stillOf(1, 100));
    expect(await anims.put(HASH(1), stillOf(2, 400))).toBe(true);
    expect(await anims.put(HASH(2), stillOf(3, 400))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`${HASH(1)}.anim.webp`, `${HASH(1)}.webp`, `${HASH(2)}.anim.webp`]);
    clock += 10;
    expect(await anims.put(HASH(3), stillOf(4, 400))).toBe(true); // a third is past the file cap: the oldest goes
    expect([anims.has(HASH(1)), anims.has(HASH(2)), anims.has(HASH(3))]).toEqual([false, true, true]);
    expect(cache.has(HASH(1))).toBe(true); // the still under the same hash is another cache's

    const stillsAgain = new EmoteCache(dir, () => clock);
    await stillsAgain.present();
    expect([stillsAgain.has(HASH(1)), stillsAgain.has(HASH(2))]).toEqual([true, false]); // an animation is not a still
  });

  it('leaves an animation\'s temp file to the animation cache when it sweeps', async () => {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${HASH(1)}.anim.webp.tmp`);
    writeFileSync(tmp, 'left by a crash');
    const ago = new Date(Date.now() - 10 * 60_000);
    utimesSync(tmp, ago, ago);
    await cache.sweep();
    expect(existsSync(tmp)).toBe(true);
    await new EmoteCache(dir, () => clock, 'anim.webp').sweep();
    expect(existsSync(tmp)).toBe(false);
  });

  it('refuses a hash that is not 32 hex characters', async () => {
    expect(await cache.put('../escape', stillOf(1, 100))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  // Filling the cache is CACHE_MAX_FILES writes; on a busy CI runner that alone crossed the 5 s default (1.1 s on an
  // idle one), which read as a flake in every PR's Linux job.
  it('evicts the least recently used still beyond the cap, and touch() protects a shown one', { timeout: 20_000 }, async () => {
    for (let n = 0; n < CACHE_MAX_FILES; n++) {
      expect(await cache.put(HASH(n), stillOf(n, 100))).toBe(true);
      const at = new Date(Date.now() - (CACHE_MAX_FILES - n) * 1000); // HASH(0) is the oldest on disk, HASH(1) the next
      utimesSync(join(dir, `${HASH(n)}.webp`), at, at);
    }
    const relaunched = new EmoteCache(dir, () => clock); // after a launch, last use comes from the files' mtimes
    await relaunched.present();
    relaunched.touch(HASH(0)); // a display showed the oldest file just now
    await relaunched.put(HASH(CACHE_MAX_FILES), stillOf(1, 100)); // one over the cap: exactly one goes
    expect(webpNames(dir)).toHaveLength(CACHE_MAX_FILES);
    expect(relaunched.has(HASH(0))).toBe(true); // shown beats old
    expect(relaunched.has(HASH(1))).toBe(false); // the runner-up went instead
    expect(relaunched.has(HASH(CACHE_MAX_FILES))).toBe(true);
  });

  it('keeps at most CACHE_MAX_FILES files', async () => {
    for (let n = 0; n < CACHE_MAX_FILES + 5; n++) await cache.put(HASH(n), stillOf(n, 100));
    expect(webpNames(dir)).toHaveLength(CACHE_MAX_FILES);
    expect(cache.has(HASH(0))).toBe(false); // the oldest five went
    expect(cache.has(HASH(CACHE_MAX_FILES + 4))).toBe(true);
  });

  it('keeps at most CACHE_MAX_BYTES', async () => {
    const perFile = 300_000; // 4 MB / 300 KB ≈ 14 files
    for (let n = 0; n < 20; n++) await cache.put(HASH(n), stillOf(n, perFile));
    expect(webpNames(dir).length * perFile).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    expect(webpNames(dir).length).toBeLessThan(20);
  });

  it('answers false and logs once when the folder cannot be created', async () => {
    mkdirSync(dir, { recursive: true });
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'a file where the cache folder should be');
    const broken = new EmoteCache(blocker, () => clock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await broken.put(HASH(1), stillOf(1, 100))).toBe(false);
    expect(await broken.put(HASH(2), stillOf(2, 100))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(broken.has(HASH(1))).toBe(false);
  });

  it('sweep ignores unknown names and forgets files that vanished', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'note.txt'), 'not an emote');
    await cache.put(HASH(3), stillOf(3, 100));
    rmSync(join(dir, `${HASH(3)}.webp`));
    await cache.sweep();
    expect(cache.has(HASH(3))).toBe(false);
  });
});

describe('EmoteCache: audit regressions', () => {
  it('forgets an evicted hash at once: no stale has() until the next put', async () => {
    for (let n = 0; n < CACHE_MAX_FILES + 1; n++) await cache.put(HASH(n), stillOf(n, 100));
    expect(webpNames(dir)).toHaveLength(CACHE_MAX_FILES);
    expect(cache.has(HASH(0))).toBe(false); // the eviction is visible to has() at once, without another put
    const onDisk = readdirSync(dir).map((f) => NAME.exec(f)?.[1]).filter((h) => h !== undefined) as string[];
    for (const h of onDisk) expect(cache.has(h)).toBe(true); // and nothing on disk is missing from the index
  });

  it('sweeps temp files a crashed write left, once they are old enough', async () => {
    mkdirSync(dir, { recursive: true });
    const old = join(dir, `${HASH(1)}.webp.tmp`);
    const fresh = join(dir, `${HASH(2)}.webp.tmp`);
    writeFileSync(old, 'left by a crash');
    writeFileSync(fresh, 'owned by a live put');
    const ago = new Date(Date.now() - 10 * 60_000);
    utimesSync(old, ago, ago);
    await cache.sweep();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // a live put owns its tmp for milliseconds: it stays
  });
});
