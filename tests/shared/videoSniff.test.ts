import { describe, expect, it } from 'vitest';
import { sniffVideo } from '../../src/shared/videoSniff';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const box = (type: string): Uint8Array => Uint8Array.from([0, 0, 0, 0x20, ...ascii(type), ...ascii('isom'), 0, 0, 2, 0]);

describe('sniffVideo', () => {
  it('names MP4, M4V and MOV files by their first box', () => {
    expect(sniffVideo(box('ftyp'))).toBe('mp4');
    expect(sniffVideo(box('moov'))).toBe('mp4'); // an old QuickTime file starts with its movie box
    expect(sniffVideo(box('wide'))).toBe('mp4');
  });

  it('names WebM and Matroska files by their EBML header', () => {
    expect(sniffVideo(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]))).toBe('webm');
  });

  it('returns null for anything else, whatever it is called', () => {
    expect(sniffVideo(new Uint8Array())).toBeNull();
    expect(sniffVideo(Uint8Array.from(ascii('GIF89a.......')))).toBeNull();
    expect(sniffVideo(Uint8Array.from([0, 0, 0, 0x20, ...ascii('ftp')]))).toBeNull(); // cut short
    expect(sniffVideo(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI ')]))).toBeNull();
  });
});
