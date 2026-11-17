import { describe, expect, it } from 'vitest';
import { artPreviewSpot } from '../../src/main/artPreviewSpot';

const area = { x: 0, y: 0, width: 1920, height: 1040 };

describe('artPreviewSpot', () => {
  it('puts the preview in the middle of the widest strip beside the window that it fits in', () => {
    // A 900 px window at the left: the 1020 px strip on its right.
    expect(artPreviewSpot(area, { x: 0, y: 100, width: 900, height: 700 }, 300, 200)).toEqual({ x: 1410, y: 520, over: false });
    // A window in the middle: 510 px on either side, the right one first.
    expect(artPreviewSpot(area, { x: 510, y: 170, width: 900, height: 700 }, 300, 200)).toEqual({ x: 1665, y: 520, over: false });
  });

  it('uses the strip above or below the window when only that has room', () => {
    const wide = { x: 0, y: 0, width: 1920, height: 500 };
    expect(artPreviewSpot(area, wide, 600, 400)).toEqual({ x: 960, y: 770, over: false });
  });

  it('stays on the same side when it is too big for it, moved only as far as the screen needs, over the window', () => {
    expect(artPreviewSpot(area, { x: 510, y: 170, width: 900, height: 700 }, 1200, 700)).toEqual({ x: 1320, y: 520, over: true });
  });

  it('grows in place as the size changes, as long as it fits', () => {
    const window = { x: 510, y: 170, width: 900, height: 700 };
    expect(artPreviewSpot(area, window, 100, 100)).toEqual({ x: 1665, y: 520, over: false });
    expect(artPreviewSpot(area, window, 500, 400)).toEqual({ x: 1665, y: 520, over: false });
  });

  it('takes the middle of the area on an axis it is larger than', () => {
    expect(artPreviewSpot(area, { x: 0, y: 100, width: 900, height: 700 }, 2048, 1100)).toEqual({ x: 960, y: 520, over: true });
  });

  it('takes the middle of the area when there is no window to keep clear of', () => {
    expect(artPreviewSpot({ x: 1920, y: 0, width: 1280, height: 1024 }, null, 300, 200)).toEqual({ x: 2560, y: 512, over: false });
  });

  it('keeps clear of a window that hangs off the area', () => {
    expect(artPreviewSpot(area, { x: -200, y: 0, width: 900, height: 1040 }, 400, 300)).toEqual({ x: 1310, y: 520, over: false });
  });
});
