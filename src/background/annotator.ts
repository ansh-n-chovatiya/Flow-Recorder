/**
 * Screenshot annotation, service-worker safe.
 *
 * A worker has no `window`, `document`, `FileReader` or `URL.createObjectURL`,
 * so this uses `OffscreenCanvas` and manual base64 — anything else throws at
 * runtime with an error that looks nothing like the cause.
 */

import { ANNOTATION_FILL, ANNOTATION_STROKE } from '../shared/constants.js';
import type { BoundingBox } from '../shared/types.js';

/** Chunk size for base64 encoding; larger blows the argument limit of `apply`. */
const CHUNK = 0x8000;

/** Padding around the highlight box, in CSS pixels. */
const BOX_PAD = 4;

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

/**
 * Draw a highlight box over the captured element and return a new data URL.
 * `box` is in CSS pixels; `dpr` scales it into the device pixels the screenshot
 * is actually in.
 */
export async function annotateScreenshot(
  dataUrl: string,
  box: BoundingBox | null,
  dpr: number,
): Promise<string> {
  if (!box) return dataUrl;

  const scale = dpr || 1;
  const source = await (await fetch(dataUrl)).blob();
  const img = await createImageBitmap(source);

  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.drawImage(img, 0, 0);

  const pad = BOX_PAD * scale;
  const x = box.x * scale - pad;
  const y = box.y * scale - pad;
  const w = box.width * scale + pad * 2;
  const h = box.height * scale + pad * 2;

  ctx.fillStyle = ANNOTATION_FILL;
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = ANNOTATION_STROKE;
  ctx.lineWidth = 3 * scale;
  ctx.strokeRect(x, y, w, h);

  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
  return blobToDataUrl(out);
}
