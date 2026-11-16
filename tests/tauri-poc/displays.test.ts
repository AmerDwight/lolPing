import { describe, expect, it } from 'vitest';
import { physicalToLocal } from '../../src/main/coords';
import { dipToPhys, sameMonitors, toDisplays, type Monitor } from '../../tauri-poc/web/displays';

const left: Monitor = { id: 1, x: 0, y: 0, width: 3840, height: 2160, scale: 2, primary: true };
const right: Monitor = { id: 2, x: 3840, y: 0, width: 1920, height: 1080, scale: 1, primary: false };

describe('displays', () => {
  it('gives each monitor a DIP rect of its physical rect over its scale', () => {
    const [a, b] = toDisplays([left, right]);
    expect(a.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(b.bounds).toEqual({ x: 3840, y: 0, width: 1920, height: 1080 });
    expect(a.phys).toEqual({ x: 0, y: 0, width: 3840, height: 2160 });
  });

  it('turns a display\'s own DIP rect back into its physical rect', () => {
    const displays = toDisplays([left, right]);
    for (const d of displays) expect(dipToPhys(d.bounds, displays)).toEqual(d.phys);
  });

  it('maps a helper point to the same overlay point Electron would, on each display', () => {
    const maps = toDisplays([left, right]).map((d) => ({ id: d.id, dip: d.bounds, phys: d.phys, scale: d.scaleFactor }));
    expect(physicalToLocal(1000, 500, maps)).toEqual({ displayId: 1, x: 500, y: 250 });
    expect(physicalToLocal(3840 + 100, 50, maps)).toEqual({ displayId: 2, x: 100, y: 50 });
  });

  it('notices a changed scale even when the size in pixels stays', () => {
    expect(sameMonitors([left, right], [left, right])).toBe(true);
    expect(sameMonitors([left, right], [{ ...left, scale: 1.5 }, right])).toBe(false);
    expect(sameMonitors([left, right], [left])).toBe(false);
  });
});
