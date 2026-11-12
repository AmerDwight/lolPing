import { createHash } from 'node:crypto';
import { EMOTE_CHUNKS_MAX, SOUND_CHUNKS_MAX, type BlobMsg, type ChunkMsg, type WantMsg } from '../shared/roomProtocol';
import { checkShared, checkStill } from './emoteLibrary';

/** What travels: a custom emote's still, or the shared copy of its sound. Each has its own checks and chunk count. */
export type BlobKind = 'still' | 'sound';
const CHUNKS_MAX: Record<BlobKind, number> = { still: EMOTE_CHUNKS_MAX, sound: SOUND_CHUNKS_MAX };

/** One chunk carries this many bytes: 1,000 base64 characters, and a sealed chunk stays under the 1,200-byte packet cap. */
export const EMOTE_CHUNK_BYTES = 750;
/**
 * Over relays a file goes in `blob` parts of this many bytes instead: a relay has no datagram to fit, and a publish costs
 * the same token whatever its size, so a still or sound takes three sends where chunks take about twenty.
 */
export const BLOB_PART_BYTES = 6000;
/** Assemblies in flight at once (two members' full wheels with sounds), bytes pending in total, and how long an assembly may take. */
export const MAX_ASSEMBLIES = 36;
export const MAX_PENDING_BYTES = 256 * 1024;
export const ASSEMBLY_TIMEOUT_MS = 60_000;
/**
 * Silence from the announcer before a want is repeated; at most this many re-asks, then the hash waits for the next
 * presence. While the announcer is sending anything at all it is working through its queue, and asking again would only
 * spend the tokens both sides need. Over relays the first re-ask asks for blob parts again; later ones fall back to
 * chunks, in case a relay refuses the longer messages.
 */
export const REASK_MS = 3_000;
export const REASKS_MAX = 3;
/** Chunk pacing: LAN unicast per requester per tick; over relays a chunk or a want only goes when 5 ping tokens remain. */
export const TRANSFER_TICK_MS = 100;
export const LAN_CHUNKS_PER_TICK = 2;
/** Chunks per tick across every queue and requester: the LAN egress ceiling, ~60 KB/s however many members ask. */
export const LAN_TOTAL_CHUNKS_PER_TICK = 8;
export const RELAY_KEEP_TOKENS = 5;

interface Announced {
  stills: Set<string>;
  /** Still hash → the hash of that emote's shared sound. */
  sounds: Map<string, string>;
}

/** One way a file is arriving: its part count (0 until the first part) and the parts so far. */
interface Parts {
  n: number;
  got: Map<number, Uint8Array>;
}

interface Assembly {
  /** From the announcement that started it: decides the chunk count allowed and the check a finished one must pass. */
  kind: BlobKind;
  /** The file as chunks and as blob parts: whichever set fills first finishes it. */
  chunks: Parts;
  blobs: Parts;
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** The announcer our wants go to. */
  ask: string;
  /** The first want went out. Over relays it can wait for a spare ping token. */
  asked: boolean;
  reasks: number;
}

interface SendQueue {
  bytes: Uint8Array;
  n: number;
  /** LAN requesters: chunks go unicast, at most LAN_CHUNKS_PER_TICK per requester per tick. */
  lan: Map<string, Set<number>>;
  /** Chunks that must ride a relay: one broadcast reaches the whole room, gated by the ping bucket. */
  shared: Set<number>;
  /** Blob parts to broadcast, for requesters that read them. They go before the chunks: one finishes what many chunks would. */
  blobs: Set<number>;
}

export interface EmoteTransferDeps {
  now(): number;
  /** The still or shared sound `hash` is here already: our own library, or the cache. */
  have(hash: string, kind: BlobKind): boolean;
  /** Our own still or shared sound `hash`, when it is one we announce. */
  blob(hash: string, kind: BlobKind): Uint8Array | null;
  /** The still hashes our presence announces right now. */
  announced(): readonly string[];
  /** The shared sound hashes our presence announces right now. */
  announcedSounds(): readonly string[];
  /** The Show friends' custom emotes switch. */
  enabled(): boolean;
  /** Keeps a still or shared sound that passed the hash check and its own. */
  put(hash: string, bytes: Uint8Array, kind: BlobKind): void;
  /** How a member is reached right now: a LAN unicast, a relay broadcast, or neither. */
  routeOf(peer: string): 'lan' | 'shared' | null;
  sendToLan(peer: string, body: Record<string, unknown>): void;
  broadcastShared(body: Record<string, unknown>): void;
  /** True when a relay chunk may go: the shared bucket keeps `keep` tokens for pings and emotes. */
  spareSharedToken(keep: number): boolean;
}

/**
 * Moves custom emote stills and the shared copies of their sounds over a room, both ways. The ID is the SHA-256 prefix
 * of the bytes, so a finished assembly that doesn't hash back to it is dropped: nobody can substitute another member's
 * image or sound. Bytes are only ever written to the cache as `<hash>.webp` or `<hash>.ogg` and only ever decoded by
 * Chromium as an image or as audio; nothing here executes them.
 *
 * RoomManager emits 'emotes' (a presence's announced hashes and sounds), 'want', 'chunk' and 'memberGone'; this class answers.
 */
export class EmoteTransfer {
  private readonly announcers = new Map<string, Announced>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly sends = new Map<string, SendQueue>();
  /** When each announcer last sent us a chunk or blob part of anything it announced. */
  private readonly lastFrom = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: EmoteTransferDeps) {
    this.timer = setInterval(() => this.tick(), TRANSFER_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * A presence announced `hashes` and, in the same order, each one's shared sound ('' for none): prefetch whatever isn't
   * here yet, on the announcer's route. Stills go first, so an emote is seen before it is heard.
   */
  announced(peer: string, hashes: readonly string[], sounds: readonly string[] = []): void {
    const map = new Map<string, string>();
    hashes.forEach((hash, i) => {
      if (sounds[i]) map.set(hash, sounds[i]);
    });
    this.announcers.set(peer, { stills: new Set(hashes), sounds: map });
    if (!this.deps.enabled()) return;
    for (const hash of hashes) this.prefetch(peer, hash, 'still');
    for (const hash of map.values()) this.prefetch(peer, hash, 'sound');
  }

  /** Opens an assembly for `hash` and asks `peer` for it, unless it is here, already on its way, or too many are. */
  private prefetch(peer: string, hash: string, kind: BlobKind): void {
    if (this.deps.have(hash, kind) || this.assemblies.has(hash) || this.assemblies.size >= MAX_ASSEMBLIES) return;
    this.assemblies.set(hash, this.open(kind, peer, this.sendWant(peer, hash, [], true)));
  }

  private open(kind: BlobKind, ask: string, asked: boolean): Assembly {
    const now = this.deps.now();
    return { kind, chunks: { n: 0, got: new Map() }, blobs: { n: 0, got: new Map() }, bytes: 0, firstAt: now, lastAt: now, ask, asked, reasks: 0 };
  }

  /** The shared sound `peer` announced for the emote `hash`, or null: what plays when their emote lands here. */
  soundFor(peer: string, hash: string): string | null {
    return this.announcers.get(peer)?.sounds.get(hash) ?? null;
  }

  /** Another member asks for one of our stills or shared sounds. Only hashes in our own current announcement are served. */
  onWant(w: WantMsg): void {
    if (!this.deps.enabled()) return; // the switch stops both directions: nothing of ours leaves either
    const kind = this.ownKind(w.h);
    if (!kind) return;
    const lane = this.deps.routeOf(w.peer);
    if (lane !== 'lan' && lane !== 'shared') return;
    let queue = this.sends.get(w.h);
    if (!queue) {
      const bytes = this.deps.blob(w.h, kind); // read once per queue: a flood of wants can't make it read the disk each time
      if (!bytes) return;
      queue = { bytes, n: Math.ceil(bytes.length / EMOTE_CHUNK_BYTES), lan: new Map(), shared: new Set(), blobs: new Set() };
      this.sends.set(w.h, queue);
    }
    if (lane === 'shared' && w.big) {
      for (let i = 0; i < Math.ceil(queue.bytes.length / BLOB_PART_BYTES); i++) queue.blobs.add(i);
      return;
    }
    const want = w.need.length > 0 ? w.need.filter((i) => i < queue.n) : Array.from({ length: queue.n }, (_, i) => i);
    if (want.length === 0) return;
    if (lane === 'lan') {
      const set = queue.lan.get(w.peer) ?? new Set<number>();
      for (const i of want) set.add(i);
      queue.lan.set(w.peer, set);
    } else {
      for (const i of want) queue.shared.add(i); // a broadcast reaches the requester as well as everyone else
    }
  }

  /** One slice of a still or shared sound, from the member that announced the hash. Assemblies finish into the cache once verified. */
  onChunk(c: ChunkMsg): void {
    this.take(c, 'chunks');
  }

  /** One blob part, the same thing in larger pieces over a relay. */
  onBlob(c: BlobMsg): void {
    this.take(c, 'blobs');
  }

  private take(c: ChunkMsg | BlobMsg, as: 'chunks' | 'blobs'): void {
    if (!this.deps.enabled()) return;
    const kind = this.kindFrom(c.peer, c.h);
    if (!kind) return; // only from a member who announced that hash
    this.lastFrom.set(c.peer, this.deps.now()); // it is sending, whether or not this part is one we still need
    if (as === 'chunks' && c.n > CHUNKS_MAX[kind]) return; // more chunks than its kind can have: it could never pass the size check
    const part = Buffer.from(c.b, 'base64');
    let a = this.assemblies.get(c.h);
    if (a && a.kind !== kind) return; // two members announced one hash as different things: the first one's kind stands
    if (this.pendingBytes() + part.length > MAX_PENDING_BYTES) return;
    if (!a) {
      if (this.deps.have(c.h, kind)) return; // already stored: a straggler chunk must not open a zombie assembly
      if (this.assemblies.size >= MAX_ASSEMBLIES) return;
      a = this.open(kind, c.peer, true);
      this.assemblies.set(c.h, a);
    }
    const parts = a[as];
    if (parts.n === 0) parts.n = c.n;
    else if (parts.n !== c.n) {
      this.assemblies.delete(c.h); // one sender, two ideas about the length: drop and wait for the next presence
      return;
    }
    if (c.i >= parts.n || parts.got.has(c.i)) return;
    parts.got.set(c.i, part);
    a.bytes += part.length;
    a.lastAt = this.deps.now();
    if (parts.got.size === parts.n) this.finish(c.h, a, parts);
  }

  memberGone(peer: string): void {
    this.announcers.delete(peer);
    this.lastFrom.delete(peer);
    for (const [hash, q] of this.sends) {
      q.lan.delete(peer);
      if (q.lan.size === 0 && q.shared.size === 0 && q.blobs.size === 0) this.sends.delete(hash);
    }
    for (const [hash, a] of this.assemblies) if (a.ask === peer) this.assemblies.delete(hash);
  }

  get stats(): { assembling: number; sending: number } {
    return { assembling: this.assemblies.size, sending: this.sends.size };
  }

  /** What `hash` is in our own announcement, or null when we announce no such thing. */
  private ownKind(hash: string): BlobKind | null {
    if (this.deps.announced().includes(hash)) return 'still';
    return this.deps.announcedSounds().includes(hash) ? 'sound' : null;
  }

  /** What `peer` announced `hash` as, or null when they didn't. */
  private kindFrom(peer: string, hash: string): BlobKind | null {
    const a = this.announcers.get(peer);
    if (!a) return null;
    if (a.stills.has(hash)) return 'still';
    for (const sound of a.sounds.values()) if (sound === hash) return 'sound';
    return null;
  }

  private pendingBytes(): number {
    let total = 0;
    for (const a of this.assemblies.values()) total += a.bytes;
    return total;
  }

  /** A complete set of parts, in order: kept only when it hashes back to its ID and is a still or shared sound this app would save itself. */
  private finish(hash: string, a: Assembly, parts: Parts): void {
    this.assemblies.delete(hash);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < parts.n; i++) {
      const part = parts.got.get(i);
      if (!part) return; // finish only runs once every index is in
      pieces.push(part);
    }
    const full = new Uint8Array(Buffer.concat(pieces));
    if (createHash('sha256').update(full).digest('hex').slice(0, 32) !== hash) return;
    if ((a.kind === 'still' ? checkStill(full) : checkShared(full)) !== null) return;
    this.deps.put(hash, full, a.kind);
  }

  /**
   * False when it didn't go: no route, or no spare relay token (joining a room can find 9 hashes per member at once).
   * `big`: over a relay, say that blob parts are welcome; a LAN want never does, since they fit no LAN packet.
   */
  private sendWant(peer: string, hash: string, need: readonly number[], big = false): boolean {
    const body = { t: 'want', to: peer, h: hash, need: [...need] };
    const lane = this.deps.routeOf(peer);
    if (lane === 'lan') this.deps.sendToLan(peer, body);
    else if (lane === 'shared' && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) this.deps.broadcastShared(big ? { ...body, big: true } : body); // `to` addresses it, the seal protects it
    else return false;
    return true;
  }

  private chunkBody(hash: string, i: number, q: SendQueue): Record<string, unknown> {
    const slice = q.bytes.subarray(i * EMOTE_CHUNK_BYTES, Math.min((i + 1) * EMOTE_CHUNK_BYTES, q.bytes.length));
    return { t: 'chunk', h: hash, i, n: q.n, b: Buffer.from(slice).toString('base64') };
  }

  private blobBody(hash: string, i: number, q: SendQueue): Record<string, unknown> {
    const slice = q.bytes.subarray(i * BLOB_PART_BYTES, Math.min((i + 1) * BLOB_PART_BYTES, q.bytes.length));
    return { t: 'blob', h: hash, i, n: Math.ceil(q.bytes.length / BLOB_PART_BYTES), b: Buffer.from(slice).toString('base64') };
  }

  /** Sender pacing and receiver re-asks. Anything thrown is dropped: a timer must never take the app down. */
  private tick(): void {
    try {
      if (!this.deps.enabled()) {
        this.assemblies.clear(); // the switch stops both directions: pending work is dropped, not paused
        this.sends.clear();
        return;
      }
      let egress = 0; // chunks sent this tick, across every queue and requester
      const ours = new Set([...this.deps.announced(), ...this.deps.announcedSounds()]);
      for (const [hash, q] of [...this.sends]) {
        if (!ours.has(hash)) {
          this.sends.delete(hash); // the emote left our wheel, or its sound changed: nobody may still be served it
          continue;
        }
        for (const [peer, need] of [...q.lan]) {
          for (let k = 0; k < LAN_CHUNKS_PER_TICK && need.size > 0 && egress < LAN_TOTAL_CHUNKS_PER_TICK; k++) {
            const i = need.values().next().value as number;
            need.delete(i);
            this.deps.sendToLan(peer, this.chunkBody(hash, i, q));
            egress++;
          }
          if (need.size === 0) q.lan.delete(peer);
        }
        if ((q.blobs.size > 0 || q.shared.size > 0) && this.deps.spareSharedToken(RELAY_KEEP_TOKENS)) {
          const from = q.blobs.size > 0 ? q.blobs : q.shared;
          const i = from.values().next().value as number;
          from.delete(i);
          this.deps.broadcastShared(from === q.blobs ? this.blobBody(hash, i, q) : this.chunkBody(hash, i, q));
        }
        if (q.lan.size === 0 && q.shared.size === 0 && q.blobs.size === 0) this.sends.delete(hash);
      }
      const now = this.deps.now();
      for (const [hash, a] of [...this.assemblies]) {
        if (now - a.firstAt >= ASSEMBLY_TIMEOUT_MS || this.kindFrom(a.ask, hash) === null) {
          this.assemblies.delete(hash);
          continue;
        }
        if (!a.asked) {
          a.asked = this.sendWant(a.ask, hash, [], true);
          a.lastAt = now;
          continue;
        }
        if (now - Math.max(a.lastAt, this.lastFrom.get(a.ask) ?? 0) < REASK_MS) continue;
        if (a.reasks >= REASKS_MAX) {
          this.assemblies.delete(hash); // the next presence starts over
          continue;
        }
        const { n, got } = a.chunks;
        const need = n === 0 ? [] : Array.from({ length: n }, (_, i) => i).filter((i) => !got.has(i));
        // Blob parts once more while nothing has come at all; after that, or once chunks have started, chunks.
        if (!this.sendWant(a.ask, hash, need, a.reasks === 0 && n === 0)) continue; // waits for a token: not a re-ask yet
        a.reasks++;
        a.lastAt = now;
      }
    } catch {
      // a send that failed (a packet that wouldn't seal, a route that vanished) waits for the next tick
    }
  }
}
