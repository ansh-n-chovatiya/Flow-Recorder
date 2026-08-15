/**
 * A small JPEG of a flow's first screenshot, stored on its index entry.
 *
 * The library row is a list of recordings, and a name plus a step count is not
 * enough to tell two recordings of the same site apart. The full screenshot
 * cannot be used: a 10-flow library would decode ten full-page JPEGs to draw a
 * list, and the index entry would be as large as the flow it indexes. So the
 * image is redrawn once, at save time, at the size the row actually shows.
 */

import type { Step } from '../../shared/types.js';

/** Matches `.flow-row__thumb` in viewer.css, at 2× for a HiDPI screen. */
const WIDTH = 128;
const HEIGHT = 80;

/** Well under a kilobyte at this size, and it is never looked at closely. */
const QUALITY = 0.5;

/**
 * Redraw the first available screenshot at thumbnail size.
 *
 * Resolves to `null` rather than rejecting for every failure — a flow that
 * cannot be thumbnailed is still a flow worth saving, and the library falls back
 * to a placeholder tile.
 */
export function makeThumbnail(steps: Step[]): Promise<string | null> {
  const source = steps.find((step) => Boolean(step.screenshot))?.screenshot;
  if (!source) return Promise.resolve(null);

  return new Promise((resolve) => {
    const image = new Image();

    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;

      const ctx = canvas.getContext('2d');
      if (!ctx || !image.naturalWidth) {
        resolve(null);
        return;
      }

      // Cover, anchored to the top: a page screenshot's meaning is in its first
      // few hundred pixels, and centring the crop would show the middle of an
      // article instead of the header that identifies the site.
      const scale = Math.max(WIDTH / image.naturalWidth, HEIGHT / image.naturalHeight);
      const drawWidth = image.naturalWidth * scale;
      ctx.drawImage(image, (WIDTH - drawWidth) / 2, 0, drawWidth, image.naturalHeight * scale);

      resolve(canvas.toDataURL('image/jpeg', QUALITY));
    };

    image.onerror = () => resolve(null);
    image.src = source;
  });
}
