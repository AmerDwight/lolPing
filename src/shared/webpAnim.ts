import { sniffImage, webpSize } from './imageSniff';

/** One frame of an animation: a still WebP file as Chromium's canvas encoder writes it, and how long it shows. */
export interface WebpFrame {
  file: Uint8Array;
  ms: number;
}

/** What an animated WebP holds, read from its chunks without decoding a pixel. */
export interface WebpAnimInfo {
  width: number;
  height: number;
  frames: number;
  /** The frame durations added up: one pass of the animation. */
  ms: number;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u24 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** The largest value a 24-bit field holds: a frame's duration in ms, and a canvas side minus one. */
const MAX_24 = 0xffffff;

interface Chunk {
  id: string;
  /** The whole chunk: header, payload and the pad byte an odd payload gets. */
  start: number;
  end: number;
  payload: number;
  size: number;
}

/** The chunks of a RIFF WebP between `from` and `to`, or null when one claims to run past the end. */
function chunks(b: Uint8Array, from: number, to: number): Chunk[] | null {
  const out: Chunk[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = u32(b, at + 4);
    const end = at + 8 + size + (size & 1);
    if (at + 8 + size > to) return null;
    out.push({ id: fourcc(b, at), start: at, end: Math.min(end, to), payload: at + 8, size });
    at = end;
  }
  return at >= to ? out : null;
}

/** A still WebP's image data as an ANMF frame needs it: the ALPH chunk, if any, then the VP8 or VP8L chunk. */
function frameData(file: Uint8Array): Uint8Array | null {
  if (sniffImage(file) !== 'webp' || file.length < 20) return null;
  const list = chunks(file, 12, Math.min(file.length, 8 + u32(file, 4)));
  if (!list) return null;
  const alpha = list.find((c) => c.id === 'ALPH');
  const image = list.find((c) => c.id === 'VP8 ' || c.id === 'VP8L');
  if (!image || list.some((c) => c.id === 'ANIM' || c.id === 'ANMF')) return null;
  // VP8L carries its own alpha; an ALPH chunk only belongs with lossy data.
  const parts = alpha && image.id === 'VP8 ' ? [alpha, image] : [image];
  const out = new Uint8Array(parts.reduce((n, c) => n + (c.end - c.start), 0));
  let at = 0;
  for (const c of parts) {
    out.set(file.subarray(c.start, c.end), at);
    at += c.end - c.start;
  }
  return out;
}

/** True when the still's data has transparency: an ALPH chunk, or a VP8L header with its alpha hint set. */
function hasAlpha(data: Uint8Array): boolean {
  if (fourcc(data, 0) === 'ALPH') return true;
  // VP8L: signature byte, then 14 + 14 bits of size and one bit saying whether alpha is used.
  return fourcc(data, 0) === 'VP8L' && data.length > 12 && (data[12] & 0x10) !== 0;
}

const chunk = (id: string, payload: readonly number[] | Uint8Array): number[] => {
  const body = [...payload];
  return [...ascii(id), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
};

/**
 * Builds an animated WebP from still WebP frames, each drawn whole at the top left of a `width` x `height` canvas and
 * replacing the one before. `loops` 0 plays forever. Null when a frame isn't a still WebP or is larger than the canvas.
 */
export function muxWebpAnimation(frames: readonly WebpFrame[], width: number, height: number, loops = 0): Uint8Array | null {
  if (frames.length === 0 || width < 1 || height < 1 || width - 1 > MAX_24 || height - 1 > MAX_24) return null;
  const parts: number[][] = [];
  let alpha = false;
  for (const f of frames) {
    const data = frameData(f.file);
    const size = webpSize(f.file);
    if (!data || !size || size.width > width || size.height > height) return null;
    alpha ||= hasAlpha(data);
    const ms = Math.min(MAX_24, Math.max(1, Math.round(f.ms)));
    // x/2 and y/2 (0), width - 1, height - 1, duration, then flags: no blending (bit 1), keep the frame (bit 0 clear).
    parts.push(chunk('ANMF', [...le24(0), ...le24(0), ...le24(size.width - 1), ...le24(size.height - 1), ...le24(ms), 0x02, ...data]));
  }
  const vp8x = chunk('VP8X', [(alpha ? 0x10 : 0) | 0x02, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
  const anim = chunk('ANIM', [0, 0, 0, 0, loops & 0xff, (loops >> 8) & 0xff]);
  const body = [...ascii('WEBP'), ...vp8x, ...anim, ...parts.flat()];
  return Uint8Array.from([...ascii('RIFF'), ...le32(body.length), ...body]);
}

/**
 * The canvas, frame count and length of an animated WebP, from its VP8X, ANIM and ANMF chunks. Null for a still WebP,
 * anything else, or a file whose chunks don't add up.
 */
export function webpAnimInfo(bytes: Uint8Array): WebpAnimInfo | null {
  if (sniffImage(bytes) !== 'webp' || bytes.length < 30 || fourcc(bytes, 12) !== 'VP8X' || (bytes[20] & 0x02) === 0) return null;
  const list = chunks(bytes, 12, Math.min(bytes.length, 8 + u32(bytes, 4)));
  if (!list) return null;
  let frames = 0;
  let ms = 0;
  for (const c of list) {
    if (c.id !== 'ANMF') continue;
    if (c.size < 16) return null;
    frames++;
    ms += u24(bytes, c.payload + 12);
  }
  if (frames === 0) return null;
  return { width: u24(bytes, 24) + 1, height: u24(bytes, 27) + 1, frames, ms };
}

/** `count` whole-millisecond durations that add up to `totalMs` exactly, as even as whole numbers allow. */
export function frameDurations(totalMs: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round(((i + 1) * totalMs) / count) - Math.round((i * totalMs) / count));
  return out;
}
