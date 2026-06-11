// annotator.js — MV3 service-worker safe screenshot annotator.
// Loaded via importScripts('lib/annotator.js') from background.js.
// NO window / document / FileReader / URL.createObjectURL here — they do not
// exist in a service worker and would throw. Uses OffscreenCanvas + btoa only.

const ANNOTATION_STROKE = '#FF3B30';
const ANNOTATION_FILL = 'rgba(255, 59, 48, 0.08)';

// Convert a Blob to a JPEG data URL without FileReader (unavailable in SW).
async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// Draw a red highlight box over the captured element and return a new data URL.
// box: {x, y, width, height} in CSS pixels (pre-DPR). dpr scales into device px.
async function annotateScreenshot(dataUrl, box, dpr) {
  if (!box) return dataUrl;

  const scale = dpr || 1;
  const blobIn = await (await fetch(dataUrl)).blob();
  const img = await createImageBitmap(blobIn);

  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const pad = 4 * scale;
  const x = box.x * scale - pad;
  const y = box.y * scale - pad;
  const w = box.width * scale + pad * 2;
  const h = box.height * scale + pad * 2;

  ctx.fillStyle = ANNOTATION_FILL;
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = ANNOTATION_STROKE;
  ctx.lineWidth = 3 * scale;
  ctx.strokeRect(x, y, w, h);

  const blobOut = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
  return blobToDataUrl(blobOut);
}
