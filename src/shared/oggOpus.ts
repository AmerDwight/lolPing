/** Opus always counts time in 48 kHz samples, whatever rate the sound was recorded at. */
export const OPUS_RATE = 48_000;
/** The longest one Opus packet may be: 120 ms. */
const PACKET_MAX_SAMPLES = 5760;
const PAGE_HEADER = 27;
const MAX_SEGMENTS = 255;
const FLAG_FIRST = 0x02;
const FLAG_LAST = 0x04;

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const startsWith = (b: Uint8Array, sig: readonly number[]): boolean => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const OGGS = ascii('OggS');
const OPUS_HEAD = ascii('OpusHead');
const OPUS_TAGS = ascii('OpusTags');

/** Ogg's page checksum: CRC-32 with polynomial 0x04c11db7, no reflection, starting at 0. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

/** How many 48 kHz samples one Opus packet decodes to, read from its first bytes (RFC 6716 §3.1). Null for a malformed one. */
export function opusPacketSamples(packet: Uint8Array): number | null {
  if (packet.length < 1) return null;
  const config = packet[0] >> 3;
  // SILK frames are 10, 20, 40 or 60 ms; hybrid 10 or 20 ms; CELT 2.5, 5, 10 or 20 ms.
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = packet[0] & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (packet.length < 2) return null;
    frames = packet[1] & 0x3f;
    if (frames === 0) return null;
  }
  const samples = frame * frames;
  return samples <= PACKET_MAX_SAMPLES ? samples : null;
}

function page(flags: number, granule: number, serial: number, seq: number, packets: readonly Uint8Array[]): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    for (let left = p.length; left >= 255; left -= 255) lacing.push(255);
    lacing.push(p.length % 255); // a packet that is a multiple of 255 bytes ends with a 0
  }
  const body = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(PAGE_HEADER + lacing.length + body);
  const view = new DataView(out.buffer);
  out.set(OGGS, 0);
  out[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, PAGE_HEADER);
  let at = PAGE_HEADER + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  view.setUint32(22, oggCrc(out), true);
  return out;
}

const segmentsOf = (packet: Uint8Array): number => Math.floor(packet.length / 255) + 1;

/**
 * An Ogg Opus file (RFC 7845) from an encoder's packets, in order. `samples` is the sound's real length at 48 kHz and
 * `preSkip` the encoder's delay, so a player trims both ends. Throws for a packet that isn't Opus or can't fit one page.
 */
export function muxOggOpus(packets: readonly Uint8Array[], o: { channels: 1 | 2; preSkip: number; samples: number; serial: number }): Uint8Array {
  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(OPUS_HEAD, 0);
  head[8] = 1; // version
  head[9] = o.channels;
  headView.setUint16(10, o.preSkip, true);
  headView.setUint32(12, OPUS_RATE, true); // the original rate is informative only
  const vendor = ascii('lolPing');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(OPUS_TAGS, 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const pages = [page(FLAG_FIRST, 0, o.serial, 0, [head]), page(0, 0, o.serial, 1, [tags])];
  const end = o.preSkip + o.samples;
  let decoded = 0;
  let batch: Uint8Array[] = [];
  let segments = 0;
  const flush = (last: boolean): void => {
    // The last page's position is the real end, which may fall inside its final packet: the player drops the padding.
    pages.push(page(last ? FLAG_LAST : 0, last ? Math.min(decoded, end) : decoded, o.serial, pages.length, batch));
    batch = [];
    segments = 0;
  };
  for (const p of packets) {
    const samples = opusPacketSamples(p);
    if (samples === null || segmentsOf(p) > MAX_SEGMENTS) throw new Error('not an Opus packet');
    if (segments + segmentsOf(p) > MAX_SEGMENTS) flush(false);
    batch.push(p);
    segments += segmentsOf(p);
    decoded += samples;
  }
  flush(true);
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface OggOpusInfo {
  channels: number;
  /** Everything its packets decode to, in seconds: the encoder's delay and padding included, so never less than it plays for. */
  seconds: number;
}

/**
 * Reads an Ogg Opus file's structure without decoding it: one stream, an OpusHead for mono or stereo, an OpusTags, then
 * audio packets, with nothing after the last page. The length is counted from the packets themselves, since the
 * positions written in the file are only a claim. Null for anything else.
 */
export function oggOpusInfo(bytes: Uint8Array): OggOpusInfo | null {
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let serial: number | null = null;
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < PAGE_HEADER || !startsWith(bytes.subarray(at), OGGS) || bytes[at + 4] !== 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, PAGE_HEADER);
    const pageSerial = view.getUint32(14, true);
    if (serial !== null && pageSerial !== serial) return null;
    serial = pageSerial;
    const count = bytes[at + 26];
    const table = at + PAGE_HEADER;
    let body = table + count;
    if (body > bytes.length) return null;
    for (let i = 0; i < count; i++) {
      const len = bytes[table + i];
      if (body + len > bytes.length) return null;
      pending.push(bytes.subarray(body, body + len));
      body += len;
      if (len === 255) continue; // the packet goes on in the next segment, perhaps on the next page
      const packet = new Uint8Array(pending.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of pending) {
        packet.set(p, offset);
        offset += p.length;
      }
      packets.push(packet);
      pending = [];
    }
    at = body;
  }
  if (pending.length > 0 || packets.length < 2) return null;
  const [head, tags, ...audio] = packets;
  // Version 0.x, and channel mapping family 0: one or two channels in a single stream.
  if (head.length < 19 || !startsWith(head, OPUS_HEAD) || head[8] > 15 || head[18] !== 0) return null;
  const channels = head[9];
  if (channels !== 1 && channels !== 2) return null;
  if (!startsWith(tags, OPUS_TAGS)) return null;
  let samples = 0;
  for (const p of audio) {
    const n = opusPacketSamples(p);
    if (n === null) return null;
    samples += n;
  }
  return { channels, seconds: samples / OPUS_RATE };
}
