import { describe, expect, it } from 'vitest';
import {
  clipArtSize, clipAttempts, clipFrames, dragClip, dragEnd, dragStart, formatClock, initialRange, keptScale,
} from '../../src/renderer/settings/clipRange';

describe('initialRange', () => {
  it('is the first 5 seconds, or all of a shorter video', () => {
    expect(initialRange(30)).toEqual({ start: 0, end: 5 });
    expect(initialRange(2.5)).toEqual({ start: 0, end: 2.5 });
  });

  it('is null for a video too short to make a clip from, or one without a length', () => {
    expect(initialRange(0.2)).toBeNull();
    expect(initialRange(Number.NaN)).toBeNull();
    expect(initialRange(Number.POSITIVE_INFINITY)).toBeNull(); // a live stream says its length is infinite
  });
});

describe('dragStart', () => {
  it('moves the start and leaves the end while the length allows it', () => {
    expect(dragStart({ start: 2, end: 6 }, 3, 20)).toEqual({ start: 3, end: 6 });
  });

  it('pulls the end along so the clip is never longer than 5 seconds nor shorter than 0.3', () => {
    expect(dragStart({ start: 2, end: 6 }, 0, 20)).toEqual({ start: 0, end: 5 });
    expect(dragStart({ start: 2, end: 6 }, 5.9, 20).end).toBeCloseTo(6.2);
  });

  it('stays inside the video', () => {
    expect(dragStart({ start: 2, end: 6 }, -4, 20).start).toBe(0);
    const late = dragStart({ start: 2, end: 6 }, 25, 20);
    expect(late.start).toBeCloseTo(19.7);
    expect(late.end).toBe(20);
  });
});

describe('dragEnd', () => {
  it('moves the end and leaves the start while the length allows it', () => {
    expect(dragEnd({ start: 2, end: 6 }, 4, 20)).toEqual({ start: 2, end: 4 });
  });

  it('pulls the start along at either length limit, and stays inside the video', () => {
    expect(dragEnd({ start: 2, end: 6 }, 9, 20)).toEqual({ start: 4, end: 9 });
    expect(dragEnd({ start: 2, end: 6 }, 2.1, 20).start).toBeCloseTo(1.8);
    expect(dragEnd({ start: 2, end: 6 }, 30, 20)).toEqual({ start: 15, end: 20 });
    expect(dragEnd({ start: 0, end: 3 }, 0, 20)).toEqual({ start: 0, end: 0.3 });
  });
});

describe('dragClip', () => {
  it('slides the clip, keeping its length, and stops at either end of the video', () => {
    expect(dragClip({ start: 2, end: 5 }, 1.5, 20)).toEqual({ start: 3.5, end: 6.5 });
    expect(dragClip({ start: 2, end: 5 }, -10, 20)).toEqual({ start: 0, end: 3 });
    expect(dragClip({ start: 2, end: 5 }, 30, 20)).toEqual({ start: 17, end: 20 });
  });
});

describe('clipFrames', () => {
  it('takes a frame every 1/fps seconds from the start, and the durations add up to the clip', () => {
    const frames = clipFrames({ start: 1, end: 3 }, 20);
    expect(frames).toHaveLength(40);
    expect(frames[0].at).toBe(1);
    expect(frames[1].at).toBeCloseTo(1.05);
    expect(frames.at(-1)?.at).toBeCloseTo(2.95);
    expect(frames.reduce((n, f) => n + f.ms, 0)).toBe(2000);
  });

  it('takes at least one frame', () => {
    expect(clipFrames({ start: 0, end: 0.01 }, 10)).toEqual([{ at: 0, ms: 10 }]);
  });
});

describe('clipAttempts', () => {
  it('goes from smooth and large to choppy and small, never larger than the video', () => {
    const tries = clipAttempts(1920);
    expect(tries.map((t) => t.side)).toEqual([640, 480, 360, 240]);
    expect(tries.map((t) => t.fps)).toEqual([20, 15, 12, 10]);
    expect(clipAttempts(300).map((t) => t.side)).toEqual([300, 300, 300, 240]);
  });
});

describe('formatClock', () => {
  it('shows minutes, seconds and tenths', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(4.96)).toBe('0:05.0');
    expect(formatClock(65.24)).toBe('1:05.2');
    expect(formatClock(599.99)).toBe('10:00.0');
  });
});

describe('clipArtSize', () => {
  it('is the video scaled down to 640 px on its longest side, or as it is when smaller', () => {
    expect(clipArtSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(clipArtSize(1080, 1920)).toEqual({ width: 360, height: 640 });
    expect(clipArtSize(320, 240)).toEqual({ width: 320, height: 240 });
  });
});

describe('keptScale', () => {
  it('keeps the chosen scale when the animation came out at the planned size', () => {
    expect(keptScale(150, 640, 640)).toBe(150);
  });

  it('raises it when a smaller attempt fitted, so the clip shows as big as chosen', () => {
    expect(keptScale(100, 640, 480)).toBe(133);
    expect(keptScale(50, 640, 320)).toBe(100);
  });

  it('stays within 10–300%', () => {
    expect(keptScale(300, 640, 240)).toBe(300);
  });
});
