import type { Rect } from '../../src/main/coords';

/** One monitor as the Rust shell reports it: physical pixels and the OS scale. */
export interface Monitor {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

/** The part of Electron's Display the main-process code reads, plus the physical rect behind it. */
export interface ShimDisplay {
  id: number;
  bounds: Rect;
  scaleFactor: number;
  phys: Rect;
  primary: boolean;
}

/**
 * Monitors as Electron-style displays. A display's DIP rect is its physical rect divided by its scale. Electron lays
 * mixed-scale displays out differently, but every lolPing mapping goes through the same display's rect both ways,
 * so the overlay-local points come out the same.
 */
export function toDisplays(monitors: readonly Monitor[]): ShimDisplay[] {
  return monitors.map((m) => ({
    id: m.id,
    scaleFactor: m.scale,
    primary: m.primary,
    phys: { x: m.x, y: m.y, width: m.width, height: m.height },
    bounds: { x: m.x / m.scale, y: m.y / m.scale, width: m.width / m.scale, height: m.height / m.scale },
  }));
}

const distSq = (r: Rect, x: number, y: number): number => {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
  return dx * dx + dy * dy;
};

/** screen.dipToScreenRect: a DIP rect in physical pixels, by the display its top-left corner is on (or nearest). */
export function dipToPhys(rect: Rect, displays: readonly ShimDisplay[]): Rect {
  if (displays.length === 0) return { ...rect };
  const d = displays.reduce((a, b) => (distSq(b.bounds, rect.x, rect.y) < distSq(a.bounds, rect.x, rect.y) ? b : a));
  const s = d.scaleFactor;
  return {
    x: d.phys.x + (rect.x - d.bounds.x) * s,
    y: d.phys.y + (rect.y - d.bounds.y) * s,
    width: rect.width * s,
    height: rect.height * s,
  };
}

/** True when the two lists describe the same monitors, so nothing needs rebuilding. */
export const sameMonitors = (a: readonly Monitor[], b: readonly Monitor[]): boolean =>
  a.length === b.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));
