import { muxOggOpus, OPUS_RATE } from '../../../src/shared/oggOpus';

/**
 * A well-formed mono Ogg Opus file of about `seconds`: 20 ms packets whose first byte says so and whose rest is `seed`.
 * No decoder would make music of it; the structure is all the app's own checks read.
 */
export function opusSound(seconds = 1, seed = 1, packetBytes = 40): Uint8Array {
  const count = Math.round(seconds * 50);
  const packet = new Uint8Array(packetBytes).fill(seed);
  packet[0] = 0xf8; // CELT fullband, one 20 ms frame
  return muxOggOpus(Array.from({ length: count }, () => packet), { channels: 1, preSkip: 312, samples: Math.round(seconds * OPUS_RATE), serial: seed });
}
