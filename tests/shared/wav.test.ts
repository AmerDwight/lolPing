import { describe, expect, it } from 'vitest';
import { sniffAudio } from '../../src/shared/audioSniff';
import { encodeWav } from '../../src/shared/wav';

const text = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

describe('encodeWav', () => {
  it('writes a 16-bit PCM WAV header that names its channels, rate and length', () => {
    const wav = encodeWav([new Float32Array(100), new Float32Array(100)], 44_100);
    const v = new DataView(wav.buffer);
    expect(sniffAudio(wav)).toBe('wav');
    expect(text(wav, 12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44_100);
    expect(v.getUint32(28, true)).toBe(44_100 * 4);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(wav, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(400);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(wav.length).toBe(444);
  });

  it('interleaves the channels and clips samples outside -1..1', () => {
    const wav = encodeWav([Float32Array.from([1, -1, 0.5]), Float32Array.from([2, -3, 0])], 8000);
    const v = new DataView(wav.buffer);
    const samples = Array.from({ length: 6 }, (_, i) => v.getInt16(44 + i * 2, true));
    expect(samples).toEqual([32767, 32767, -32768, -32768, 16384, 0]);
  });

  it('keeps 5 seconds of stereo at 44.1 kHz under the 1 MB a sound may have', () => {
    const five = new Float32Array(5 * 44_100);
    expect(encodeWav([five, five], 44_100).length).toBeLessThan(1_048_576);
  });
});
