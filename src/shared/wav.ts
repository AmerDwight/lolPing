const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * 16-bit PCM WAV of `channels` (one Float32Array of -1..1 samples each, all the same length) at `sampleRate`. Samples
 * outside -1..1 are clipped. Used for a video emote's sound, which then plays like any picked WAV.
 */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const count = channels.length;
  const frames = count > 0 ? Math.min(...channels.map((c) => c.length)) : 0;
  const data = frames * count * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  out.set(ascii('RIFF'), 0);
  view.setUint32(4, 36 + data, true);
  out.set(ascii('WAVEfmt '), 8);
  view.setUint32(16, 16, true); // the fmt chunk's size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true); // bytes per second
  view.setUint16(32, count * 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  out.set(ascii('data'), 36);
  view.setUint32(40, data, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      view.setInt16(at, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true);
      at += 2;
    }
  }
  return out;
}
