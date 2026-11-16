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
  /** The part outside the taskbar, physical. */
  work?: Rect;
}

/** The part of Electron's Display the main-process code reads, plus the physical rect behind it. */
export interface ShimDisplay {
  id: number;
  label: string;
  bounds: Rect;
  workArea: Rect;
  size: { width: number; height: number };
  workAreaSize: { width: number; height: number };
  scaleFactor: number;
  rotation: number;
  internal: boolean;
  phys: Rect;
  primary: boolean;
}

/**
 * Monitors as Electron-style displays. A display's DIP rect is its physical rect divided by its scale. Electron lays
 * mixed-scale displays out differently, but every lolPing mapping goes through the same display's rect both ways,
 * so the overlay-local points come out the same.
 */
export function toDisplays(monitors: readonly Monitor[]): ShimDisplay[] {
  return monitors.map((m) => {
    const dip = (r: Rect): Rect => ({ x: r.x / m.scale, y: r.y / m.scale, width: r.width / m.scale, height: r.height / m.scale });
    const phys = { x: m.x, y: m.y, width: m.width, height: m.height };
    const bounds = dip(phys);
    const workArea = dip(m.work ?? phys);
    return {
      id: m.id, label: `Display ${m.id}`, scaleFactor: m.scale, primary: m.primary, rotation: 0, internal: false, phys, bounds,
      workArea, size: { width: bounds.width, height: bounds.height }, workAreaSize: { width: workArea.width, height: workArea.height },
    };
  });
}

/** A physical point in DIPs, by the display it is on (or nearest). */
export function physToDip(p: { x: number; y: number }, displays: readonly ShimDisplay[]): { x: number; y: number } {
  if (displays.length === 0) return { ...p };
  const d = displays.reduce((a, b) => (distSq(b.phys, p.x, p.y) < distSq(a.phys, p.x, p.y) ? b : a));
  return { x: d.bounds.x + (p.x - d.phys.x) / d.scaleFactor, y: d.bounds.y + (p.y - d.phys.y) / d.scaleFactor };
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
