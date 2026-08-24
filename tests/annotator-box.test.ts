/**
 * Where the highlight box actually lands.
 *
 * The red box is the only thing in a flow that says *this* is the element the
 * step is about, so a box in the wrong place is not a cosmetic bug — it is a
 * screenshot captioned as evidence of something that did not happen. The
 * drawing itself needs `OffscreenCanvas`; the geometry that decides where and
 * whether to draw is pure, and it is all of the wrongness.
 */

import { describe, expect, it } from 'vitest';
import { highlightRect, type Rect } from '../src/background/annotator.js';
import type { BoundingBox } from '../src/shared/types.js';

const IMAGE: Rect = { x: 0, y: 0, w: 1000, h: 800 };
const NO_SCROLL = { x: 0, y: 0 };

const box = (over: Partial<BoundingBox> = {}): BoundingBox => ({
  x: 100,
  y: 50,
  width: 200,
  height: 40,
  ...over,
});

describe('the ordinary case', () => {
  it('pads the box and scales it into device pixels', () => {
    // 4 CSS px of padding on each side, everything doubled for a 2× display.
    expect(highlightRect(box(), 2, NO_SCROLL, IMAGE)).toEqual({
      x: 192,
      y: 92,
      w: 416,
      h: 96,
    });
  });
});

/**
 * `box` is measured in the content script at event time; the picture is taken
 * at least 150ms later. Anything that scrolls in between — most obviously a
 * control that calls `scrollIntoView()` on itself — leaves the element
 * somewhere else, and the highlight was drawn over whatever moved into its
 * place, 500px from the thing that was clicked.
 */
describe('a scroll between measuring and capturing', () => {
  it('moves the box by what the page moved', () => {
    const scrolled = highlightRect(box({ y: 600 }), 1, { x: 0, y: 500 }, IMAGE);
    expect(scrolled?.y).toBe(96); // 600 measured − 500 scrolled − 4 padding
  });

  it('draws nothing at all once the element has scrolled off the capture', () => {
    expect(highlightRect(box({ y: 600 }), 1, { x: 0, y: 900 }, IMAGE)).toBeNull();
  });

  it('is the old behaviour when no delta is known', () => {
    expect(highlightRect(box(), 1, NO_SCROLL, IMAGE)).toEqual({ x: 96, y: 46, w: 208, h: 48 });
  });
});

/**
 * Clicking a `<label>` dispatches a synthetic click on the control it labels,
 * and a `display:none` file input has a rect of all zeros. Unguarded, that drew
 * an 8px red square at (−4, −4) — over the site logo, in a step that says the
 * user clicked "Upload a file".
 */
describe('boxes there is no honest way to draw', () => {
  it('refuses a zero-sized box', () => {
    expect(highlightRect(box({ width: 0, height: 0 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ width: 200, height: 0 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ width: 0, height: 40 }), 1, NO_SCROLL, IMAGE)).toBeNull();
  });

  it('refuses a negative-sized box', () => {
    expect(highlightRect(box({ width: -10 }), 1, NO_SCROLL, IMAGE)).toBeNull();
  });

  it('refuses a box that does not touch the image', () => {
    expect(highlightRect(box({ x: 2000 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ x: -900 }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box({ y: -400 }), 1, NO_SCROLL, IMAGE)).toBeNull();
  });

  it('refuses anything that is not a number', () => {
    expect(highlightRect(box({ x: NaN }), 1, NO_SCROLL, IMAGE)).toBeNull();
    expect(highlightRect(box(), 1, { x: 0, y: Infinity }, IMAGE)).toBeNull();
  });
});

/**
 * A box that hangs off an edge is still the right element — only part of it was
 * on screen. That one is clamped rather than dropped, so the visible part is
 * highlighted and no coordinate is drawn outside the image.
 */
describe('boxes that only partly fit', () => {
  it('clamps the padding that would fall outside the top-left corner', () => {
    expect(highlightRect(box({ x: 0, y: 0, width: 10, height: 10 }), 1, NO_SCROLL, IMAGE)).toEqual({
      x: 0,
      y: 0,
      w: 14,
      h: 14,
    });
  });

  it('clamps an element half off the bottom-right', () => {
    const rect = highlightRect(box({ x: 900, y: 750, width: 300, height: 300 }), 1, NO_SCROLL, IMAGE);
    expect(rect).toEqual({ x: 896, y: 746, w: 104, h: 54 });
    expect(rect!.x + rect!.w).toBeLessThanOrEqual(IMAGE.w);
    expect(rect!.y + rect!.h).toBeLessThanOrEqual(IMAGE.h);
  });
});
