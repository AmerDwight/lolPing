import { describe, expect, it } from 'vitest';
import { preSkipOf, SHARE_BITRATES } from '../../src/renderer/shared/soundShare';

const head = (preSkip: number, magic = 'OpusHead'): Uint8Array => {
  const b = new Uint8Array(19);
  b.set([...magic].map((c) => c.charCodeAt(0)));
  b[8] = 1;
  b[9] = 1;
  b[10] = preSkip & 0xff;
  b[11] = preSkip >> 8;
  return b;
};

describe('preSkipOf', () => {
  it('reads the encoder’s delay from its OpusHead', () => {
    expect(preSkipOf(head(312))).toBe(312);
    expect(preSkipOf(head(3840))).toBe(3840);
  });

  it('falls back to libopus’s usual delay when the encoder reports nothing it can read', () => {
    expect(preSkipOf(null)).toBe(312);
    expect(preSkipOf(head(100).subarray(0, 12))).toBe(312);
    expect(preSkipOf(head(100, 'OpusTags'))).toBe(312);
  });
});

describe('SHARE_BITRATES', () => {
  it('tries the highest quality first', () => {
    expect([...SHARE_BITRATES]).toEqual([...SHARE_BITRATES].sort((a, b) => b - a));
  });
});
