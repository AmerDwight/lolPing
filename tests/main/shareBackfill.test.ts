import { describe, expect, it } from 'vitest';
import { ENCODE_ATTEMPTS, ENCODE_TIMEOUT_MS, ShareBackfill } from '../../src/main/shareBackfill';
import type { CustomEmote, EmoteRef } from '../../src/shared/emotes';

const id = (n: number): EmoteRef => `c:${String(n).repeat(32)}`;
const emote = (n: number, over: Partial<CustomEmote> = {}): CustomEmote => ({ id: id(n), name: `e${n}`, animated: false, sound: true, ...over });

function harness(list: CustomEmote[]) {
  const state = { now: 0, emotes: list, canEncode: true };
  const sounds = new Map<EmoteRef, Uint8Array>(list.map((c, i) => [c.id, Uint8Array.of(i + 1, 2, 3)]));
  const asked: EmoteRef[] = [];
  const saved: [EmoteRef, Uint8Array][] = [];
  const backfill = new ShareBackfill({
    now: () => state.now,
    emotes: () => state.emotes,
    read: (e) => Promise.resolve(sounds.get(e) ?? null),
    encode: (e) => {
      if (state.canEncode) asked.push(e);
      return state.canEncode;
    },
    save: (e, share) => {
      saved.push([e, share]);
      state.emotes = state.emotes.map((c) => (c.id === e ? { ...c, share: 'f'.repeat(32) } : c));
      return Promise.resolve();
    },
  });
  return { backfill, state, sounds, asked, saved };
}
const COPY = Uint8Array.of(9, 9);

describe('ShareBackfill', () => {
  it('counts the sounds that have no copy for rooms', () => {
    const h = harness([emote(1), emote(2, { share: 'a'.repeat(32) }), emote(3, { sound: undefined })]);
    expect(h.backfill.missing()).toBe(1);
  });

  it('hands out one sound at a time and saves each copy that comes back', async () => {
    const h = harness([emote(1), emote(2)]);
    await h.backfill.run();
    await h.backfill.run();
    expect(h.asked).toEqual([id(1)]);
    await h.backfill.onResult(id(1), COPY);
    expect(h.saved).toEqual([[id(1), COPY]]);
    expect(h.asked).toEqual([id(1), id(2)]); // the next one started by itself
    await h.backfill.onResult(id(2), COPY);
    expect(h.backfill.missing()).toBe(0);
    await h.backfill.run();
    expect(h.asked).toHaveLength(2);
  });

  it('drops a copy when the sound was replaced or removed while it was encoding', async () => {
    const h = harness([emote(1), emote(2)]);
    await h.backfill.run();
    h.sounds.set(id(1), Uint8Array.of(7, 7, 7)); // another sound under the same emote
    await h.backfill.onResult(id(1), COPY);
    expect(h.saved).toEqual([]);

    await h.backfill.onResult(id(2), null); // the one that started next can't be encoded at all
    h.state.emotes = [emote(1, { sound: undefined }), emote(2)];
    h.sounds.set(id(1), Uint8Array.of(1, 2, 3));
    expect(h.saved).toEqual([]);
  });

  it('ignores an answer it didn’t ask for', async () => {
    const h = harness([emote(1)]);
    await h.backfill.onResult(id(1), COPY);
    await h.backfill.run();
    await h.backfill.onResult(id(5), COPY);
    expect(h.saved).toEqual([]);
  });

  it('moves on when a renderer never answers, and stops handing out a sound that keeps failing', async () => {
    const h = harness([emote(1)]);
    for (let n = 0; n < ENCODE_ATTEMPTS + 2; n++) {
      await h.backfill.run();
      h.state.now += ENCODE_TIMEOUT_MS;
    }
    expect(h.asked).toHaveLength(ENCODE_ATTEMPTS);
    await h.backfill.retry(); // Sync now starts the count again
    expect(h.asked).toHaveLength(ENCODE_ATTEMPTS + 1);
  });

  it('waits for a renderer when none can take the sound', async () => {
    const h = harness([emote(1)]);
    h.state.canEncode = false;
    await h.backfill.run();
    h.state.canEncode = true;
    await h.backfill.run();
    expect(h.asked).toEqual([id(1)]);
  });
});

describe('ShareBackfill for animations', () => {
  it('copies what `needs` says needs a copy, from what `read` gives it', async () => {
    const list: CustomEmote[] = [
      { id: id(1), name: 'gif', animated: true }, { id: id(2), name: 'done', animated: true, shareAnim: 'a'.repeat(32) },
      { id: id(3), name: 'still', animated: false },
    ];
    let emotes = list;
    const asked: [EmoteRef, Uint8Array][] = [];
    const backfill = new ShareBackfill({
      now: () => 0,
      emotes: () => emotes,
      needs: (c) => c.animated && !c.shareAnim,
      read: (e) => Promise.resolve(Uint8Array.of(Number(e.slice(2, 3)))),
      encode: (e, file) => {
        asked.push([e, file]);
        return true;
      },
      save: (e) => {
        emotes = emotes.map((c) => (c.id === e ? { ...c, shareAnim: 'b'.repeat(32) } : c));
        return Promise.resolve();
      },
    });
    expect(backfill.missing()).toBe(1);
    await backfill.run();
    expect(asked).toEqual([[id(1), Uint8Array.of(1)]]);
    await backfill.onResult(id(1), COPY);
    expect(backfill.missing()).toBe(0);
  });
});
