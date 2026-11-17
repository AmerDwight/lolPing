import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emoteFxContent } from '../../src/renderer/shared/emoteFx';
import { EmoteStage } from '../../src/renderer/overlay/emoteStage';

/** Just enough of the DOM for EmoteStage: elements with classes, children, text and a src. */
class FakeElement {
  className = '';
  textContent = '';
  src = '';
  alt = '';
  draggable = true;
  readonly dataset: Record<string, string> = {};
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  /** The custom properties set on it, such as --w and --dur. */
  readonly props = new Map<string, string>();
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void } = {
    setProperty: (k: string, v: string) => void this.props.set(k, v),
  };
  constructor(readonly tagName: string) {}
  append(...els: FakeElement[]): void {
    for (const el of els) {
      el.remove();
      el.parent = this;
      this.children.push(el);
    }
  }
  prepend(el: FakeElement): void {
    el.remove();
    el.parent = this;
    this.children.unshift(el);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceWith(el: FakeElement): void {
    const p = this.parent;
    if (!p) return;
    p.children[p.children.indexOf(this)] = el;
    el.parent = p;
    this.parent = null;
  }
  private readonly listeners = new Map<string, Array<{ fn: () => void; once: boolean }>>();
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, once: opts?.once === true }]);
  }
  /** Runs this element's listeners for `type`, dropping the ones registered with `once`. */
  dispatch(type: string): void {
    const all = this.listeners.get(type) ?? [];
    this.listeners.set(type, all.filter((l) => !l.once));
    for (const l of all) l.fn();
  }
  /** Every element under this one with `cls` among its classes. */
  find(cls: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.className.split(' ').includes(cls) ? [c] : []), ...c.find(cls)]);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmoteStage', () => {
  it('shows the placeholder when a bundled emote’s animation arrives but cannot be decoded', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['not a webp'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    const [sheet] = emote.find('sheet');
    expect(sheet.src).toMatch(/^blob:/);
    sheet.dispatch('error'); // the <img> could not decode what it was given
    expect(emote.find('sheet')).toHaveLength(0);
    const [fx] = emote.find('fx'); // the same envelope as a custom emote or a missing file
    expect(fx.find('bubble')).toHaveLength(1);
    expect(layer.find('emote')).toHaveLength(1); // still on screen for its 3 s
    sheet.dispatch('error'); // a second error does not swap again
    expect(emote.find('fx')).toHaveLength(1);
    expect(emote.find('bubble')).toHaveLength(1);
    stage.clear('self');
    expect(layer.find('emote')).toHaveLength(0);
  });

  it('a decode error after the emote was cleared does nothing', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    const [sheet] = emote.find('sheet');
    stage.clear('self');
    sheet.dispatch('error');
    expect(emote.find('fx')).toHaveLength(0);
    expect(emote.find('bubble')).toHaveLength(0);
    expect(layer.find('emote')).toHaveLength(0);
  });

  it('a decode error after a newer emote replaced this one leaves the newer emote alone', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [old] = layer.find('emote');
    const [oldSheet] = old.find('sheet');
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 30, 40, { sizePx: 150 });
    await flush();
    oldSheet.dispatch('error');
    const emotes = layer.find('emote');
    expect(emotes).toHaveLength(1);
    expect(emotes[0]).not.toBe(old);
    expect(emotes[0].find('sheet')).toHaveLength(1);
    expect(emotes[0].find('bubble')).toHaveLength(0);
    stage.clear('self');
  });

  it('shows a bundled emote’s baked animation', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const [emote] = layer.find('emote');
    expect(emote.find('sheet')).toHaveLength(1);
    expect(emote.find('sheet')[0].src).toMatch(/^blob:/);
    expect(emote.find('bubble')).toHaveLength(0);
    stage.clear('self');
  });

  it('shows the placeholder when a bundled emote’s animation is missing', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.reject(new Error('404')));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    await flush();
    const emotes = layer.find('emote');
    expect(emotes).toHaveLength(1); // still on screen for its 3 s
    expect(emotes[0].find('sheet')).toHaveLength(0);
    const [fx] = emotes[0].find('fx'); // the same envelope as a custom emote
    expect(fx.find('bubble')).toHaveLength(1);
    stage.clear('self');
    expect(layer.find('emote')).toHaveLength(0);
  });

  it('a missing animation that arrives after the emote was cleared does nothing', async () => {
    const layer = new FakeElement('div');
    let fail: (e: Error) => void = () => undefined;
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => new Promise((_, reject) => (fail = reject)));
    stage.spawn('self', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
    stage.clear('self');
    fail(new Error('404'));
    await flush();
    expect(layer.find('emote')).toHaveLength(0);
  });
});

describe('EmoteStage kept emotes', () => {
  it('holds a kept bundled emote as its icon after the animation, until it is cleared', async () => {
    vi.useFakeTimers();
    try {
      const layer = new FakeElement('div');
      const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
      stage.spawn('mate', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150, keep: true });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const [emote] = layer.find('emote');
      expect(emote).toBeDefined();
      expect(emote.find('sheet')).toHaveLength(0);
      expect(emote.find('still')[0].src).toMatch(/facepalm\.png$/);
      stage.clear('mate');
      expect(layer.find('emote')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the icon when the animation arrives after the swap', async () => {
    vi.useFakeTimers();
    try {
      const layer = new FakeElement('div');
      let arrive: (b: Blob) => void = () => undefined;
      const stage = new EmoteStage(layer as unknown as HTMLElement, () => new Promise((resolve) => (arrive = resolve)));
      stage.spawn('mate', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150, keep: true });
      await vi.advanceTimersByTimeAsync(3_200);
      arrive(new Blob(['x']));
      await vi.advanceTimersByTimeAsync(0);
      const [still] = layer.find('emote')[0].find('still');
      expect(still.src).toMatch(/facepalm\.png$/);
      stage.clear('mate');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still removes an emote that is not kept after its time', async () => {
    vi.useFakeTimers();
    try {
      const layer = new FakeElement('div');
      const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['x'])));
      stage.spawn('mate', { kind: 'bundled', slug: 'facepalm' }, 10, 20, { sizePx: 150 });
      await vi.advanceTimersByTimeAsync(3_200);
      expect(layer.find('emote')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('custom emote effects', () => {
  it('plays an imported emote in the envelope its entry picks', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    const hash = '000a' + '0'.repeat(28);
    stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${hash}.webp`, animated: false, fx: 1 }, 10, 20, { sizePx: 150 });
    const [emote] = layer.find('emote');
    const [fx] = emote.find('fx');
    expect(fx.className.split(' ')).toEqual(['fx', 'v1']);
    expect(fx.children[0].tagName).toBe('img'); // the fake DOM finds by class only, so check the tag
    stage.clear('self');

    stage.clear('self');
  });

  it('plays a moving one in its envelope too, once its file has arrived', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['gif'])));
    const other = '000b' + '0'.repeat(28);
    stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${other}.anim`, animated: true, fx: 2 }, 10, 20, { sizePx: 150 });
    await flush();
    expect(layer.find('emote')[0].find('fx')[0].className.split(' ')).toEqual(['fx', 'v2']);
    stage.clear('self');
  });

  it('keeps the plain envelope for the placeholder, whatever the URL looks like', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    stage.spawn('self', { kind: 'placeholder' }, 10, 20, { sizePx: 150 });
    const [fx] = layer.find('emote')[0].find('fx');
    expect(fx.className.split(' ')).toEqual(['fx', 'v0']);
    expect(fx.find('bubble')).toHaveLength(1);
    stage.clear('self');
  });
});

describe('custom emote sizes and clips', () => {
  const url = `lolping://emotes/${'0c'.repeat(16)}.anim`;

  it('gives art with a size of its own that box, and anything else the emote size square', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    stage.spawn('a', { kind: 'custom', url, animated: false, fx: 0, w: 320, h: 180 }, 0, 0, { sizePx: 150 });
    stage.spawn('b', { kind: 'custom', url, animated: false, fx: 0 }, 0, 0, { sizePx: 150 });
    stage.spawn('c', { kind: 'bundled', slug: 'facepalm' }, 0, 0, { sizePx: 120 });
    const [a, b, c] = layer.find('emote').map((e) => Object.fromEntries(e.props));
    expect(a).toMatchObject({ '--w': '320px', '--h': '180px', '--size': '320px' });
    expect(b).toMatchObject({ '--w': '150px', '--h': '150px', '--size': '150px' });
    expect(c).toMatchObject({ '--w': '120px', '--h': '120px', '--size': '120px' });
    for (const o of ['a', 'b', 'c']) stage.clear(o);
  });

  it('keeps a clip on screen for its whole length, and anything shorter for the usual 3 s', () => {
    vi.useFakeTimers();
    try {
      const layer = new FakeElement('div');
      const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.resolve(new Blob(['webp'])));
      stage.spawn('long', { kind: 'custom', url, animated: true, fx: 0, dur: 4.5 }, 0, 0, { sizePx: 150 });
      stage.spawn('short', { kind: 'custom', url, animated: true, fx: 0 }, 0, 0, { sizePx: 150 });
      expect(layer.find('emote').map((e) => e.props.get('--dur'))).toEqual(['4.5s', '3s']);
      vi.advanceTimersByTime(3200);
      expect(layer.find('emote')).toHaveLength(1);
      vi.advanceTimersByTime(1500);
      expect(layer.find('emote')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives every showing of a moving emote its own object URL from one fetch, so each starts at frame 0', async () => {
    const layer = new FakeElement('div');
    const fetchBlob = vi.fn(() => Promise.resolve(new Blob(['webp'])));
    const stage = new EmoteStage(layer as unknown as HTMLElement, fetchBlob);
    const art = { kind: 'custom', url, animated: true, fx: 0 } as const;
    stage.spawn('a', art, 0, 0, { sizePx: 150 });
    stage.spawn('b', art, 0, 0, { sizePx: 150 });
    await flush();
    const srcs = layer.find('emote').map((e) => e.find('fx')[0].children[0].src);
    expect(srcs[0]).toMatch(/^blob:/);
    expect(srcs[1]).toMatch(/^blob:/);
    expect(srcs[0]).not.toBe(srcs[1]);
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    stage.forgetCustom(); // settings changed: the file may have been replaced under the same URL
    stage.spawn('a', art, 0, 0, { sizePx: 150 });
    await flush();
    expect(fetchBlob).toHaveBeenCalledTimes(2);
    for (const o of ['a', 'b']) stage.clear(o);
  });

  it('falls back to the URL itself when the fetch fails', async () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement, () => Promise.reject(new Error('404')));
    stage.spawn('a', { kind: 'custom', url, animated: true, fx: 0 }, 0, 0, { sizePx: 150 });
    await flush();
    expect(layer.find('emote')[0].find('fx')[0].children[0].src).toBe(url);
    stage.clear('a');
  });
});

describe('plain effects', () => {
  it('add nothing around the art, and neither does the placeholder', () => {
    const layer = new FakeElement('div');
    const stage = new EmoteStage(layer as unknown as HTMLElement);
    for (let n = 0; n < 6; n++) {
      stage.spawn('self', { kind: 'custom', url: `lolping://emotes/${n.toString(16).repeat(16)}.webp`, animated: false, fx: n }, 10, 20, { sizePx: 150 });
      const [fx] = layer.find('emote')[0].find('fx');
      expect(fx.children.filter((c) => c.tagName === 'i')).toHaveLength(0);
      stage.clear('self');
    }
    stage.spawn('self', { kind: 'placeholder' }, 10, 20, { sizePx: 150 });
    expect(layer.find('emote')[0].find('fx')[0].children.filter((c) => c.tagName === 'i')).toHaveLength(0);
    stage.clear('self');
  });
});

describe('emoteFxContent (the effect picker builds the same nodes)', () => {
  const url = 'lolping://emotes/still/0123456789abcdef0123456789abcdef.webp';

  it('variant 0 is just the art in the plain envelope, with no ornaments', () => {
    const fx = emoteFxContent(0, url) as unknown as FakeElement;
    expect(fx.className).toBe('fx v0');
    expect(fx.children).toHaveLength(1); // the art, nothing else
    expect(fx.find('blob')).toHaveLength(0);
    expect(fx.find('ring')).toHaveLength(0);
    expect(fx.find('spark')).toHaveLength(0);
  });

  it('an art that cannot load falls back to the placeholder bubble', () => {
    const fx = emoteFxContent(5, url) as unknown as FakeElement;
    fx.children[0].dispatch('error');
    expect(fx.find('bubble')).toHaveLength(1);
  });
});
