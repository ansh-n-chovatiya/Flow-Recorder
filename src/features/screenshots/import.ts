/**
 * Taking an image the user supplies and making it into a step's screenshot.
 *
 * The recorder captures on a timer, and a timer misses things: a menu that
 * closes on blur, a toast that lasted 800ms, a modal that was already gone by
 * the time the shutter fired. When that happens the step is still the right
 * step — only its picture is wrong — and the fix is to hand it the screenshot
 * the user took themselves.
 *
 * Whatever arrives is re-encoded rather than stored as it came. A capture is a
 * JPEG at quality 60 sized to the viewport; a phone screenshot or a PNG from
 * the system shortcut can be twenty times that, and it is stored in the flow,
 * carried in the ZIP and POSTed to the MCP server. Normalising here means one
 * step's image cannot quietly cost more than the other thirty put together.
 *
 * The validation and geometry are pure and tested; only `importScreenshot`
 * needs a canvas.
 */

import { SCREENSHOT_QUALITY } from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';

/**
 * Refused before decoding rather than after.
 *
 * Generous — a 4K PNG screenshot is around 10 MB — but bounded, because
 * decoding is what actually costs memory and a 200 MB file would take the tab
 * down before any of this ran.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The longest edge an imported screenshot keeps.
 *
 * A 2× capture of a large window lands around 3000px, so this is the same
 * neighbourhood rather than a downgrade — while still catching the 8000px
 * scrolling-capture that would otherwise be the largest thing in the flow.
 */
export const MAX_EDGE = 2560;

/** What the file picker and the drop target accept. */
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

/** Just enough of a `File` to check. Kept structural so tests need no DOM. */
export interface FileFacts {
  type: string;
  size: number;
  name?: string;
}

/**
 * Is this something we can turn into a screenshot?
 *
 * Returns the reason rather than a boolean: every one of these is a sentence
 * the user has to read to know what to do differently, and inventing that
 * sentence at the call site is how two entry points end up disagreeing.
 */
export function validateImageFile(file: FileFacts): Result<void> {
  if (!file.type.startsWith('image/')) {
    return err(
      flowError(
        'IMAGE_UNUSABLE',
        file.type,
        `${file.name ?? 'That file'} is not an image. Choose a PNG, JPEG or WebP.`,
      ),
    );
  }

  // SVG is an image the way a web page is an image: it can carry script and
  // fetch remote content, and it is drawn by the same engine that renders the
  // page it would be drawn into.
  if (file.type === 'image/svg+xml') {
    return err(
      flowError(
        'IMAGE_UNUSABLE',
        file.type,
        'SVG files cannot be used as screenshots. Export it as a PNG first.',
      ),
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    const mb = Math.round(MAX_FILE_BYTES / 1024 / 1024);
    return err(
      flowError(
        'IMAGE_UNUSABLE',
        `${file.size} bytes`,
        `${file.name ?? 'That image'} is larger than ${mb} MB. Crop or resize it first.`,
      ),
    );
  }

  if (file.size === 0) {
    return err(
      flowError('IMAGE_UNUSABLE', 'zero bytes', `${file.name ?? 'That file'} is empty.`),
    );
  }

  return ok();
}

/**
 * The size to draw at, never scaling up.
 *
 * Enlarging a small image would cost storage to add nothing — the pixels are
 * not there — so anything already inside the bound is drawn as it is.
 */
export function fitWithin(
  width: number,
  height: number,
  max = MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };

  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The first thing in a drop or a paste we can use.
 *
 * A paste from a screenshot tool carries the image alongside plain text, and a
 * drag from a browser carries an HTML fragment too; taking the first entry
 * would fail on both. Pure so the ordering rule is testable.
 */
export function firstImage(files: readonly FileFacts[]): FileFacts | null {
  return files.find((file) => file.type.startsWith('image/')) ?? null;
}

/** Decode a blob into an image the canvas can draw. */
function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the file could not be decoded as an image'));
    };

    image.src = url;
  });
}

/**
 * Normalise a user-supplied image into a step-ready JPEG data URL.
 *
 * The white fill is not cosmetic: JPEG has no alpha, so a PNG with a
 * transparent background drawn straight onto a fresh canvas flattens against
 * black, and a screenshot of a light UI comes back as an unreadable silhouette.
 */
export async function importScreenshot(file: File): Promise<Result<string>> {
  const valid = validateImageFile(file);
  if (!valid.ok) return valid;

  try {
    const image = await decode(file);
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight);

    if (!width || !height) {
      return err(
        flowError('IMAGE_UNUSABLE', `${width}x${height}`, 'That image has no dimensions.'),
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return err(
        flowError('IMAGE_UNUSABLE', 'no 2d context', 'This browser refused to open a canvas.'),
      );
    }

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    return ok(canvas.toDataURL('image/jpeg', SCREENSHOT_QUALITY / 100));
  } catch (error) {
    return err(
      flowError(
        'IMAGE_UNUSABLE',
        error,
        `${file.name || 'That file'} could not be read as an image.`,
      ),
    );
  }
}
