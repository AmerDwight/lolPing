import { describe, expect, it } from 'vitest';
import { muxOggOpus, oggOpusInfo, opusPacketSamples, OPUS_RATE } from '../../src/shared/oggOpus';

/** One Opus packet: `toc`, then filler up to `size` bytes. */
const packet = (toc: number, size = 40, second = 0): Uint8Array => {
  const p = new Uint8Array(size).fill(7);
  p[0] = toc;
  if (size > 1) p[1] = second || 7;
  return p;
};
const CELT_20MS = 0xf8;
const mux = (packets: Uint8Array[], samples = packets.length * 960): Uint8Array =>
  muxOggOpus(packets, { channels: 1, preSkip: 312, samples, serial: 0xabcdef });
const le32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint32(at, true);

describe('opusPacketSamples', () => {
  it.each([
    ['SILK 10 ms', 0 << 3, 480],
    ['SILK 60 ms', 3 << 3, 2880],
    ['hybrid 20 ms', 13 << 3, 960],
    ['CELT 2.5 ms', 16 << 3, 120],
    ['CELT 20 ms', 31 << 3, 960],
    ['two CELT 20 ms frames', (31 << 3) | 1, 1920],
    ['two frames of different sizes', (31 << 3) | 2, 1920],
  ])('reads %s from the first byte', (_label, toc, samples) => {
    expect(opusPacketSamples(packet(toc))).toBe(samples);
  });

  it('reads the frame count of a multi-frame packet from its second byte', () => {
    expect(opusPacketSamples(packet((31 << 3) | 3, 40, 6))).toBe(5760);
    expect(opusPacketSamples(packet((31 << 3) | 3, 40, 0x80 | 3))).toBe(2880); // the padding and VBR bits aren't part of the count
  });

  it('refuses an empty packet, a frame count of 0, a missing count, and more than 120 ms', () => {
    expect(opusPacketSamples(new Uint8Array(0))).toBeNull();
    expect(opusPacketSamples(packet((31 << 3) | 3, 40, 0x40))).toBeNull();
    expect(opusPacketSamples(packet((31 << 3) | 3, 1))).toBeNull();
    expect(opusPacketSamples(packet((31 << 3) | 3, 40, 7))).toBeNull(); // 7 × 20 ms
    expect(opusPacketSamples(packet((3 << 3) | 3, 40, 3))).toBeNull(); // 3 × 60 ms
  });
});

describe('muxOggOpus', () => {
  it('writes an OpusHead page, an OpusTags page, then the audio, each page starting OggS', () => {
    const file = mux([packet(CELT_20MS), packet(CELT_20MS)]);
    const text = Buffer.from(file).toString('latin1');
    expect(text.startsWith('OggS')).toBe(true);
    expect(text.indexOf('OpusHead')).toBe(28); // 27 header bytes and a one-entry segment table
    expect(text.indexOf('OpusTags')).toBeGreaterThan(text.indexOf('OpusHead'));
    expect(text.split('OggS').length - 1).toBe(3);
    expect(file[5]).toBe(0x02); // the first page begins the stream
  });

  it('gives a page the checksum an Ogg reader computes', () => {
    // The OpusHead page for these options. The value was checked with the routine that reproduces the checksums of
    // every page in a file written by ffmpeg.
    expect(le32(mux([packet(CELT_20MS)]), 22)).toBe(0x0978eb68);
  });

  it('ends on the sound’s real length, which may fall inside the last packet', () => {
    const file = mux([packet(CELT_20MS), packet(CELT_20MS), packet(CELT_20MS)], 2000);
    const last = Buffer.from(file).lastIndexOf('OggS');
    expect(file[last + 5]).toBe(0x04); // the last page ends the stream
    expect(le32(file, last + 6)).toBe(312 + 2000);
  });

  it('starts a new page when a page’s 255 segments are full, and splits a packet of 255 bytes or more over segments', () => {
    const many = mux(Array.from({ length: 300 }, () => packet(CELT_20MS, 10)));
    expect(Buffer.from(many).toString('latin1').split('OggS').length - 1).toBe(4);
    expect(oggOpusInfo(many)).toEqual({ channels: 1, seconds: 6 });
    const big = mux([packet(CELT_20MS, 255), packet(CELT_20MS, 600)]);
    expect(oggOpusInfo(big)).toEqual({ channels: 1, seconds: 0.04 });
  });

  it('throws for a packet that is not Opus', () => {
    expect(() => mux([new Uint8Array(0)])).toThrow();
  });
});

describe('oggOpusInfo', () => {
  const good = mux(Array.from({ length: 50 }, () => packet(CELT_20MS)));

  it('counts the length from the packets, not from the positions the file claims', () => {
    expect(oggOpusInfo(good)).toEqual({ channels: 1, seconds: 1 });
    const lying = mux(Array.from({ length: 50 }, () => packet(CELT_20MS)), 10);
    expect(oggOpusInfo(lying)).toEqual({ channels: 1, seconds: 1 });
    expect(OPUS_RATE).toBe(48_000);
  });

  it('counts tiny packets at their full length: a small file can hold minutes', () => {
    const silent = mux(Array.from({ length: 6000 }, () => packet((3 << 3) | 0, 1))); // one-byte 60 ms SILK frames
    expect(silent.length).toBeLessThan(16_384);
    expect(oggOpusInfo(silent)?.seconds).toBe(360);
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['cut short', good.subarray(0, good.length - 5)],
    ['with bytes after the last page', Uint8Array.from([...good, 1, 2, 3])],
    ['not Ogg', Uint8Array.from([...'RIFF0000WAVE'].map((c) => c.charCodeAt(0)))],
    ['headers only, cut after the first page', good.subarray(0, 47)],
  ])('refuses a file that is %s', (_label, bytes) => {
    expect(oggOpusInfo(bytes)).toBeNull();
  });

  it('refuses another stream version, a second stream, more than two channels, and a missing OpusTags', () => {
    const version = good.slice();
    version[4] = 1;
    expect(oggOpusInfo(version)).toBeNull();
    const other = mux([packet(CELT_20MS)]);
    new DataView(other.buffer).setUint32(14, 99, true); // the first page now belongs to another stream
    expect(oggOpusInfo(other)).toBeNull();
    const surround = good.slice();
    surround[28 + 9] = 6;
    expect(oggOpusInfo(surround)).toBeNull();
    const untagged = good.slice();
    untagged.set([...'OpusTagz'].map((c) => c.charCodeAt(0)), Buffer.from(good).indexOf('OpusTags'));
    expect(oggOpusInfo(untagged)).toBeNull();
  });

  it('refuses a file whose audio holds a malformed packet', () => {
    const bad = mux([packet(CELT_20MS), packet(CELT_20MS)]);
    const last = Buffer.from(bad).lastIndexOf('OggS');
    bad[last + 27 + 2] = (31 << 3) | 3; // the first audio packet now claims a frame count…
    bad[last + 27 + 3] = 0; // …of none
    expect(oggOpusInfo(bad)).toBeNull();
  });
});
