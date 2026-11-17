import { SHARED_ANIM_MAX_BYTES, SHARED_ANIM_MAX_FRAMES, SHARED_ANIM_MAX_MS, SHARED_ANIM_SIDE } from '../../shared/emotes';
import { muxWebpAnimation, type WebpFrame } from '../../shared/webpAnim';

/** One frame for the copy: a picture of at most SHARED_ANIM_SIDE px, and how long it shows. */
export interface AnimSource {
  image: ImageBitmap;
  ms: number;
}

/** The copy plays at most this many frames a second: it is seen small, and every frame costs bytes on the way. */
export const SHARE_ANIM_FPS = 12;

/**
 * The encodings tried, in order, until one fits SHARED_ANIM_MAX_BYTES. `step` keeps every step-th frame on top of the
 * frame rate's own: each kept frame lasts as long as the frames it stands for.
 */
export const SHARE_ANIM_ATTEMPTS: readonly { side: number; quality: number; step: number }[] = [
  { side: 240, quality: 0.6, step: 1 },
  { side: 200, quality: 0.5, step: 1 },
  { side: 160, quality: 0.45, step: 1 },
  { side: 160, quality: 0.4, step: 2 },
  { side: 128, quality: 0.35, step: 2 },
];

/** The frame durations cut to SHARED_ANIM_MAX_MS: the frames that start within it, the last one shortened to fit. */
export function trimDurations(ms: readonly number[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (const d of ms) {
    if (total >= SHARED_ANIM_MAX_MS) break;
    const take = Math.min(d, SHARED_ANIM_MAX_MS - total);
    out.push(take);
    total += take;
  }
  return out;
}

/** The step that keeps a copy within SHARE_ANIM_FPS and SHARED_ANIM_MAX_FRAMES. */
export function baseStep(ms: readonly number[]): number {
  const total = ms.reduce((a, b) => a + b, 0);
  const byRate = Math.ceil(ms.length / Math.max(1, (total / 1000) * SHARE_ANIM_FPS));
  return Math.max(1, byRate, Math.ceil(ms.length / SHARED_ANIM_MAX_FRAMES));
}

/** Every `step`-th frame, each lasting the frames it stands for, so the whole lasts as long as before. */
export function stepFrames(ms: readonly number[], step: number): { index: number; ms: number }[] {
  const out: { index: number; ms: number }[] = [];
  for (let i = 0; i < ms.length; i += step) out.push({ index: i, ms: ms.slice(i, i + step).reduce((a, b) => a + b, 0) });
  return out;
}

const fit = (w: number, h: number, side: number): { width: number; height: number } => {
  const k = Math.min(1, side / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
};

/**
 * The small copy of an animation that room members fetch: an animated WebP of the first SHARED_ANIM_MAX_MS of `frames`,
 * at the first of SHARE_ANIM_ATTEMPTS that fits SHARED_ANIM_MAX_BYTES. `opaque` frames (a video's) leave out the alpha
 * channel. Null when nothing fits or this Chromium can't encode WebP; the emote then shows as its still to friends.
 */
export async function encodeSharedAnim(frames: readonly AnimSource[], opaque = false): Promise<Uint8Array | null> {
  const first = frames[0];
  if (!first) return null;
  const durations = trimDurations(frames.map((f) => f.ms));
  const step = baseStep(durations);
  for (const attempt of SHARE_ANIM_ATTEMPTS) {
    const size = fit(first.image.width, first.image.height, Math.min(SHARED_ANIM_SIDE, attempt.side));
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d', { alpha: !opaque });
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    const out: WebpFrame[] = [];
    let bytes = 0;
    for (const pick of stepFrames(durations, step * attempt.step)) {
      ctx.clearRect(0, 0, size.width, size.height);
      ctx.drawImage(frames[pick.index].image, 0, 0, size.width, size.height);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: attempt.quality });
      if (blob.type !== 'image/webp') return null;
      bytes += blob.size;
      if (bytes > SHARED_ANIM_MAX_BYTES) break;
      out.push({ file: new Uint8Array(await blob.arrayBuffer()), ms: pick.ms });
    }
    if (bytes > SHARED_ANIM_MAX_BYTES) continue;
    const anim = muxWebpAnimation(out, size.width, size.height);
    if (anim && anim.length <= SHARED_ANIM_MAX_BYTES) return anim;
  }
  return null;
}

/** A frame lasting 10 ms or less shows for 100 ms in a browser, as it does in a GIF viewer. */
const shownMs = (ms: number): number => (ms <= 10 ? 100 : ms);

/**
 * The copy for rooms of a moving GIF or WebP: its frames over the first SHARED_ANIM_MAX_MS, scaled down, then
 * encodeSharedAnim. Null when it doesn't decode or nothing fits.
 */
export async function sharedAnimFromImage(bytes: Uint8Array, type: 'image/gif' | 'image/webp'): Promise<Uint8Array | null> {
  let decoder: ImageDecoder | null = null;
  const frames: AnimSource[] = [];
  try {
    decoder = new ImageDecoder({ data: bytes, type });
    await Promise.all([decoder.tracks.ready, decoder.completed]);
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    let total = 0;
    for (let i = 0; i < count && total < SHARED_ANIM_MAX_MS && frames.length < SHARED_ANIM_MAX_FRAMES * 4; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        const ms = shownMs((image.duration ?? 100_000) / 1000);
        const size = fit(image.displayWidth, image.displayHeight, SHARED_ANIM_SIDE);
        frames.push({ image: await createImageBitmap(image, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }), ms });
        total += ms;
      } finally {
        image.close();
      }
    }
    return frames.length > 1 ? await encodeSharedAnim(frames) : null;
  } catch {
    return null;
  } finally {
    for (const f of frames) f.image.close();
    decoder?.close();
  }
}
