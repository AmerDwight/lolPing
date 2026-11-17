import { describe, expect, it } from 'vitest';
import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG } from '../../src/shared/emoteCatalog';
import {
  allEmoteAssetFiles, announcedEmoteAnims, announcedEmoteHashes, announcedEmoteSounds, catalogEmote, customAnimUrl, customHash, customStillUrl, emoteAnimUrl, emoteIconUrl,
  EMOTE_FX_VARIANTS, emoteName, emoteSoundUrl, isBundledEmote, isCustomRef, isEmoteRefShape, normalizeClickEmote,
  normalizeEmoteWheel, ownCustomArt, scaledArtSize, type CustomEmote,
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
    expect(emoteAnimUrl('facepalm')).toBe('../emotes/facepalm.webp');
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
    expect(files).toContain('emotes/facepalm.webp');
    expect(files).toContain('emotes/facepalm.png');
    expect(files).toContain('emotes/facepalm.ogg');
    expect(new Set(files).size).toBe(files.length);
  });

  it('skips the sound of an emote without one', () => {
    for (const e of EMOTE_CATALOG.filter((c) => !c.hasSound)) expect(allEmoteAssetFiles()).not.toContain(`emotes/${e.slug}.ogg`);
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


describe('scaledArtSize', () => {
  it('scales both sides by the percentage, keeping their proportions', () => {
    expect(scaledArtSize(400, 300, 100)).toEqual({ w: 400, h: 300 });
    expect(scaledArtSize(400, 300, 50)).toEqual({ w: 200, h: 150 });
    expect(scaledArtSize(300, 100, 150)).toEqual({ w: 450, h: 150 });
  });

  it('keeps the longest side between 16 and 2048 px, in the same proportions', () => {
    expect(scaledArtSize(40, 20, 10)).toEqual({ w: 16, h: 8 });
    expect(scaledArtSize(1024, 512, 300)).toEqual({ w: 2048, h: 1024 });
  });

  it('never makes a side smaller than a pixel', () => {
    expect(scaledArtSize(1000, 2, 10)).toEqual({ w: 100, h: 1 });
  });
});

describe('ownCustomArt', () => {
  const mine: CustomEmote = { id: `c:${HASH}`, name: 'Mine', animated: true, w: 320, h: 240, sound: true, fx: 3, clip: 4200 };

  it('shows the full-size art at the scale, with its sound, effect and clip length', () => {
    expect(ownCustomArt(mine, 50)).toEqual({
      kind: 'custom', url: customAnimUrl(HASH), animated: true, fx: 3, w: 160, h: 120, sound: `lolping://emotes/${HASH}.sound`, dur: 4.2,
    });
  });

  it('leaves out what the entry does not have', () => {
    expect(ownCustomArt(custom(HASH), 100)).toEqual({ kind: 'custom', url: customAnimUrl(HASH), animated: false, fx: 0 });
  });

  it('stays the usual time for a clip shorter than that', () => {
    expect(ownCustomArt({ ...mine, clip: 2000 }, 100)).not.toHaveProperty('dur');
  });
});

describe('announcedEmoteAnims', () => {
  it('pairs each announced hash that has a shared animation with it, in order', () => {
    const list: CustomEmote[] = [
      { ...custom(HASH, 'a', true), shareAnim: 'c'.repeat(32) }, custom(HASH_B, 'b', true), { ...custom('d'.repeat(32), 'd', true), shareAnim: 'e'.repeat(32) },
    ];
    expect(announcedEmoteAnims(['d'.repeat(32), HASH_B, HASH], list)).toEqual([['d'.repeat(32), 'e'.repeat(32)], [HASH, 'c'.repeat(32)]]);
    expect(announcedEmoteAnims([], list)).toEqual([]);
  });
});
