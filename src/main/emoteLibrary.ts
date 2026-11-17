import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIO_TYPES, sniffAudio } from '../shared/audioSniff';
import {
  ANIM_MAX_BYTES, ANIM_MAX_SIDE, CUSTOM_NAME_MAX, MAX_CUSTOM_EMOTES, SHARED_SOUND_MAX_BYTES, SHARED_SOUND_MAX_S, SOUND_MAX_BYTES,
  STILL_MAX_BYTES, STILL_SIDE, customHash, customStillUrl, isBundledEmote, isClipMs, isCustomRef, ownCustomArt,
  type CustomEmote, type EmoteArt, type EmoteFile, type EmoteRef, type ImportError, type SoundError,
} from '../shared/emotes';
import { gifExtent, isAnimatedWebp, sniffImage, webpSize } from '../shared/imageSniff';
import { oggOpusInfo } from '../shared/oggOpus';
import { sanitizeName } from '../shared/roomProtocol';
import { isFile } from './fileState';
import { renameWithRetry } from './settingsStore';

const soundNames = (hash: string): string[] => AUDIO_TYPES.map((t) => `${hash}.sound.${t}`);
/** The small copy of an emote's sound that room members get, named after the emote like its other files. */
export const shareName = (hash: string): string => `${hash}.share.ogg`;
export type SoundSaved = { ok: true; share: string | null } | { ok: false; error: SoundError };

export type SaveResult = { ok: true; emote: CustomEmote } | { ok: false; error: ImportError };

const fail = (error: ImportError): SaveResult => ({ ok: false, error });
const longest = (size: { width: number; height: number }): number => Math.max(size.width, size.height);

/** An import as it arrived over IPC, rebuilt from its known fields: a string name and byte arrays. Null for anything else. */
export function emoteFileFrom(raw: unknown): EmoteFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { name, still, anim, clip } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !(still instanceof Uint8Array)) return null;
  if (anim === undefined) return { name, still };
  if (!(anim instanceof Uint8Array)) return null;
  return isClipMs(clip) ? { name, still, anim, clip } : { name, still, anim };
}

/** The still the settings window encoded: a still WebP of at most STILL_MAX_BYTES and STILL_SIDE px. */
export function checkStill(b: Uint8Array): ImportError | null {
  if (sniffImage(b) !== 'webp' || isAnimatedWebp(b)) return 'type'; // the still is served as an <img> on every overlay: it must not move
  if (b.length > STILL_MAX_BYTES) return 'size';
  const size = webpSize(b);
  return size && longest(size) <= STILL_SIDE ? null : 'type';
}

/** The size a GIF or WebP shows at, from its header; null for anything else. */
const artSize = (b: Uint8Array): { width: number; height: number } | null =>
  sniffImage(b) === 'gif' ? gifExtent(b) : sniffImage(b) === 'webp' ? webpSize(b) : null;

/** The art at full size: a GIF or WebP, moving or not, small enough to decode on every emote. */
function checkAnim(b: Uint8Array): ImportError | null {
  const type = sniffImage(b);
  if (type !== 'gif' && type !== 'webp') return 'type';
  if (b.length > ANIM_MAX_BYTES) return 'animSize';
  const size = artSize(b);
  if (!size) return 'type';
  return longest(size) > ANIM_MAX_SIDE ? 'animSize' : null;
}

/** Whether full-size art moves: every GIF the settings window keeps does, and a WebP says so in its header. */
const moves = (b: Uint8Array): boolean => sniffImage(b) === 'gif' || isAnimatedWebp(b);

/** A sound for an imported emote: OGG, MP3 or WAV by its first bytes, at most SOUND_MAX_BYTES. Its length is checked when picked. */
export function checkSound(b: Uint8Array): SoundError | null {
  if (!sniffAudio(b)) return 'type';
  return b.length > SOUND_MAX_BYTES ? 'size' : null;
}

/**
 * The copy of a sound that travels: Ogg Opus by its structure, at most SHARED_SOUND_MAX_BYTES, and no longer than
 * SHARED_SOUND_MAX_S counted from its packets. A small file can otherwise decode to minutes of audio in memory.
 */
export function checkShared(b: Uint8Array): SoundError | null {
  if (b.length > SHARED_SOUND_MAX_BYTES) return 'size';
  const info = oggOpusInfo(b);
  if (!info) return 'type';
  return info.seconds > SHARED_SOUND_MAX_S ? 'long' : null;
}

/**
 * What an emote looks like on screen. Our own imported emote shows at `scale` percent of its art's size. A room
 * member's shows as its still when it is one of ours too, or, through `cacheHas`, when its still arrived over the room,
 * and the sender's message says its size. Anything else is the placeholder.
 */
export function resolveEmoteArt(
  ref: EmoteRef, custom: readonly CustomEmote[], remote: boolean, cacheHas: (hash: string) => boolean = () => false, scale = 100,
): EmoteArt {
  if (isBundledEmote(ref)) return { kind: 'bundled', slug: ref };
  if (!isCustomRef(ref)) return { kind: 'placeholder' };
  const hash = customHash(ref);
  const emote = custom.find((c) => c.id === ref);
  if (emote && !remote) return ownCustomArt(emote, scale);
  if (emote) return { kind: 'custom', url: customStillUrl(hash), animated: false, fx: emote.fx ?? 0 };
  // A friend's cached still has no entry here, so the plain pop is its default; the sender's message can still carry their fx.
  return remote && cacheHas(hash) ? { kind: 'custom', url: customStillUrl(hash), animated: false, fx: 0 } : { kind: 'placeholder' };
}

/**
 * Imported emotes on disk: `<hash>.webp` (the still), `<hash>.anim.gif|webp` (the original animation),
 * `<hash>.sound.ogg|mp3|wav` and `<hash>.share.ogg` (the sound's small copy for rooms) in `dir`.
 * Everything that arrives is checked again here, whatever the settings window already checked, and the id is computed here.
 */
export class EmoteLibrary {
  /** `dir` is <settings folder>/emotes. */
  constructor(readonly dir: string) {}

  async save(file: EmoteFile, existing: readonly CustomEmote[]): Promise<SaveResult> {
    const f = emoteFileFrom(file);
    if (!f) return fail('type');
    const error = checkStill(f.still) ?? (f.anim ? checkAnim(f.anim) : null);
    if (error) return fail(error);
    const hash = createHash('sha256').update(f.still).digest('hex').slice(0, 32);
    const id = `c:${hash}`;
    if (existing.some((c) => c.id === id)) return fail('duplicate');
    if (existing.length >= MAX_CUSTOM_EMOTES) return fail('full');

    const animName = f.anim ? `${hash}.anim.${sniffImage(f.anim)}` : null;
    const size = artSize(f.anim ?? f.still);
    const files = [{ name: `${hash}.webp`, data: f.still }, ...(f.anim && animName ? [{ name: animName, data: f.anim }] : [])];
    // Files left by an earlier copy of this image: an animation in the other format would be served instead of this one.
    const stale = [`${hash}.anim.gif`, `${hash}.anim.webp`].filter((n) => n !== animName);
    try {
      await this.write(files, stale);
    } catch (err) {
      console.warn('[emotes] import failed:', (err as Error).message);
      return fail('disk');
    }
    // A name with nothing left shows the first characters of its hash, as in normalizeSettings.
    const name = sanitizeName(f.name.slice(0, 256), hash.slice(0, 6), CUSTOM_NAME_MAX);
    const animated = f.anim !== undefined && moves(f.anim);
    return {
      ok: true,
      emote: {
        id, name, animated, ...(size ? { w: size.width, h: size.height } : {}),
        ...(animated && f.clip !== undefined ? { clip: f.clip } : {}),
      },
    };
  }

  /**
   * Saves `sound` as the emote's sound, replacing any it had, or deletes its sound when `sound` is null. `share` is the
   * small copy for rooms, as the settings window encoded it: kept only when it passes its own checks, and its hash is
   * handed back. A sound without one still plays here; friends just don't hear it.
   */
  async setSound(id: EmoteRef, sound: Uint8Array | null, share: Uint8Array | null = null): Promise<SoundSaved> {
    if (!isCustomRef(id)) return { ok: false, error: 'type' };
    const hash = customHash(id);
    const all = [...soundNames(hash), shareName(hash)];
    try {
      if (sound === null) {
        for (const n of all) await rm(join(this.dir, n), { force: true });
        return { ok: true, share: null };
      }
      const error = checkSound(sound);
      if (error) return { ok: false, error };
      const files = [{ name: `${hash}.sound.${sniffAudio(sound)}`, data: sound }];
      const shared = share !== null && checkShared(share) === null ? share : null;
      if (shared) files.push({ name: shareName(hash), data: shared });
      // A sound in another format would be served first, and an old copy would go on being shared.
      await this.write(files, all.filter((n) => !files.some((f) => f.name === n)));
      return { ok: true, share: shared ? createHash('sha256').update(shared).digest('hex').slice(0, 32) : null };
    } catch (err) {
      console.warn('[emotes] could not save a sound:', (err as Error).message);
      return { ok: false, error: 'disk' };
    }
  }

  /** The emote's stored sound, or null when it has none. */
  async readSound(id: EmoteRef): Promise<Uint8Array | null> {
    if (!isCustomRef(id)) return null;
    for (const name of soundNames(customHash(id))) {
      try {
        return new Uint8Array(await readFile(join(this.dir, name)));
      } catch {
        // not this format
      }
    }
    return null;
  }

  /** Keeps `share` as the copy for rooms of a sound that is already stored, and hands back its hash; null when it fails its checks or the disk refuses. */
  async setShare(id: EmoteRef, share: Uint8Array): Promise<string | null> {
    if (!isCustomRef(id) || checkShared(share) !== null) return null;
    try {
      await this.write([{ name: shareName(customHash(id)), data: share }], []);
      return createHash('sha256').update(share).digest('hex').slice(0, 32);
    } catch (err) {
      console.warn('[emotes] could not save a shared sound:', (err as Error).message);
      return null;
    }
  }

  /** Deletes an emote's files. Best effort: a file that can't be deleted is only an orphan, which a later import overwrites. */
  async remove(id: EmoteRef): Promise<void> {
    if (!isCustomRef(id)) return;
    const hash = customHash(id);
    await Promise.all([`${hash}.webp`, `${hash}.anim.gif`, `${hash}.anim.webp`, ...soundNames(hash), shareName(hash)].map((n) =>
      rm(join(this.dir, n), { force: true }).catch((err: Error) => console.warn('[emotes] could not delete', n, err.message))));
  }

  /**
   * The entries whose still exists (run at launch, before anything reads them). When the folder can't be read at all (no
   * permission, say) nothing is known about its files, so the entries stay rather than the user's list being emptied.
   */
  present(list: readonly CustomEmote[]): CustomEmote[] {
    return list.filter((c) => isCustomRef(c.id) && isFile(join(this.dir, `${customHash(c.id)}.webp`), true));
  }

  /**
   * The entries given the size of their art, for those from a version that didn't keep one: the `.anim` file's, or the
   * still's. An entry whose files can't be read stays without a size, and shows in the emote size square as before.
   */
  async measure(list: readonly CustomEmote[]): Promise<CustomEmote[]> {
    const out: CustomEmote[] = [];
    for (const c of list) {
      if ((c.w !== undefined && c.h !== undefined) || !isCustomRef(c.id)) {
        out.push(c);
        continue;
      }
      const hash = customHash(c.id);
      let size: { width: number; height: number } | null = null;
      for (const name of [`${hash}.anim.gif`, `${hash}.anim.webp`, `${hash}.webp`]) {
        try {
          size = artSize(new Uint8Array(await readFile(join(this.dir, name))));
          break;
        } catch {
          // not this file
        }
      }
      out.push(size && longest(size) <= ANIM_MAX_SIDE ? { ...c, w: size.width, h: size.height } : c);
    }
    return out;
  }

  /** Every file goes to a temp name first, then all are renamed. On any failure none of them is left behind. */
  private async write(files: readonly { name: string; data: Uint8Array }[], stale: readonly string[]): Promise<void> {
    const paths = files.map((f) => join(this.dir, f.name));
    const temps = paths.map((p) => `${p}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      for (const n of stale) await rm(join(this.dir, n), { force: true });
      for (let i = 0; i < files.length; i++) await writeFile(temps[i], files[i].data);
      for (let i = 0; i < files.length; i++) await renameWithRetry(temps[i], paths[i]);
    } catch (err) {
      await Promise.all([...temps, ...paths].map((p) => rm(p, { force: true }).catch(() => undefined)));
      throw err;
    }
  }
}
