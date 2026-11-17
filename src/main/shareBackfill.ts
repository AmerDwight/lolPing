import { createHash } from 'node:crypto';
import type { CustomEmote, EmoteRef } from '../shared/emotes';

/** How long a renderer may take to encode one sound before the next is tried, and how often one sound is handed out. */
export const ENCODE_TIMEOUT_MS = 30_000;
export const ENCODE_ATTEMPTS = 3;

export interface ShareBackfillDeps {
  now(): number;
  /** Our imported emotes, as settings have them now. */
  emotes(): readonly CustomEmote[];
  /** Whether an emote has a file to copy and no copy yet. By default: a sound without its copy for rooms. */
  needs?(c: CustomEmote): boolean;
  /** The file the copy is made from (by default the emote's stored sound), or null when it is gone. */
  read(id: EmoteRef): Promise<Uint8Array | null>;
  /** Hands the file to a renderer to encode; its answer comes back through `onResult`. False when none can take it. */
  encode(id: EmoteRef, file: Uint8Array): boolean;
  /** Checks and keeps the copy, and records it on the emote. */
  save(id: EmoteRef, share: Uint8Array): Promise<void>;
}

const needsSoundCopy = (c: CustomEmote): boolean => c.sound === true && !c.share;

const digest = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * Gives every imported emote's sound its copy for rooms. A sound picked in the settings window gets one there; this covers
 * the rest: a sound added before sounds travelled, or one whose copy was lost. Main has no audio encoder, so each sound
 * goes to a renderer, one at a time, and a copy is kept only if the sound on disk is still the one that was sent. With
 * `needs` and `read` for animations, the same goes for a moving emote added before animations travelled.
 */
export class ShareBackfill {
  private pending: { id: EmoteRef; file: string; at: number } | null = null;
  private readonly attempts = new Map<EmoteRef, number>();
  private starting = false;

  private readonly needs: (c: CustomEmote) => boolean;

  constructor(private readonly deps: ShareBackfillDeps) {
    this.needs = deps.needs ?? needsSoundCopy;
  }

  /** Emotes that need a copy for rooms and have none: room members can't hear (or see move) these yet. */
  missing(): number {
    return this.deps.emotes().filter(this.needs).length;
  }

  /** Starts the next sound that still needs a copy, unless one is being encoded. Safe to call often. */
  async run(): Promise<void> {
    if (this.starting) return;
    if (this.pending && this.deps.now() - this.pending.at < ENCODE_TIMEOUT_MS) return;
    this.pending = null;
    const next = this.deps.emotes().find((c) => this.needs(c) && (this.attempts.get(c.id) ?? 0) < ENCODE_ATTEMPTS);
    if (!next) return;
    this.starting = true;
    try {
      const file = await this.deps.read(next.id);
      this.attempts.set(next.id, (this.attempts.get(next.id) ?? 0) + 1);
      if (file && this.deps.encode(next.id, file)) this.pending = { id: next.id, file: digest(file), at: this.deps.now() };
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
      // The file may have been replaced or removed while it was encoding: the copy belongs to the bytes that were sent.
      const now = await this.deps.read(id);
      const entry = this.deps.emotes().find((c) => c.id === id);
      if (now && digest(now) === asked.file && entry && this.needs(entry)) await this.deps.save(id, share);
    }
    await this.run();
  }

  /** Forgets earlier failures and tries every file again. For the Sync now command. */
  async retry(): Promise<void> {
    this.attempts.clear();
    await this.run();
  }
}
