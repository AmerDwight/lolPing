import { createHash } from 'node:crypto';
import type { CustomEmote, EmoteRef } from '../shared/emotes';

/** How long a renderer may take to encode one sound before the next is tried, and how often one sound is handed out. */
export const ENCODE_TIMEOUT_MS = 30_000;
export const ENCODE_ATTEMPTS = 3;

export interface ShareBackfillDeps {
  now(): number;
  /** Our imported emotes, as settings have them now. */
  emotes(): readonly CustomEmote[];
  /** The emote's stored sound, or null when the file is gone. */
  readSound(id: EmoteRef): Promise<Uint8Array | null>;
  /** Hands the sound to a renderer to encode; its answer comes back through `onResult`. False when none can take it. */
  encode(id: EmoteRef, sound: Uint8Array): boolean;
  /** Checks and keeps the copy, and records it on the emote. */
  save(id: EmoteRef, share: Uint8Array): Promise<void>;
}

const digest = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * Gives every imported emote's sound its copy for rooms. A sound picked in the settings window gets one there; this covers
 * the rest: a sound added before sounds travelled, or one whose copy was lost. Main has no audio encoder, so each sound
 * goes to a renderer, one at a time, and a copy is kept only if the sound on disk is still the one that was sent.
 */
export class ShareBackfill {
  private pending: { id: EmoteRef; sound: string; at: number } | null = null;
  private readonly attempts = new Map<EmoteRef, number>();
  private starting = false;

  constructor(private readonly deps: ShareBackfillDeps) {}

  /** Emotes whose sound has no copy for rooms: room members can't hear these yet. */
  missing(): number {
    return this.deps.emotes().filter((c) => c.sound && !c.share).length;
  }

  /** Starts the next sound that still needs a copy, unless one is being encoded. Safe to call often. */
  async run(): Promise<void> {
    if (this.starting) return;
    if (this.pending && this.deps.now() - this.pending.at < ENCODE_TIMEOUT_MS) return;
    this.pending = null;
    const next = this.deps.emotes().find((c) => c.sound && !c.share && (this.attempts.get(c.id) ?? 0) < ENCODE_ATTEMPTS);
    if (!next) return;
    this.starting = true;
    try {
      const sound = await this.deps.readSound(next.id);
      this.attempts.set(next.id, (this.attempts.get(next.id) ?? 0) + 1);
      if (sound && this.deps.encode(next.id, sound)) this.pending = { id: next.id, sound: digest(sound), at: this.deps.now() };
    } finally {
      this.starting = false;
    }
  }

  /** A renderer's answer: the copy, or null when it couldn't make one. */
  async onResult(id: EmoteRef, share: Uint8Array | null): Promise<void> {
    const asked = this.pending;
    if (!asked || asked.id !== id) return;
    this.pending = null;
    if (share) {
      // The sound may have been replaced or removed while it was encoding: the copy belongs to the bytes that were sent.
      const now = await this.deps.readSound(id);
      const entry = this.deps.emotes().find((c) => c.id === id);
      if (now && digest(now) === asked.sound && entry?.sound && !entry.share) await this.deps.save(id, share);
    }
    await this.run();
  }

  /** Forgets earlier failures and tries every sound again. For the Sync now command. */
  async retry(): Promise<void> {
    this.attempts.clear();
    await this.run();
  }
}
