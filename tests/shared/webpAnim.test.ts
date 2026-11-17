import { describe, expect, it } from 'vitest';
import { isAnimatedWebp, webpSize } from '../../src/shared/imageSniff';
import { frameDurations, muxWebpAnimation, webpAnimInfo } from '../../src/shared/webpAnim';

const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'));
// 8 x 6 stills as libwebp writes them: lossy, lossless, and lossy with an alpha channel (VP8X + ALPH + VP8).
const LOSSY = b64('UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoIAAYAAsBMJaACdLoAA5gA/uwmX18AU9Uf/OJfyR+gXaAAAAA=');
const LOSSLESS = b64('UklGRiIAAABXRUJQVlA4TBYAAAAvB0ABAAdQlCIXpf8BgCD8b5uI6H8I');
const ALPHA = b64('UklGRmAAAABXRUJQVlA4WAoAAAAQAAAABwAABQAAQUxQSA8AAAABB1DAiAgABOF/20RE/0MAVlA4ICoAAADwAQCdASoIAAYAAsBMJaACdLoB+AAGQgAA+47/4VbhiGar/5SrwWNzfAA=');
const SMALL = b64('UklGRjgAAABXRUJQVlA4ICwAAABwAQCdASoEAAQAAsBMJaACdAFAAAD+9Bi3/pNn/9Js//pNnySKTiCjoAAAAA==');

const fourccs = (b: Uint8Array): string[] => {
  const out: string[] = [];
  for (let at = 12; at + 8 <= b.length;) {
    const size = b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24);
    out.push(String.fromCharCode(...b.subarray(at, at + 4)));
    at += 8 + size + (size & 1);
  }
  return out;
};

describe('muxWebpAnimation', () => {
  it('builds an animated WebP whose header, canvas and frames read back', () => {
    const anim = muxWebpAnimation([{ file: LOSSY, ms: 50 }, { file: LOSSLESS, ms: 60 }, { file: LOSSY, ms: 40 }], 8, 6);
    expect(anim).not.toBeNull();
    const file = anim as Uint8Array;
    expect(isAnimatedWebp(file)).toBe(true);
    expect(webpSize(file)).toEqual({ width: 8, height: 6 });
    expect(webpAnimInfo(file)).toEqual({ width: 8, height: 6, frames: 3, ms: 150 });
    expect(fourccs(file)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF']);
    // The RIFF size covers everything after the first 8 bytes.
    expect(file[4] | (file[5] << 8) | (file[6] << 16) | (file[7] << 24)).toBe(file.length - 8);
  });

  it('marks the animation as having alpha only when a frame has some', () => {
    const opaque = muxWebpAnimation([{ file: LOSSY, ms: 50 }], 8, 6) as Uint8Array;
    const clear = muxWebpAnimation([{ file: LOSSY, ms: 50 }, { file: ALPHA, ms: 50 }], 8, 6) as Uint8Array;
    expect(opaque[20] & 0x10).toBe(0);
    expect(clear[20] & 0x10).toBe(0x10);
  });

  it('keeps a frame\'s ALPH chunk with its image data', () => {
    const anim = muxWebpAnimation([{ file: ALPHA, ms: 50 }], 8, 6) as Uint8Array;
    const text = Buffer.from(anim).toString('latin1');
    const anmf = text.indexOf('ANMF');
    expect(text.indexOf('ALPH', anmf)).toBeGreaterThan(anmf);
    expect(text.indexOf('VP8 ', anmf)).toBeGreaterThan(text.indexOf('ALPH', anmf));
    expect(text.includes('VP8X', anmf)).toBe(false); // the still's own header stays out of the frame
  });

  it('plays forever unless told how many loops, and stores them in ANIM', () => {
    const loopAt = (b: Uint8Array): number => {
      const at = Buffer.from(b).indexOf('ANIM') + 8 + 4;
      return b[at] | (b[at + 1] << 8);
    };
    expect(loopAt(muxWebpAnimation([{ file: LOSSY, ms: 50 }], 8, 6) as Uint8Array)).toBe(0);
    expect(loopAt(muxWebpAnimation([{ file: LOSSY, ms: 50 }], 8, 6, 1) as Uint8Array)).toBe(1);
  });

  it('places a smaller frame at the top left of the canvas', () => {
    const anim = muxWebpAnimation([{ file: SMALL, ms: 30 }, { file: LOSSY, ms: 30 }], 8, 6) as Uint8Array;
    expect(webpAnimInfo(anim)).toEqual({ width: 8, height: 6, frames: 2, ms: 60 });
  });

  it('refuses frames that are not still WebPs or do not fit the canvas, and an empty list', () => {
    expect(muxWebpAnimation([], 8, 6)).toBeNull();
    expect(muxWebpAnimation([{ file: LOSSY, ms: 50 }], 4, 4)).toBeNull();
    expect(muxWebpAnimation([{ file: Uint8Array.from([1, 2, 3]), ms: 50 }], 8, 6)).toBeNull();
    const anim = muxWebpAnimation([{ file: LOSSY, ms: 50 }], 8, 6) as Uint8Array;
    expect(muxWebpAnimation([{ file: anim, ms: 50 }], 8, 6)).toBeNull();
  });

  it('stores at least 1 ms for each frame', () => {
    const anim = muxWebpAnimation([{ file: LOSSY, ms: 0 }, { file: LOSSY, ms: 0.4 }], 8, 6) as Uint8Array;
    expect(webpAnimInfo(anim)?.ms).toBe(2);
  });
});

describe('webpAnimInfo', () => {
  it('is null for a still WebP and for anything that is not a WebP', () => {
    expect(webpAnimInfo(LOSSY)).toBeNull();
    expect(webpAnimInfo(ALPHA)).toBeNull();
    expect(webpAnimInfo(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
  });

  it('is null when a chunk claims to run past the end of the file', () => {
    const anim = muxWebpAnimation([{ file: LOSSY, ms: 50 }, { file: LOSSY, ms: 50 }], 8, 6) as Uint8Array;
    expect(webpAnimInfo(anim.subarray(0, anim.length - 10))).toBeNull();
  });
});

describe('frameDurations', () => {
  it('adds up to the total exactly, with durations a millisecond apart at most', () => {
    const d = frameDurations(5000, 75);
    expect(d).toHaveLength(75);
    expect(d.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(Math.max(...d) - Math.min(...d)).toBeLessThanOrEqual(1);
  });

  it('gives whole frames for an even split', () => {
    expect(frameDurations(1000, 20)).toEqual(Array(20).fill(50));
  });
});
