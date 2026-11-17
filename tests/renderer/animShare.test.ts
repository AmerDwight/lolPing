import { describe, expect, it } from 'vitest';
import { baseStep, SHARE_ANIM_ATTEMPTS, stepFrames, trimDurations } from '../../src/renderer/shared/animShare';

describe('trimDurations', () => {
  it('keeps the frames that start within 5.2 s, the last one shortened to fit', () => {
    expect(trimDurations([2000, 2000, 2000, 2000])).toEqual([2000, 2000, 1200]);
    expect(trimDurations([100, 100])).toEqual([100, 100]);
  });
});

describe('baseStep', () => {
  it('keeps every frame of a clip at 12 frames a second or fewer', () => {
    expect(baseStep(Array(50).fill(100))).toBe(1); // 10 fps
    expect(baseStep(Array(60).fill(1000 / 12))).toBe(1);
  });

  it('keeps every other frame of a 20 fps clip, and fewer of a faster one', () => {
    expect(baseStep(Array(100).fill(50))).toBe(2);
    expect(baseStep(Array(150).fill(1000 / 30))).toBe(3);
  });

  it('never keeps more than 100 frames', () => {
    expect(baseStep(Array(300).fill(17))).toBeGreaterThanOrEqual(3);
  });
});

describe('stepFrames', () => {
  it('keeps every step-th frame, each lasting the frames it stands for', () => {
    expect(stepFrames([50, 50, 50, 50, 50], 2)).toEqual([{ index: 0, ms: 100 }, { index: 2, ms: 100 }, { index: 4, ms: 50 }]);
    expect(stepFrames([10, 20], 1)).toEqual([{ index: 0, ms: 10 }, { index: 1, ms: 20 }]);
  });
});

describe('SHARE_ANIM_ATTEMPTS', () => {
  it('only gets smaller from one attempt to the next', () => {
    for (let i = 1; i < SHARE_ANIM_ATTEMPTS.length; i++) {
      const [a, b] = [SHARE_ANIM_ATTEMPTS[i - 1], SHARE_ANIM_ATTEMPTS[i]];
      expect(b.side * b.quality / b.step).toBeLessThan(a.side * a.quality / a.step);
    }
  });
});
