import { DEFAULT_CLICK_EMOTE, DEFAULT_EMOTE_WHEEL, EMOTE_CATALOG, type CatalogEmote } from './emoteCatalog';
import type { Lang } from './i18n';

/** A bundled emote's slug, or 'c:' + 32 lower-case hex characters (the hash of an imported emote). */
export type EmoteRef = string;

export interface CustomEmote {
  id: EmoteRef;
  name: string;
  /** Has a `.anim` file besides the still. */
  animated: boolean;
  /** Has a `.sound` file: it plays when we place the emote. Room members hear the shared copy instead, when there is one. */
  sound?: boolean;
  /** The hash of its `.share.ogg`: a small Opus copy of the sound, which room members fetch and play. Only with `sound`. */
  share?: string;
  /** Which signature effect it plays when it lands: 0–5. Nothing stored (an entry from an older version) plays the plain pop. */
  fx?: number;
  /**
   * The size of its art in px, the size it shows at 100%: its `.anim` file's, or its still's when it has none. Set at
   * import; measured once at launch for an entry from an older version.
   */
  w?: number;
  h?: number;
  /** Made from a video: the clip's length in ms, which is how long it stays on screen when that is longer than usual. */
  clip?: number;
}

/** A stored effect: an integer within EMOTE_FX_VARIANTS. Anything else means the plain pop. */
export const isEmoteFx = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < EMOTE_FX_VARIANTS;

/** What an emote looks like on screen. A placeholder stands in for a custom emote whose files are missing. */
export type EmoteArt =
  | { kind: 'bundled'; slug: string }
  | {
    kind: 'custom'; url: string; animated: boolean; sound?: string; /** The signature effect it plays; 0 is the plain pop. */ fx: number;
    /** Its size on screen in px. Without one it fills the emote size setting's square, as every emote did before sizes. */
    w?: number; h?: number;
    /** Seconds on screen, when that is longer than EMOTE_DURATION_S: a clip stays until it has played. */
    dur?: number;
  }
  | { kind: 'placeholder' };

export type ImportError = 'type' | 'size' | 'animSize' | 'detail' | 'full' | 'duplicate' | 'disk';
/**
 * What the settings renderer sends the main process when importing: the 160 px still and the art at full size, which is
 * the original animation, a video's frames, or the image itself as a WebP of up to ART_MAX_SIDE. An image the window
 * couldn't make a full-size copy of has no `anim`, and shows as its still.
 */
export interface EmoteFile {
  name: string;
  still: Uint8Array;
  anim?: Uint8Array;
  /** The clip's length in ms, for art made from a video. */
  clip?: number;
}
export type ImportResult = { ok: true; id: EmoteRef } | { ok: false; error: ImportError };
export type SoundError = 'type' | 'size' | 'long' | 'disk';
export type SoundResult = { ok: true } | { ok: false; error: SoundError };

export const MAX_CUSTOM_EMOTES = 24;
export const EMOTE_DURATION_S = 3;
export const CUSTOM_NAME_MAX = 24;
export const STILL_MAX_BYTES = 12_288;
export const STILL_SIDE = 160;
export const STILL_FALLBACK_SIDE = 128;
export const INPUT_MAX_BYTES = 8_388_608;
/** The longest side of a picked image the settings window will decode: a small file can declare billions of pixels. */
export const INPUT_MAX_SIDE = 8192;
export const ANIM_MAX_BYTES = 5_242_880;
export const ANIM_MAX_SIDE = 1024;
/** A still image's full-size copy is scaled down to this on its longest side: the most a custom emote shows at 100%. */
export const ART_MAX_SIDE = ANIM_MAX_SIDE;
/** A custom emote on screen, after the scale: never smaller than this on its longest side, nor larger. */
export const ART_MIN_PX = 16;
export const ART_MAX_PX = 2048;
/** An imported emote's sound: OGG, MP3 or WAV, at most this many bytes and seconds. */
export const SOUND_MAX_BYTES = 1_048_576;
export const SOUND_MAX_S = 5;
/** A video emote is a clip of at least CLIP_MIN_S and at most CLIP_MAX_S, the longest sound an emote can have. */
export const CLIP_MIN_S = 0.3;
export const CLIP_MAX_S = SOUND_MAX_S;
/** The copy of a sound that travels through a room: mono Ogg Opus, at most this many bytes (22 chunks). */
export const SHARED_SOUND_MAX_BYTES = 16_384;
/** A shared sound's packets may decode to this much: SOUND_MAX_S, the picker's slack, and the encoder's delay and padding. */
export const SHARED_SOUND_MAX_S = SOUND_MAX_S + 0.2;
/**
 * The signature effects a custom emote can play when it lands: 0 is the plain pop, then spin-in, bounce drop, flash
 * focus, pendulum swing and heartbeat. Which one an image plays is stored on its entry (`CustomEmote.fx`, picked by
 * right-clicking it in the settings window); nothing stored plays the plain pop.
 */
export const EMOTE_FX_VARIANTS = 6;

const SLUG = /^[a-z0-9_]{1,40}$/;
const CUSTOM = /^c:[0-9a-f]{32}$/;

/** Well-formed, whether or not it exists. Room messages are checked against this before anything looks it up. */
export const isEmoteRefShape = (v: unknown): v is EmoteRef => typeof v === 'string' && (SLUG.test(v) || CUSTOM.test(v));
export const isCustomRef = (v: unknown): v is EmoteRef => typeof v === 'string' && CUSTOM.test(v);
/** The 32 lower-case hex characters a custom emote hash must be. */
export const HASH_RE = /^[0-9a-f]{32}$/;
/** The most hashes one presence announces: the wheel plus the centre, minus duplicates. */
export const ANNOUNCED_MAX = 9;

const BY_SLUG: ReadonlyMap<string, CatalogEmote> = new Map(EMOTE_CATALOG.map((e) => [e.slug, e]));

export const catalogEmote = (slug: string): CatalogEmote | undefined => BY_SLUG.get(slug);
export const isBundledEmote = (v: unknown): v is EmoteRef => typeof v === 'string' && BY_SLUG.has(v);
export const customHash = (ref: EmoteRef): string => ref.slice(2);

/** Relative to a renderer page at <root>/<page>/index.html; assets/ is served at <root>/. */
export const emoteAnimUrl = (slug: string): string => `../emotes/${slug}.webp`;
export const emoteIconUrl = (slug: string): string => `../emotes/${slug}.png`;
export const emoteSoundUrl = (slug: string): string => `../emotes/${slug}.ogg`;
/** Imported emotes live in the user's data folder; the lolping:// protocol serves them under this. */
export const CUSTOM_EMOTE_URL = 'lolping://emotes/';
export const customStillUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.webp`;
export const customAnimUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.anim`;
export const customSoundUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.sound`;
/** A room member's shared sound, by its own hash, from the cache. */
export const sharedSoundUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.ogg`;

/** Every bundled file that has to ship, relative to assets/. */
export function allEmoteAssetFiles(): string[] {
  return EMOTE_CATALOG.flatMap((e) => [`emotes/${e.slug}.webp`, `emotes/${e.slug}.png`, ...(e.hasSound ? [`emotes/${e.slug}.ogg`] : [])]);
}

export function emoteName(ref: EmoteRef, lang: Lang, custom: readonly CustomEmote[]): string {
  const bundled = catalogEmote(ref);
  if (bundled) return lang === 'zh-CN' ? bundled.nameZh : bundled.name;
  return custom.find((c) => c.id === ref)?.name ?? '?';
}

/** A stored size: an integer from 1 to ART_MAX_SIDE. */
export const isArtSide = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= ART_MAX_SIDE;
/** A stored clip length in ms: whole, and no longer than a shared sound may play. */
export const isClipMs = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= CLIP_MIN_S * 1000 && (v as number) <= SHARED_SOUND_MAX_S * 1000;

/**
 * An art size `scale` percent of (w, h), its sides in the same proportion, rounded to whole px, and kept between
 * ART_MIN_PX and ART_MAX_PX on its longest side.
 */
export function scaledArtSize(w: number, h: number, scale: number): { w: number; h: number } {
  const longest = Math.max(w, h);
  const target = Math.min(ART_MAX_PX, Math.max(ART_MIN_PX, (longest * scale) / 100));
  const k = target / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Our own imported emote as it shows here: its full-size art (main serves the still when there is none), at `scale`
 * percent of its own size, with its sound when it has one, for its clip's length when it is a clip.
 */
export function ownCustomArt(c: CustomEmote, scale: number): EmoteArt {
  const hash = customHash(c.id);
  const size = c.w !== undefined && c.h !== undefined ? scaledArtSize(c.w, c.h, scale) : {};
  return {
    kind: 'custom', url: customAnimUrl(hash), animated: c.animated, fx: c.fx ?? 0, ...size,
    ...(c.sound ? { sound: customSoundUrl(hash) } : {}),
    ...(c.clip !== undefined && c.clip / 1000 > EMOTE_DURATION_S ? { dur: c.clip / 1000 } : {}),
  };
}

/** The hashes one presence announces: the custom emotes on the centre and wheel, distinct, at most ANNOUNCED_MAX. */
export function announcedEmoteHashes(wheel: readonly EmoteRef[], centre: EmoteRef): string[] {
  const out: string[] = [];
  for (const ref of [centre, ...wheel]) {
    if (!isCustomRef(ref)) continue;
    const hash = customHash(ref);
    if (!out.includes(hash)) out.push(hash);
    if (out.length >= ANNOUNCED_MAX) break;
  }
  return out;
}

/** For each announced hash, in the same order, the hash of that emote's shared sound, or '' when it has none. */
export function announcedEmoteSounds(hashes: readonly string[], custom: readonly CustomEmote[]): string[] {
  return hashes.map((hash) => custom.find((c) => c.id === `c:${hash}`)?.share ?? '');
}

const isKnown = (ref: EmoteRef, custom: readonly CustomEmote[]): boolean =>
  isBundledEmote(ref) || (isCustomRef(ref) && custom.some((c) => c.id === ref));

/**
 * A wheel is 8 distinct, well-formed refs. Anything else gives the default wheel. A slot whose emote no longer exists
 * gets that slot's default, or, when the wheel already holds it, the first catalog emote that isn't on the wheel.
 */
export function normalizeEmoteWheel(raw: unknown, custom: readonly CustomEmote[]): EmoteRef[] {
  const slots = DEFAULT_EMOTE_WHEEL.length;
  if (!Array.isArray(raw) || raw.length !== slots || !raw.every(isEmoteRefShape) || new Set(raw).size !== slots) {
    return [...DEFAULT_EMOTE_WHEEL];
  }
  const wheel: EmoteRef[] = [...raw];
  const used = new Set(wheel.filter((ref) => isKnown(ref, custom)));
  for (let i = 0; i < slots; i++) {
    if (isKnown(wheel[i], custom)) continue;
    const pick = used.has(DEFAULT_EMOTE_WHEEL[i]) ? EMOTE_CATALOG.find((e) => !used.has(e.slug))!.slug : DEFAULT_EMOTE_WHEEL[i];
    used.add(pick);
    wheel[i] = pick;
  }
  return wheel;
}

export function normalizeClickEmote(raw: unknown, custom: readonly CustomEmote[]): EmoteRef {
  return isEmoteRefShape(raw) && isKnown(raw, custom) ? raw : DEFAULT_CLICK_EMOTE;
}
