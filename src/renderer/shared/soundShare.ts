import { SHARED_SOUND_MAX_BYTES } from '../../shared/emotes';
import { OPUS_RATE, muxOggOpus } from '../../shared/oggOpus';

/** Tried in order until the file fits SHARED_SOUND_MAX_BYTES: a short sound keeps the highest quality. */
export const SHARE_BITRATES: readonly number[] = [32_000, 24_000, 20_000, 16_000, 12_000];
/** libopus's delay at 48 kHz, used when the encoder doesn't report its own. */
const DEFAULT_PRE_SKIP = 312;
/** Samples handed to the encoder at a time: 100 ms. */
const BLOCK = 4800;

const OPUS_HEAD = [...'OpusHead'].map((c) => c.charCodeAt(0));

/** The delay an encoder reports in its OpusHead (bytes 10–11), or libopus's usual one when it reports none. */
export function preSkipOf(description: Uint8Array | null): number {
  if (!description || description.length < 19 || !OPUS_HEAD.every((v, i) => description[i] === v)) return DEFAULT_PRE_SKIP;
  return description[10] | (description[11] << 8);
}

const bytesOf = (b: AllowSharedBufferSource): Uint8Array =>
  (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));

/** `mono` (48 kHz samples) as Opus packets at about `bitrate`, with the encoder's delay. */
async function encodeOpus(mono: Float32Array, bitrate: number): Promise<{ packets: Uint8Array[]; preSkip: number }> {
  const packets: Uint8Array[] = [];
  let head: Uint8Array | null = null;
  let failed: Error | null = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      packets.push(packet);
      const description = meta?.decoderConfig?.description;
      if (description && !head) head = bytesOf(description).slice();
    },
    error: (err) => {
      failed = err;
    },
  });
  try {
    encoder.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate });
    for (let at = 0; at < mono.length; at += BLOCK) {
      const data = mono.slice(at, Math.min(at + BLOCK, mono.length));
      const frame = new AudioData({
        format: 'f32-planar', sampleRate: OPUS_RATE, numberOfChannels: 1, numberOfFrames: data.length,
        timestamp: Math.round((at / OPUS_RATE) * 1_000_000), data,
      });
      encoder.encode(frame);
      frame.close();
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failed) throw failed;
  return { packets, preSkip: preSkipOf(head) };
}

/**
 * The copy of a decoded sound that room members get: mono Ogg Opus of at most SHARED_SOUND_MAX_BYTES, at the highest of
 * SHARE_BITRATES that fits. Null when this Chromium can't encode Opus or nothing fits; the sound then plays here only.
 */
export async function encodeShared(decoded: AudioBuffer): Promise<Uint8Array | null> {
  try {
    if (typeof AudioEncoder === 'undefined' || decoded.length === 0) return null;
    // Rendering through a one-channel 48 kHz context mixes the channels down and resamples in one step.
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * OPUS_RATE)), OPUS_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const mono = (await offline.startRendering()).getChannelData(0);
    for (const bitrate of SHARE_BITRATES) {
      const { packets, preSkip } = await encodeOpus(mono, bitrate);
      const file = muxOggOpus(packets, { channels: 1, preSkip, samples: mono.length, serial: crypto.getRandomValues(new Uint32Array(1))[0] });
      if (file.length <= SHARED_SOUND_MAX_BYTES) return file;
    }
    return null;
  } catch {
    return null;
  }
}
