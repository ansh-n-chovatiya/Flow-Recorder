/**
 * Generate the extension's PNG icons from the FlowSnap mark.
 *
 *   npm run build:mark
 *
 * The mark is one shape — a rounded square with a bolt cut into it — and it is
 * already drawn as inline SVG in the popup, the viewer and the settings page.
 * This renders the *same* geometry to the PNGs Chrome needs for the toolbar, the
 * extensions page and the tab favicon, so there is one mark rather than one per
 * place it appears. The icons it replaces were a red circle with a white slash,
 * unrelated to anything else in the product.
 *
 * No dependencies: a supersampling rasteriser and a minimal PNG encoder, in the
 * spirit of the ZIP writer in core/export. Chrome will not load an SVG here —
 * `manifest.icons` is raster only.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/icons');

/** The mark's own coordinate space, matching `viewBox="0 0 20 20"`. */
const VIEW = 20;
const RADIUS = 6;

/**
 * The bolt, as the `d` attribute resolves to.
 *
 *   M11.4 3.4 · L5.9 11 · h3.2 · l-.5 5.6 · L14.1 9 · h-3.2 · z
 */
const BOLT = [
  [11.4, 3.4],
  [5.9, 11],
  [9.1, 11],
  [8.6, 16.6],
  [14.1, 9],
  [10.9, 9],
];

/**
 * The dark theme's accent and its contrast colour.
 *
 * A toolbar icon sits in Chrome's own chrome, not in ours, so it cannot follow
 * the theme — one pair has to read on both. The brighter teal is the one that
 * survives a light toolbar as well as a dark one.
 */
const PLATE = [0x2b, 0xb3, 0xa3];
const BOLT_COLOUR = [0x04, 0x21, 0x1e];

/** Subsamples per axis. 4 is 16 samples a pixel — smooth at 16px. */
const SS = 4;

function insideRoundedRect(x, y) {
  const near = (v) => Math.min(v, VIEW - v);
  const dx = near(x);
  const dy = near(y);
  if (dx < 0 || dy < 0) return false;

  // Only the corner squares need the circle test.
  if (dx >= RADIUS || dy >= RADIUS) return true;
  return (RADIUS - dx) ** 2 + (RADIUS - dy) ** 2 <= RADIUS ** 2;
}

/** Even-odd crossing test. The bolt is a simple closed polygon. */
function insidePolygon(points, x, y) {
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }

  return inside;
}

/** RGBA rows, straight (un-premultiplied) alpha, as PNG wants them. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = VIEW / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * scale;
          const y = (py * SS + sy + 0.5) * scale;

          if (!insideRoundedRect(x, y)) continue;

          const colour = insidePolygon(BOLT, x, y) ? BOLT_COLOUR : PLATE;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits += 1;
        }
      }

      const at = (py * size + px) * 4;
      if (hits === 0) continue;

      // Averaged over the covered samples only, so an edge pixel keeps the
      // colour of the shape rather than fading towards black.
      pixels[at] = Math.round(r / hits);
      pixels[at + 1] = Math.round(g / hits);
      pixels[at + 2] = Math.round(b / hits);
      pixels[at + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }

  return pixels;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10–12: deflate, adaptive filtering, no interlace — all zero.

  // Filter type 0 on every scanline. The image is tiny and mostly flat; a
  // smarter filter would save bytes nobody would notice.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const from = y * size * 4;
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write ────────────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });

/** 32 is what Chrome asks for on a HiDPI toolbar; without it, 48 is downscaled. */
const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const file = resolve(outDir, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`mark: wrote ${size}×${size} to public/icons/icon${size}.png`);
}
