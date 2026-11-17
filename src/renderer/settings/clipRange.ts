import { CLIP_MAX_S, CLIP_MIN_S } from '../../shared/emotes';
import { frameDurations } from '../../shared/webpAnim';

/** The part of a video that becomes an emote, in seconds from its start. */
export interface ClipRange {
  start: number;
  end: number;
}

/** One way to encode a clip's frames: frames per second, the longest side in px and the WebP quality. */
export interface ClipAttempt {
  fps: number;
  side: number;
  quality: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The clip a video starts with: its first CLIP_MAX_S seconds, or all of it. Null when it is too short to make one from. */
export function initialRange(duration: number): ClipRange | null {
  if (!Number.isFinite(duration) || duration < CLIP_MIN_S) return null;
  return { start: 0, end: Math.min(CLIP_MAX_S, duration) };
}

/** Moves the start to `t`. The end follows only as far as the clip's shortest and longest lengths need. */
export function dragStart(r: ClipRange, t: number, duration: number): ClipRange {
  const start = clamp(t, 0, duration - CLIP_MIN_S);
  return { start, end: clamp(r.end, start + CLIP_MIN_S, Math.min(duration, start + CLIP_MAX_S)) };
}

/** Moves the end to `t`. The start follows only as far as the clip's shortest and longest lengths need. */
export function dragEnd(r: ClipRange, t: number, duration: number): ClipRange {
  const end = clamp(t, CLIP_MIN_S, duration);
  return { start: clamp(r.start, Math.max(0, end - CLIP_MAX_S), end - CLIP_MIN_S), end };
}

/** Slides the whole clip by `delta` seconds, keeping its length, and stops at either end of the video. */
export function dragClip(r: ClipRange, delta: number, duration: number): ClipRange {
  const length = r.end - r.start;
  const start = clamp(r.start + delta, 0, duration - length);
  return { start, end: start + length };
}

/** When each frame is taken and how long it shows, in ms: about `fps` a second, adding up to the clip's length exactly. */
export function clipFrames(r: ClipRange, fps: number): { at: number; ms: number }[] {
  const length = r.end - r.start;
  const count = Math.max(1, Math.round(length * fps));
  return frameDurations(Math.round(length * 1000), count).map((ms, i) => ({ at: r.start + (i * length) / count, ms }));
}

/**
 * The encodings a clip's full-size animation tries, in order, until one fits ANIM_MAX_BYTES: smoother and larger first.
 * A side never goes past the video's own `longest` side.
 */
export function clipAttempts(longest: number): ClipAttempt[] {
  return [
    { fps: 20, side: 640, quality: 0.7 },
    { fps: 15, side: 480, quality: 0.6 },
    { fps: 12, side: 360, quality: 0.55 },
    { fps: 10, side: 240, quality: 0.5 },
  ].map((a) => ({ ...a, side: Math.min(a.side, longest) }));
}

/** A time in a video as m:ss.t, the way the trim dialog shows it. */
export function formatClock(s: number): string {
  const tenths = Math.max(0, Math.round(s * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
