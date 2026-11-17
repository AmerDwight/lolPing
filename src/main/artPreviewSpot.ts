export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The centre on one axis: `want` if the preview fits there inside lo..lo+len, else as near as it fits; the middle when it can't. */
function fitAxis(want: number, size: number, lo: number, len: number): number {
  if (size >= len) return lo + len / 2;
  return Math.min(lo + len - size / 2, Math.max(lo + size / 2, want));
}

/**
 * Where the size preview of an emote being added goes, in the same coordinates as `area` (a display's work area). It is
 * centred in the largest strip beside the settings window, so the dialog stays in sight and the preview grows in place
 * as the slider moves; one too big for that strip is moved only as far as the area needs, and is `over` the window when
 * it then covers part of it. `window` is null when there is none to keep clear of: the middle of the area.
 */
export function artPreviewSpot(area: Rect, window: Rect | null, w: number, h: number): { x: number; y: number; over: boolean } {
  let centre = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  if (window) {
    const right = area.x + area.width;
    const bottom = area.y + area.height;
    const strips: Rect[] = [
      { x: window.x + window.width, y: area.y, width: right - (window.x + window.width), height: area.height },
      { x: area.x, y: area.y, width: window.x - area.x, height: area.height },
      { x: area.x, y: window.y + window.height, width: area.width, height: bottom - (window.y + window.height) },
      { x: area.x, y: area.y, width: area.width, height: window.y - area.y },
    ];
    const best = strips.filter((s) => s.width > 0 && s.height > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (best) centre = { x: best.x + best.width / 2, y: best.y + best.height / 2 };
  }
  const x = fitAxis(centre.x, w, area.x, area.width);
  const y = fitAxis(centre.y, h, area.y, area.height);
  const over = window !== null
    && x - w / 2 < window.x + window.width && x + w / 2 > window.x && y - h / 2 < window.y + window.height && y + h / 2 > window.y;
  return { x, y, over };
}
