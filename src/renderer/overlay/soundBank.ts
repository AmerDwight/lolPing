/** Safety ceiling: more overlapping sounds than this are skipped (the ping still shows). */
export const MAX_VOICES = 8;

/** Sounds loaded by URL on first play (imported emotes' and room members') kept decoded at once; the oldest goes first. */
export const MAX_URL_SOUNDS = 24;

/** Pre-decoded Web Audio buffers: HTMLAudioElement per play added audible latency in the prototype. */
export class SoundBank {
  private readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private readonly buffers = new Map<string, AudioBuffer>();
  /** The URLs playUrl loaded, oldest first. A room can bring any number of members' sounds, each ~1 MB once decoded. */
  private readonly urls: string[] = [];
  private voices = 0;

  /** Decodes every sound up front, each under its key. Resolves with the URLs that failed to load. */
  async load(entries: readonly { key: string; url: string }[]): Promise<string[]> {
    const results = await Promise.all(
      entries.map(async ({ key, url }) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          this.buffers.set(key, await this.ctx.decodeAudioData(await res.arrayBuffer()));
          return null;
        } catch {
          return url;
        }
      }),
    );
    return results.filter((r): r is string => r !== null);
  }

  /** Plays the sound at `url`, loading it under that key the first time. A file that won't load plays nothing. */
  async playUrl(url: string, volume01: number): Promise<void> {
    if (!this.buffers.has(url)) {
      await this.load([{ key: url, url }]);
      if (this.buffers.has(url) && !this.urls.includes(url)) this.urls.push(url);
      while (this.urls.length > MAX_URL_SOUNDS) this.buffers.delete(this.urls.shift() as string);
    }
    this.play(url, volume01);
  }

  /** Drops the loaded sounds whose key starts with `prefix`, so the next play loads them again. */
  forget(prefix: string): void {
    for (const key of this.buffers.keys()) if (key.startsWith(prefix)) this.buffers.delete(key);
    for (let i = this.urls.length - 1; i >= 0; i--) if (this.urls[i].startsWith(prefix)) this.urls.splice(i, 1);
  }

  play(key: string, volume01: number): void {
    const buffer = this.buffers.get(key);
    if (!buffer || volume01 <= 0 || this.voices >= MAX_VOICES) return;
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    src.buffer = buffer;
    gain.gain.value = volume01;
    src.connect(gain).connect(this.ctx.destination);
    this.voices++;
    src.onended = () => this.voices--;
    src.start();
  }
}
