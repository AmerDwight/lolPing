// Electron's nativeImage in plain JS: the tray builds its icons synchronously (decode, resize, recolour pixel by
// pixel), which no browser image API does. Pixels are kept as Electron keeps them on Windows: premultiplied BGRA.
import { unzlibSync, zlibSync } from 'fflate';
import { Buffer } from '../node/buffer';
import { readFileSync } from '../node/fs';

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** An 8-bit, non-interlaced PNG (what lolPing ships) as straight RGBA; null for anything else. */
export function decodePng(b: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  if (b.length < 33 || !PNG_SIG.every((v, i) => b[i] === v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= b.length;) {
    const len = dv.getUint32(at);
    const kind = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    const data = b.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') {
      width = dv.getUint32(at + 8);
      height = dv.getUint32(at + 12);
      depth = b[at + 16];
      type = b[at + 17];
      interlace = b[at + 20];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!width || !height || depth !== 8 || interlace !== 0 || !channels) return null;
  const total = idat.reduce((n, d) => n + d.length, 0);
  const z = new Uint8Array(total);
  let off = 0;
  for (const d of idat) {
    z.set(d, off);
    off += d.length;
  }
  const raw = unzlibSync(z);
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      const u = up ? up[i] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += u;
      else if (filter === 3) v += (a + u) >> 1;
      else if (filter === 4) {
        const p = a + u - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - u);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c;
      }
      row[i] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r: number;
    let g: number;
    let bl: number;
    let al = 255;
    if (type === 6) [r, g, bl, al] = [px[s], px[s + 1], px[s + 2], px[s + 3]];
    else if (type === 2) [r, g, bl] = [px[s], px[s + 1], px[s + 2]];
    else if (type === 4) [r, g, bl, al] = [px[s], px[s], px[s], px[s + 1]];
    else if (type === 3) {
      const k = px[s];
      [r, g, bl] = palette ? [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2]] : [0, 0, 0];
      al = trns && k < trns.length ? trns[k] : 255;
    } else [r, g, bl] = [px[s], px[s], px[s]];
    rgba.set([r, g, bl, al], i * 4);
  }
  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (parts: Uint8Array[]): number => {
  let c = 0xffffffff;
  for (const p of parts) for (const v of p) c = CRC_TABLE[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (kind: string, data: Uint8Array): Uint8Array => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    head.set([...kind].map((ch) => ch.charCodeAt(0)), 4);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, crc32([head.subarray(4), data]));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Uint8Array.from(PNG_SIG), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** Box-filters premultiplied pixels to the new size: every source pixel counts for the area it covers. */
function resample(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const pass = (data: Float32Array, w: number, h: number, nw: number, horizontal: boolean): Float32Array => {
    const [inLen, lines] = horizontal ? [w, h] : [h, w];
    const out = new Float32Array((horizontal ? nw * h : w * nw) * 4);
    const scale = inLen / nw;
    for (let line = 0; line < lines; line++) {
      for (let o = 0; o < nw; o++) {
        const from = o * scale;
        const to = from + scale;
        const acc = [0, 0, 0, 0];
        for (let i = Math.floor(from); i < Math.min(inLen, Math.ceil(to)); i++) {
          const wgt = Math.min(to, i + 1) - Math.max(from, i);
          const at = (horizontal ? line * w + i : i * w + line) * 4;
          for (let c = 0; c < 4; c++) acc[c] += data[at + c] * wgt;
        }
        const dst = (horizontal ? line * nw + o : o * w + line) * 4;
        for (let c = 0; c < 4; c++) out[dst + c] = acc[c] / scale;
      }
    }
    return out;
  };
  const wide = pass(Float32Array.from(src), sw, sh, dw, true);
  const done = pass(wide, dw, sh, dh, false);
  return Uint8Array.from(done, (v) => Math.max(0, Math.min(255, Math.round(v))));
}

export class NativeImage {
  private template = false;

  /** `bgra` is premultiplied, as Electron's toBitmap gives it on Windows. */
  constructor(private readonly width: number, private readonly height: number, private readonly bgra: Uint8Array) {}

  static fromRgba(width: number, height: number, rgba: Uint8Array): NativeImage {
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      out[i] = Math.round((rgba[i + 2] * a) / 255);
      out[i + 1] = Math.round((rgba[i + 1] * a) / 255);
      out[i + 2] = Math.round((rgba[i] * a) / 255);
      out[i + 3] = a;
    }
    return new NativeImage(width, height, out);
  }

  isEmpty(): boolean {
    return this.width === 0 || this.height === 0;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  getAspectRatio(): number {
    return this.height ? this.width / this.height : 1;
  }

  toBitmap(): Buffer {
    return Buffer.from(this.bgra);
  }

  getBitmap(): Buffer {
    return this.toBitmap();
  }

  /** Straight RGBA, as PNG and the tray want it. */
  toRgba(): Uint8Array {
    const out = new Uint8Array(this.bgra.length);
    for (let i = 0; i < this.bgra.length; i += 4) {
      const a = this.bgra[i + 3];
      const un = (v: number): number => (a ? Math.min(255, Math.round((v * 255) / a)) : 0);
      out[i] = un(this.bgra[i + 2]);
      out[i + 1] = un(this.bgra[i + 1]);
      out[i + 2] = un(this.bgra[i]);
      out[i + 3] = a;
    }
    return out;
  }

  toPNG(): Buffer {
    return encodePng(this.width, this.height, this.toRgba());
  }

  /** No JPEG encoder here (only the teammate's history thumbnails use one): a PNG instead. */
  toJPEG(_quality: number): Buffer {
    return this.toPNG();
  }

  toDataURL(): string {
    return `data:image/png;base64,${this.toPNG().toString('base64')}`;
  }

  resize(o: { width?: number; height?: number; quality?: string }): NativeImage {
    if (this.isEmpty()) return this;
    const w = Math.max(1, Math.round(o.width ?? ((o.height ?? this.height) * this.width) / this.height));
    const h = Math.max(1, Math.round(o.height ?? (w * this.height) / this.width));
    return new NativeImage(w, h, resample(this.bgra, this.width, this.height, w, h));
  }

  crop(r: { x: number; y: number; width: number; height: number }): NativeImage {
    const out = new Uint8Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) {
      out.set(this.bgra.subarray(((r.y + y) * this.width + r.x) * 4, ((r.y + y) * this.width + r.x + r.width) * 4), y * r.width * 4);
    }
    return new NativeImage(r.width, r.height, out);
  }

  setTemplateImage(on: boolean): void {
    this.template = on;
  }

  isTemplateImage(): boolean {
    return this.template;
  }

  addRepresentation(): void {
    // one size is all the tray needs
  }
}

const EMPTY = (): NativeImage => new NativeImage(0, 0, new Uint8Array(0));

function fromPngBytes(b: Uint8Array): NativeImage {
  const png = decodePng(b);
  return png ? NativeImage.fromRgba(png.width, png.height, png.rgba) : EMPTY();
}

export const nativeImage = {
  createEmpty: EMPTY,
  createFromPath(path: string): NativeImage {
    try {
      return fromPngBytes(readFileSync(path) as Uint8Array);
    } catch {
      return EMPTY();
    }
  },
  createFromBuffer: (b: Uint8Array): NativeImage => fromPngBytes(b),
  createFromBitmap(b: Uint8Array, o: { width: number; height: number }): NativeImage {
    return new NativeImage(o.width, o.height, Uint8Array.from(b.subarray(0, o.width * o.height * 4)));
  },
  createFromDataURL(url: string): NativeImage {
    const m = /^data:image\/png;base64,(.*)$/.exec(url);
    return m ? fromPngBytes(Buffer.from(m[1], 'base64')) : EMPTY();
  },
};
