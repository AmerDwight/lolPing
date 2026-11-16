import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, nativeImage, NativeImage } from '../../tauri-poc/web/electron/image';

const logo = readFileSync(resolve(__dirname, '../../assets/textures/generic_ping.png'));
const at = (rgba: Uint8Array, w: number, x: number, y: number): number[] => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

describe('NativeImage', () => {
  it('decodes the tray logo to the pixels Pillow reads', () => {
    const png = decodePng(logo);
    expect(png).not.toBeNull();
    if (!png) return;
    expect([png.width, png.height]).toEqual([128, 128]);
    expect(at(png.rgba, 128, 42, 32)).toEqual([40, 60, 123, 223]);
    expect(at(png.rgba, 128, 64, 25)).toEqual([115, 170, 255, 255]);
    expect(at(png.rgba, 128, 64, 64)[3]).toBe(0);
  });

  it('writes a PNG that reads back to the same pixels', () => {
    const png = decodePng(logo);
    if (!png) throw new Error('no logo');
    const again = decodePng(encodePng(png.width, png.height, png.rgba));
    expect(again?.rgba).toEqual(png.rgba);
  });

  it('keeps Electron\'s premultiplied BGRA bitmap, which the tray recolours', () => {
    const img = NativeImage.fromRgba(1, 1, Uint8Array.from([200, 100, 50, 128]));
    expect(Array.from(img.toBitmap())).toEqual([25, 50, 100, 128]);
    const back = nativeImage.createFromBitmap(img.toBitmap(), { width: 1, height: 1 });
    expect(Array.from(back.toRgba())).toEqual([199, 100, 50, 128]);
  });

  it('shrinks by area, so a flat colour stays flat and coverage becomes alpha', () => {
    const flat = NativeImage.fromRgba(4, 4, new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : 90)));
    expect(Array.from(flat.resize({ width: 2, height: 2 }).toRgba().subarray(0, 4))).toEqual([90, 90, 90, 255]);
    const half = new Uint8Array(16);
    half.set([255, 0, 0, 255], 0);
    half.set([255, 0, 0, 255], 8);
    const img = NativeImage.fromRgba(2, 2, half).resize({ width: 1, height: 1 });
    expect(Array.from(img.toRgba())).toEqual([255, 0, 0, 128]);
  });

  it('reads the logo at the tray size the way AppTray asks for it', () => {
    const img = nativeImage.createFromBuffer(logo).resize({ width: 32, height: 32, quality: 'best' });
    expect(img.getSize()).toEqual({ width: 32, height: 32 });
    expect(img.isEmpty()).toBe(false);
    expect(nativeImage.createFromBuffer(Uint8Array.from([1, 2, 3])).isEmpty()).toBe(true);
  });
});
