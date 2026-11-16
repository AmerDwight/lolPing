import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG } from '../../src/shared/emoteCatalog';
import {
  allEmoteAssetFiles, announcedEmoteHashes, announcedEmoteSounds, catalogEmote, customAnimUrl, customHash, customStillUrl, emoteAnimUrl, emoteIconUrl,
  EMOTE_FX_VARIANTS, emoteName, emoteSoundUrl, isBundledEmote, isCustomRef, isEmoteRefShape, normalizeClickEmote,
  normalizeEmoteWheel, type CustomEmote,
} from '../../src/shared/emotes';

const HASH = 'a'.repeat(32);
const HASH_B = 'b'.repeat(32);
const custom = (hash: string, name = 'Mine', animated = false): CustomEmote => ({ id: `c:${hash}`, name, animated });

describe('emote refs', () => {
  it('recognises ref shapes', () => {
    expect(isEmoteRefShape('thumbs_up')).toBe(true);
    expect(isEmoteRefShape(`c:${HASH}`)).toBe(true);
    for (const bad of [`C:${HASH.toUpperCase()}`, `c:${'a'.repeat(31)}`, `c:${'a'.repeat(33)}`, 'Thumbs', '', 'a'.repeat(41), 42, null, undefined]) {
      expect(isEmoteRefShape(bad)).toBe(false);
    }
  });

  it('accepts every catalog slug as a ref shape', () => {
    for (const e of EMOTE_CATALOG) expect(isEmoteRefShape(e.slug)).toBe(true);
  });

  it('tells custom refs from bundled ones', () => {
    expect(isCustomRef(`c:${HASH}`)).toBe(true);
    expect(isCustomRef('facepalm')).toBe(false);
    expect(isCustomRef(`c:${'g'.repeat(32)}`)).toBe(false);
    expect(isCustomRef(7)).toBe(false);
  });

  it('bundled means in the catalog', () => {
    for (const e of EMOTE_CATALOG) expect(isBundledEmote(e.slug)).toBe(true);
    expect(isEmoteRefShape('not_in_catalog')).toBe(true);
    expect(isBundledEmote('not_in_catalog')).toBe(false);
    expect(isBundledEmote(`c:${HASH}`)).toBe(false);
  });

  it('looks up catalog entries', () => {
    expect(catalogEmote('facepalm')?.leagueId).toBe(4341);
    expect(catalogEmote('nope')).toBeUndefined();
  });

  it('builds asset urls', () => {
    expect(emoteAnimUrl('facepalm')).toBe('../emotes/facepalm.avif');
    expect(emoteIconUrl('facepalm')).toBe('../emotes/facepalm.png');
    expect(emoteSoundUrl('facepalm')).toBe('../emotes/facepalm.ogg');
    expect(customHash(`c:${HASH}`)).toBe(HASH);
    expect(customStillUrl(HASH)).toBe(`lolping://emotes/${HASH}.webp`);
    expect(customAnimUrl(HASH)).toBe(`lolping://emotes/${HASH}.anim`);
  });
});

describe('normalizeEmoteWheel', () => {
  it('falls back to the default wheel', () => {
    expect(normalizeEmoteWheel(undefined, [])).toEqual(DEFAULT_EMOTE_WHEEL);
    const seven = DEFAULT_EMOTE_WHEEL.slice(0, 7);
    const dup = [...DEFAULT_EMOTE_WHEEL.slice(0, 7), DEFAULT_EMOTE_WHEEL[0]];
    for (const raw of [seven, dup, 'facepalm', null, [...DEFAULT_EMOTE_WHEEL.slice(0, 7), 42]]) {
      expect(normalizeEmoteWheel(raw, [])).toEqual(DEFAULT_EMOTE_WHEEL);
    }
  });

  it('returns a fresh array', () => {
    expect(normalizeEmoteWheel(undefined, [])).not.toBe(DEFAULT_EMOTE_WHEEL);
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    expect(normalizeEmoteWheel(wheel, [])).not.toBe(wheel);
  });

  it('keeps a valid wheel, including bundled slugs that are not the default', () => {
    const wheel = ['facepalm', ...DEFAULT_EMOTE_WHEEL.slice(1)];
    expect(normalizeEmoteWheel(wheel, [])).toEqual(wheel);
  });

  it('keeps a custom ref that is in the custom list', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[3] = `c:${HASH}`;
    expect(normalizeEmoteWheel(wheel, [custom(HASH)])).toEqual(wheel);
  });

  it('replaces a custom ref that is missing from the list with the default for that slot', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[3] = `c:${HASH}`;
    const out = normalizeEmoteWheel(wheel, [custom(HASH_B)]);
    expect(out[3]).toBe(DEFAULT_EMOTE_WHEEL[3]);
    expect(out).toEqual(DEFAULT_EMOTE_WHEEL);
  });

  it('replaces an unknown slug the same way', () => {
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[0] = 'not_in_catalog';
    expect(normalizeEmoteWheel(wheel, [])).toEqual(DEFAULT_EMOTE_WHEEL);
  });

  it('picks the first free catalog slug when the slot default is already on the wheel', () => {
    // Slot 3's default sits in slot 0, and slot 3 holds a custom ref that isn't known.
    const wheel = [DEFAULT_EMOTE_WHEEL[3], ...DEFAULT_EMOTE_WHEEL.slice(1, 3), `c:${HASH}`, ...DEFAULT_EMOTE_WHEEL.slice(4)];
    const out = normalizeEmoteWheel(wheel, []);
    const free = EMOTE_CATALOG.map((e) => e.slug).find((s) => !wheel.includes(s));
    expect(out[3]).toBe(free);
    expect(new Set(out).size).toBe(8);
  });

  it('never repeats a ref when several slots are replaced', () => {
    // Slot 0 repeats slot 1's default; slots 1 and 2 hold custom refs that don't exist.
    const wheel = [...DEFAULT_EMOTE_WHEEL];
    wheel[0] = DEFAULT_EMOTE_WHEEL[1];
    wheel[1] = `c:${HASH}`;
    wheel[2] = `c:${HASH_B}`;
    const out = normalizeEmoteWheel(wheel, []);
    expect(new Set(out).size).toBe(8);
    expect(out.every(isBundledEmote)).toBe(true);
    expect(out[0]).toBe(DEFAULT_EMOTE_WHEEL[1]); // a valid ref is never the one that moves
  });
});

describe('normalizeClickEmote', () => {
  it('normalizes the centre', () => {
    expect(normalizeClickEmote('not_in_catalog', [])).toBe(DEFAULT_CLICK_EMOTE);
    expect(normalizeClickEmote(7, [])).toBe(DEFAULT_CLICK_EMOTE);
    expect(normalizeClickEmote(undefined, [])).toBe(DEFAULT_CLICK_EMOTE);
    expect(normalizeClickEmote('gasp', [])).toBe('gasp');
  });

  it('keeps a known custom ref and drops an unknown one', () => {
    expect(normalizeClickEmote(`c:${HASH}`, [custom(HASH)])).toBe(`c:${HASH}`);
    expect(normalizeClickEmote(`c:${HASH}`, [custom(HASH_B)])).toBe(DEFAULT_CLICK_EMOTE);
  });
});

describe('asset files', () => {
  it('lists asset files', () => {
    const files = allEmoteAssetFiles();
    const sounds = EMOTE_CATALOG.filter((e) => e.hasSound).length;
    expect(files).toHaveLength(EMOTE_CATALOG.length * 2 + sounds);
    expect(files).toContain('emotes/facepalm.avif');
    expect(files).toContain('emotes/facepalm.png');
    expect(files).toContain('emotes/facepalm.ogg');
    expect(new Set(files).size).toBe(files.length);
  });

  it('skips the sound of an emote without one', () => {
    for (const e of EMOTE_CATALOG.filter((c) => !c.hasSound)) expect(allEmoteAssetFiles()).not.toContain(`emotes/${e.slug}.ogg`);
  });

  it('finds every listed file in assets/', () => {
    const assets = resolve(__dirname, '../../assets');
    for (const file of allEmoteAssetFiles()) expect(existsSync(resolve(assets, file)), file).toBe(true);
  });

  it('bakes every animation as an AVIF that plays once', () => {
    // The boxes inside [start, end) of an ISO-BMFF file, as [type, payload start, end].
    const boxes = (data: Buffer, start: number, end: number): [string, number, number][] => {
      const out: [string, number, number][] = [];
      for (let p = start; p + 8 <= end;) {
        const size = data.readUInt32BE(p);
        if (size < 8 || p + size > end) throw new Error(`bad box at ${p}`);
        out.push([data.toString('latin1', p + 4, p + 8), p + 8, p + size]);
        p += size;
      }
      return out;
    };
    const inside = (data: Buffer, parents: [string, number, number][], type: string): [string, number, number][] =>
      parents.flatMap(([, s, e]) => boxes(data, s, e)).filter(([t]) => t === type);
    const assets = resolve(__dirname, '../../assets');
    for (const e of EMOTE_CATALOG) {
      const data = readFileSync(resolve(assets, 'emotes', `${e.slug}.avif`));
      expect(data.toString('latin1', 8, 12), e.slug).toBe('avis'); // the ftyp brand of an image sequence
      const moov = boxes(data, 0, data.length).filter(([t]) => t === 'moov');
      const traks = inside(data, moov, 'trak');
      const lists = inside(data, inside(data, traks, 'edts'), 'elst');
      // One edit list per track (colour and alpha). Chromium reads the loop count from it: flag 1 repeats for ever,
      // libavif's default, and 0 plays once.
      expect(lists.length, e.slug).toBe(traks.length);
      for (const [, s] of lists) expect(data.readUInt32BE(s) & 0xffffff, e.slug).toBe(0);
    }
  });
});

describe('emoteName', () => {
  it('names bundled emotes in the language asked for', () => {
    expect(emoteName('facepalm', 'en', [])).toBe('Facepalm');
    expect(emoteName('facepalm', 'zh-CN', [])).toBe('捂脸');
  });

  it('names a custom emote by its stored name', () => {
    expect(emoteName(`c:${HASH}`, 'en', [custom(HASH, 'My Cat')])).toBe('My Cat');
    expect(emoteName(`c:${HASH}`, 'zh-CN', [custom(HASH, 'My Cat')])).toBe('My Cat');
  });

  it('gives ? for a ref it does not know', () => {
    expect(emoteName('not_in_catalog', 'en', [])).toBe('?');
    expect(emoteName(`c:${HASH}`, 'en', [])).toBe('?');
  });
});

describe('announcedEmoteHashes', () => {
  it('lists the custom emotes on the centre and wheel, distinct, centre first', () => {
    expect(announcedEmoteHashes([`c:${HASH}`, 'gg', `c:${HASH}`], `c:${HASH_B}`)).toEqual([HASH_B, HASH]);
    expect(announcedEmoteHashes(['gg', 'bait'], 'gg')).toEqual([]);
  });

  it('announces at most 9 hashes', () => {
    const many = Array.from({ length: 12 }, (_, i) => `c:${i.toString(16).padStart(32, '0')}`);
    expect(announcedEmoteHashes(many.slice(1), many[0])).toHaveLength(9);
  });
});

describe('announcedEmoteSounds', () => {
  it('gives each announced hash its emote’s shared sound, in order, and an empty string where there is none', () => {
    const shared: CustomEmote = { ...custom(HASH), sound: true, share: 'c'.repeat(32) };
    const local: CustomEmote = { ...custom(HASH_B), sound: true }; // a sound with no copy for rooms
    expect(announcedEmoteSounds([HASH_B, HASH, 'd'.repeat(32)], [shared, local])).toEqual(['', 'c'.repeat(32), '']);
    expect(announcedEmoteSounds([], [shared])).toEqual([]);
  });
});

