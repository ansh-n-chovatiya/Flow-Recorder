/**
 * Viewer page: review a recorded flow, edit it, export it, send it to Claude.
 *
 * This is a direct port of the pre-TypeScript viewer, split only far enough to
 * be type-checked. It is deliberately still one file: the redesign replaces the
 * whole UI layer, and splitting code that is about to be rewritten twice is
 * churn. The store, export and MCP logic move out to `features/` first.
 */

import { createZip, dataUrlToBytes, type ZipEntry } from '../../core/export/zip.js';
import { exportToJSON } from '../../core/export/json.js';
import { exportToMarkdown } from '../../core/export/markdown.js';
import { compactBody } from '../../core/schema/index.js';
import {
  defaultFilename,
  formatDelta,
  pad2,
  sanitizeFilename,
  startUrl,
} from '../../core/flow/index.js';
import { DEFAULT_MCP_URL } from '../../shared/constants.js';
import { sendToWorker } from '../../shared/messages.js';
import { savedFlowKey } from '../../shared/types.js';
import type {
  ConsoleEntry,
  ExportOptions,
  FlowMeta,
  NetworkCall,
  Step,
} from '../../shared/types.js';

// ── Module state ─────────────────────────────────────────────────────────────

let currentSteps: Step[] = [];
/** Cleanup for the open image editor's document listeners. */
let editorCleanup: (() => void) | null = null;
/** Undo stack for step deletion. */
let deleteHistory: { index: number; step: Step }[] = [];
/** `null` = live recording; otherwise the saved flow being viewed. */
let viewingMode: { id: string; name: string } | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`FlowSnap: missing #${id} in viewer.html`);
  return node as T;
}

// ── Network & log rendering ──────────────────────────────────────────────────

interface Swatch {
  bg: string;
  fg: string;
}

const METHOD_STYLE: Record<string, Swatch> = {
  GET: { bg: '#dbeafe', fg: '#1d4ed8' },
  POST: { bg: '#dcfce7', fg: '#15803d' },
  PUT: { bg: '#ffedd5', fg: '#c2410c' },
  PATCH: { bg: '#f3e8ff', fg: '#7e22ce' },
  DELETE: { bg: '#fee2e2', fg: '#b91c1c' },
};
const METHOD_DEFAULT: Swatch = { bg: '#f1f5f9', fg: '#475569' };

function methodStyle(method: string): Swatch {
  return METHOD_STYLE[method.toUpperCase()] ?? METHOD_DEFAULT;
}

function statusStyle(code: number | null): Swatch {
  if (!code) return { bg: '#fee2e2', fg: '#b91c1c' };
  if (code >= 500) return { bg: '#fee2e2', fg: '#b91c1c' };
  if (code >= 400) return { bg: '#ffedd5', fg: '#c2410c' };
  if (code >= 300) return { bg: '#dbeafe', fg: '#1d4ed8' };
  return { bg: '#dcfce7', fg: '#15803d' };
}

const LOG_STYLE: Record<string, Swatch & { border: string }> = {
  error: { bg: '#fee2e2', fg: '#b91c1c', border: '#e53935' },
  warn: { bg: '#fff7ed', fg: '#c2410c', border: '#fb8c00' },
  info: { bg: '#eff6ff', fg: '#1d4ed8', border: '#1e88e5' },
  debug: { bg: '#faf5ff', fg: '#7e22ce', border: '#9c27b0' },
  log: { bg: '#f8fafc', fg: '#475569', border: '#94a3b8' },
};

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const search =
      u.search.length > 1 ? u.search.slice(0, 40) + (u.search.length > 41 ? '…' : '') : '';
    return u.hostname + u.pathname + search;
  } catch {
    return url.length > 70 ? `${url.slice(0, 70)}…` : url;
  }
}

function tryPretty(str: string): string {
  const trimmed = str.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return str;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return str;
  }
}

function makeHeadersTable(headers: Record<string, string>): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'nc-htable';
  for (const [key, value] of Object.entries(headers)) {
    const row = document.createElement('tr');
    const keyCell = document.createElement('td');
    keyCell.className = 'nc-hk';
    keyCell.textContent = key;
    const valueCell = document.createElement('td');
    valueCell.className = 'nc-hv';
    valueCell.textContent = value;
    row.append(keyCell, valueCell);
    table.appendChild(row);
  }
  return table;
}

function makePanel(id: string, headers: Record<string, string>, body: string | null): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'nc-panel';
  panel.dataset.id = id;

  const hasHeaders = Object.keys(headers ?? {}).length > 0;
  if (!hasHeaders && !body) {
    const empty = document.createElement('span');
    empty.className = 'nc-empty';
    empty.textContent = 'No data';
    panel.appendChild(empty);
    return panel;
  }

  if (hasHeaders) {
    const label = document.createElement('div');
    label.className = 'nc-slabel';
    label.textContent = 'Headers';
    panel.append(label, makeHeadersTable(headers));
  }

  if (body) {
    const label = document.createElement('div');
    label.className = 'nc-slabel';
    label.textContent = 'Body';
    panel.appendChild(label);

    const compact = compactBody(body) ?? body;
    const isCompacted = compact !== body;

    const pre = document.createElement('pre');
    pre.className = 'nc-body';
    pre.textContent = isCompacted ? compact : tryPretty(body);

    if (isCompacted) {
      const toggle = document.createElement('button');
      toggle.className = 'nc-body-toggle';
      toggle.textContent = 'Show raw';
      let raw = false;
      toggle.addEventListener('click', () => {
        raw = !raw;
        pre.textContent = raw ? tryPretty(body) : compact;
        toggle.textContent = raw ? 'Show schema' : 'Show raw';
      });
      panel.appendChild(toggle);
    }

    panel.appendChild(pre);
  }

  return panel;
}

function buildNetworkCard(call: NetworkCall): HTMLElement {
  const ms = methodStyle(call.method || 'GET');
  const ss = statusStyle(call.status);

  const card = document.createElement('div');
  card.className = 'nc-card';

  const row = document.createElement('div');
  row.className = 'nc-row';

  const method = document.createElement('span');
  method.className = 'nc-method';
  method.textContent = (call.method || 'GET').toUpperCase();
  method.style.cssText = `background:${ms.bg};color:${ms.fg}`;

  const url = document.createElement('span');
  url.className = 'nc-url';
  url.textContent = shortUrl(call.url || '');
  url.title = call.url || '';

  const status = document.createElement('span');
  status.className = 'nc-status';
  status.textContent = String(call.status ?? 'ERR');
  status.style.cssText = `background:${ss.bg};color:${ss.fg}`;

  const duration = document.createElement('span');
  duration.className = 'nc-dur';
  duration.textContent = `${call.durationMs || 0}ms`;

  const caret = document.createElement('span');
  caret.className = 'nc-caret';
  caret.textContent = '›';

  row.append(method, url, status, duration, caret);
  card.appendChild(row);

  const expand = document.createElement('div');
  expand.className = 'nc-expand';
  expand.style.display = 'none';

  const tabs = document.createElement('div');
  tabs.className = 'nc-tabs';

  const reqTab = document.createElement('button');
  reqTab.className = 'nc-tab';
  reqTab.textContent = 'Request';
  reqTab.dataset.id = 'req';

  const resTab = document.createElement('button');
  resTab.className = 'nc-tab';
  resTab.textContent = 'Response';
  resTab.dataset.id = 'res';

  tabs.append(reqTab, resTab);

  const reqPanel = makePanel('req', call.requestHeaders, call.requestBody);
  const resPanel = makePanel('res', call.responseHeaders, call.responseBody);

  const activate = (id: string) => {
    for (const tab of [reqTab, resTab]) tab.classList.toggle('active', tab.dataset.id === id);
    for (const panel of [reqPanel, resPanel]) {
      panel.classList.toggle('active', panel.dataset.id === id);
    }
  };
  activate('res');

  tabs.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('.nc-tab');
    if (tab?.dataset.id) activate(tab.dataset.id);
  });

  expand.append(tabs, reqPanel, resPanel);
  card.appendChild(expand);

  let open = false;
  row.addEventListener('click', () => {
    open = !open;
    expand.style.display = open ? 'block' : 'none';
    caret.style.transform = open ? 'rotate(90deg)' : '';
  });

  return card;
}

function buildLogRow(log: ConsoleEntry): HTMLElement {
  const style = LOG_STYLE[log.level] ?? LOG_STYLE.log;

  const row = document.createElement('div');
  row.className = 'cl-row';
  row.style.borderLeftColor = style.border;

  const badge = document.createElement('span');
  badge.className = 'cl-badge';
  badge.textContent = log.level || 'log';
  badge.style.cssText = `background:${style.bg};color:${style.fg}`;

  const message = document.createElement('span');
  message.className = 'cl-msg';
  message.textContent = log.args.join(' ');

  const timestamp = document.createElement('span');
  timestamp.className = 'cl-ts';
  timestamp.textContent = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';

  row.append(badge, message, timestamp);
  return row;
}

// ── Step card ────────────────────────────────────────────────────────────────

function appendMetaItem(
  container: HTMLElement,
  key: string,
  value: string | null | undefined,
  asSelector = false,
): void {
  if (!value) return;

  const item = document.createElement('span');
  item.className = 'meta-item';

  const keyEl = document.createElement('span');
  keyEl.className = 'meta-key';
  keyEl.textContent = `${key}:`;

  const valueEl = document.createElement('span');
  if (asSelector) valueEl.className = 'selector';
  valueEl.textContent = value;

  item.append(keyEl, valueEl);
  container.appendChild(item);
}

function buildDetails(label: string, count: number, body: HTMLElement): HTMLElement {
  const details = document.createElement('details');
  details.className = 'step-details';

  const summary = document.createElement('summary');
  const title = document.createTextNode(`${label} `);
  const countEl = document.createElement('span');
  countEl.className = 'detail-count';
  countEl.textContent = String(count);
  const chevron = document.createElement('span');
  chevron.className = 'detail-chevron';
  chevron.textContent = '›';
  summary.append(title, countEl, chevron);

  details.append(summary, body);
  return details;
}

function buildStepCard(step: Step, index: number, prevStep: Step | null): HTMLElement {
  const card = document.createElement('div');
  card.className = 'step';
  card.tabIndex = 0; // keyboard-focusable for Del / E shortcuts
  card.dataset.index = String(index);

  const head = document.createElement('div');
  head.className = 'step-head';

  const num = document.createElement('div');
  num.className = 'step-num';
  num.textContent = String(index + 1);
  head.appendChild(num);

  const typeBadge = document.createElement('span');
  typeBadge.className = `step-type-badge ${step.type}`;
  typeBadge.textContent = step.type;
  head.appendChild(typeBadge);

  // Editable action title
  const action = document.createElement('div');
  action.className = 'step-action editable';
  action.textContent = step.action || step.type;
  action.title = 'Click to edit';
  action.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'step-edit-input';
    input.value = step.action || step.type;
    action.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const value = input.value.trim() || (action.textContent ?? '');
      input.replaceWith(action);
      action.textContent = value;
      saveStep(index, { ...step, action: value });
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        committed = true;
        input.replaceWith(action);
      }
    });
  });
  head.appendChild(action);

  if (prevStep?.timestamp && step.timestamp) {
    const delta = formatDelta(step.timestamp - prevStep.timestamp);
    if (delta) {
      const timing = document.createElement('span');
      timing.className = 'step-timing';
      timing.title = 'Time since previous step';
      timing.textContent = delta;
      head.appendChild(timing);
    }
  }

  card.appendChild(head);

  if (step.title) {
    const title = document.createElement('div');
    title.className = 'step-title';
    title.textContent = step.title;
    card.appendChild(title);
  }

  if (step.url) {
    const url = document.createElement('div');
    url.className = 'step-url';
    url.textContent = step.url;
    card.appendChild(url);
  }

  if (step.element) {
    const meta = document.createElement('div');
    meta.className = 'step-meta';
    appendMetaItem(meta, 'Tag', step.element.tag);
    appendMetaItem(meta, 'Label', step.element.label ?? step.element.text);
    appendMetaItem(meta, 'Role', step.element.role);
    appendMetaItem(meta, 'Aria', step.element.ariaLabel);
    appendMetaItem(meta, 'CSS', step.element.cssSelector, true);
    appendMetaItem(meta, 'XPath', step.element.xpath, true);
    if (meta.childNodes.length) card.appendChild(meta);
  }

  if (step.value) {
    const value = document.createElement('div');
    value.className = 'step-value';
    const key = document.createElement('span');
    key.className = 'meta-key';
    key.textContent = 'Value: ';
    const chip = document.createElement('span');
    chip.className = 'selector';
    chip.textContent = step.value;
    value.append(key, chip);
    card.appendChild(value);
  }

  if (step.screenshot) card.appendChild(buildScreenshot(step.screenshot, index));

  card.appendChild(buildEditBar(step, index, card));

  if (step.networkCalls?.length) {
    const inner = document.createElement('div');
    inner.className = 'step-details-inner';
    for (const call of step.networkCalls) inner.appendChild(buildNetworkCard(call));
    card.appendChild(buildDetails('Network calls', step.networkCalls.length, inner));
  }

  if (step.consoleLogs?.length) {
    const rows = document.createElement('div');
    rows.className = 'cl-rows';
    for (const log of step.consoleLogs) rows.appendChild(buildLogRow(log));
    card.appendChild(buildDetails('Console logs', step.consoleLogs.length, rows));
  }

  const notes = document.createElement('textarea');
  notes.className = 'step-notes';
  notes.placeholder = 'Add notes…';
  notes.rows = step.notes ? 3 : 2;
  notes.value = step.notes ?? '';
  notes.addEventListener('blur', () => {
    if (notes.value !== (step.notes ?? '')) saveStep(index, { ...step, notes: notes.value });
  });
  card.appendChild(notes);

  const del = document.createElement('button');
  del.className = 'delete-step';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Delete this step';
  del.addEventListener('click', () => deleteStep(index));
  card.appendChild(del);

  return card;
}

/** 1×1 transparent GIF, so a lazy image has a src before it scrolls into view. */
const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function buildScreenshot(dataUrl: string, index: number): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'step-screenshot';
  img.alt = `Screenshot for step ${index + 1}`;

  // Thirty base64 JPEGs decoded at once locks the page; decode on approach.
  if ('IntersectionObserver' in window) {
    img.dataset.src = dataUrl;
    img.src = BLANK_GIF;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLImageElement;
          if (target.dataset.src) target.src = target.dataset.src;
          observer.unobserve(target);
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(img);
  } else {
    img.src = dataUrl;
  }

  return img;
}

function buildEditBar(step: Step, index: number, card: HTMLElement): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'step-edit-bar';

  if (step.screenshot ?? step.screenshotOriginal) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-bar-btn';
    editBtn.textContent = 'Edit Image';
    editBtn.addEventListener('click', () => {
      const existing = card.querySelector('.img-editor');
      if (existing) {
        editorCleanup?.();
        editorCleanup = null;
        existing.remove();
        return;
      }
      bar.insertAdjacentElement('afterend', buildImageEditor(step, index));
    });
    bar.appendChild(editBtn);
  }

  const replaceBtn = document.createElement('button');
  replaceBtn.className = 'edit-bar-btn';
  replaceBtn.textContent = 'Replace Image';
  replaceBtn.addEventListener('click', () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.remove();
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        persistStep(index, {
          ...step,
          screenshot: reader.result as string,
          screenshotOriginal: null,
          highlightBox: null,
        });
      };
      reader.readAsDataURL(file);
    });

    fileInput.click();
  });
  bar.appendChild(replaceBtn);

  return bar;
}

// ── Render ───────────────────────────────────────────────────────────────────

function render(steps: Step[]): void {
  editorCleanup?.();
  editorCleanup = null;
  currentSteps = Array.isArray(steps) ? steps : [];

  const banner = el('viewing-banner');
  if (viewingMode) {
    el('viewing-name').textContent = viewingMode.name;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }

  const container = el('steps-container');
  container.textContent = '';

  if (!currentSteps.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No steps recorded yet.';
    container.appendChild(empty);
    return;
  }

  currentSteps.forEach((step, i) => {
    container.appendChild(buildStepCard(step, i, i > 0 ? currentSteps[i - 1] : null));
  });
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Write back and re-render. Saved flows are read-only in this build. */
function commit(steps: Step[]): void {
  if (viewingMode) {
    render(steps);
    return;
  }
  chrome.storage.local.set({ recordedSteps: steps }, () => render(steps));
}

function deleteStep(index: number): void {
  const [removed] = currentSteps.splice(index, 1);
  deleteHistory.push({ index, step: removed });
  commit(currentSteps.slice());
}

function undoDelete(): void {
  const last = deleteHistory.pop();
  if (!last) return;
  const restored = currentSteps.slice();
  restored.splice(last.index, 0, last.step);
  commit(restored);
}

/** A structural change — re-renders. */
function persistStep(index: number, updated: Step): void {
  currentSteps[index] = updated;
  commit(currentSteps.slice());
}

/** A lightweight change (notes, inline title) — no re-render. */
function saveStep(index: number, updated: Step): void {
  currentSteps[index] = updated;
  if (!viewingMode) void chrome.storage.local.set({ recordedSteps: currentSteps.slice() });
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;

  const focusedCard = document.activeElement?.closest<HTMLElement>('.step[data-index]');

  // Delete, not Backspace — Backspace is muscle-memory "back".
  if (event.key === 'Delete') {
    if (!focusedCard) return;
    event.preventDefault();
    deleteStep(Number(focusedCard.dataset.index));
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
    event.preventDefault();
    undoDelete();
    return;
  }

  if (event.key === 'e' || event.key === 'E') {
    if (!focusedCard) return;
    event.preventDefault();
    // Match by text: the first .edit-bar-btn is "Replace Image" when the step
    // has no screenshot.
    const buttons = Array.from(focusedCard.querySelectorAll<HTMLButtonElement>('.edit-bar-btn'));
    buttons.find((b) => b.textContent?.trim() === 'Edit Image')?.click();
  }
});

// ── Image editor ─────────────────────────────────────────────────────────────

type Tool = 'pen' | 'rect' | 'ellipse' | 'arrow' | 'highlight' | 'blur' | 'text';

interface Point {
  x: number;
  y: number;
}

interface DrawOp {
  tool: Tool;
  color: string;
  width?: number;
  points?: Point[];
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  x?: number;
  y?: number;
  text?: string;
  fontSize?: number;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
): void {
  const headLen = Math.max(15, width * 5);
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function renderOp(ctx: CanvasRenderingContext2D, op: DrawOp): void {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.lineWidth = op.width ?? 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const x1 = op.x1 ?? 0;
  const y1 = op.y1 ?? 0;
  const x2 = op.x2 ?? 0;
  const y2 = op.y2 ?? 0;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  switch (op.tool) {
    case 'pen': {
      const points = op.points;
      if (!points || points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
      break;
    }

    case 'rect':
      ctx.strokeRect(left, top, width, height);
      break;

    case 'ellipse': {
      if (!width || !height) break;
      ctx.beginPath();
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }

    case 'arrow':
      drawArrow(ctx, x1, y1, x2, y2, op.width ?? 2);
      break;

    case 'highlight':
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = op.color;
      ctx.fillRect(left, top, width, height);
      ctx.restore();
      break;

    case 'blur': {
      // Pixelate to obscure PII: scale the region down, then back up with
      // smoothing off so it comes back as blocks.
      if (width < 2 || height < 2) break;
      const blockSize = 12;
      const pw = Math.max(1, Math.round(width / blockSize));
      const ph = Math.max(1, Math.round(height / blockSize));

      const temp = document.createElement('canvas');
      temp.width = pw;
      temp.height = ph;
      const tempCtx = temp.getContext('2d');
      if (!tempCtx) break;
      tempCtx.imageSmoothingEnabled = true;
      tempCtx.drawImage(ctx.canvas, left, top, width, height, 0, 0, pw, ph);

      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(temp, 0, 0, pw, ph, left, top, width, height);
      ctx.restore();
      break;
    }

    case 'text':
      ctx.save();
      ctx.fillStyle = op.color;
      ctx.font = `bold ${op.fontSize ?? 18}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 3;
      ctx.fillText(op.text ?? '', op.x ?? 0, op.y ?? 0);
      ctx.restore();
      break;
  }

  ctx.restore();
}

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'pen', label: 'Pen', title: 'Freehand pen' },
  { id: 'rect', label: 'Rect', title: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse', title: 'Ellipse / circle' },
  { id: 'arrow', label: 'Arrow', title: 'Arrow' },
  { id: 'highlight', label: 'Hi-lite', title: 'Highlight (semi-transparent fill)' },
  { id: 'blur', label: 'Blur', title: 'Pixelate region (hide PII)' },
  { id: 'text', label: 'Text', title: 'Add text label (click to place)' },
];

const COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#000000', '#FFFFFF'];
const WIDTHS = [
  { value: 2, label: 'S' },
  { value: 4, label: 'M' },
  { value: 8, label: 'L' },
];

function buildImageEditor(step: Step, index: number): HTMLElement {
  const editor = document.createElement('div');
  editor.className = 'img-editor';

  let tool: Tool = 'pen';
  let color = COLORS[0];
  let lineWidth = 3;
  let history: DrawOp[] = [];
  let activeOp: DrawOp | null = null;

  const toolbar = document.createElement('div');
  toolbar.className = 'ie-toolbar';

  const makeGroup = () => {
    const group = document.createElement('div');
    group.className = 'ie-group';
    return group;
  };

  // Tools
  const toolGroup = makeGroup();
  const toolButtons: HTMLButtonElement[] = [];
  for (const entry of TOOLS) {
    const button = document.createElement('button');
    button.className = `ie-btn${entry.id === tool ? ' active' : ''}`;
    button.textContent = entry.label;
    button.title = entry.title;
    button.addEventListener('click', () => {
      tool = entry.id;
      for (const other of toolButtons) other.classList.remove('active');
      button.classList.add('active');
    });
    toolButtons.push(button);
    toolGroup.appendChild(button);
  }

  // Colours
  const colorGroup = makeGroup();
  const colorButtons: HTMLButtonElement[] = [];
  for (const swatch of COLORS) {
    const button = document.createElement('button');
    button.className = `ie-color${swatch === color ? ' active' : ''}`;
    button.style.background = swatch;
    button.title = swatch;
    button.addEventListener('click', () => {
      color = swatch;
      for (const other of colorButtons) other.classList.remove('active');
      button.classList.add('active');
    });
    colorButtons.push(button);
    colorGroup.appendChild(button);
  }

  // Stroke widths
  const widthGroup = makeGroup();
  const widthButtons: HTMLButtonElement[] = [];
  for (const width of WIDTHS) {
    const button = document.createElement('button');
    button.className = `ie-btn${width.value === lineWidth ? ' active' : ''}`;
    button.textContent = width.label;
    button.title = `${width.value}px stroke`;
    button.addEventListener('click', () => {
      lineWidth = width.value;
      for (const other of widthButtons) other.classList.remove('active');
      button.classList.add('active');
    });
    widthButtons.push(button);
    widthGroup.appendChild(button);
  }

  // Actions
  const actionGroup = makeGroup();
  actionGroup.classList.add('ie-actions');

  const undoBtn = document.createElement('button');
  undoBtn.className = 'ie-btn';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', () => {
    if (history.length) {
      history.pop();
      redraw();
    }
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'ie-btn ie-save';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ie-btn ie-cancel';
  cancelBtn.textContent = 'Cancel';

  actionGroup.append(undoBtn, saveBtn, cancelBtn);
  toolbar.append(toolGroup, colorGroup, widthGroup, actionGroup);

  // Canvas
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'ie-canvas-wrap';
  canvasWrap.style.position = 'relative'; // anchors the text-input overlay

  const canvas = document.createElement('canvas');
  canvas.className = 'ie-canvas';
  canvasWrap.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  const baseImg = new Image();
  baseImg.src = step.screenshotOriginal ?? step.screenshot ?? '';
  baseImg.onload = () => {
    canvas.width = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    redraw();
  };

  function redraw(): void {
    if (!ctx || !canvas.width) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (baseImg.complete && baseImg.naturalWidth) ctx.drawImage(baseImg, 0, 0);
    for (const op of history) renderOp(ctx, op);
    if (activeOp) renderOp(ctx, activeOp);
  }

  function canvasXY(event: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function handleTextClick(event: MouseEvent): void {
    event.preventDefault();
    const point = canvasXY(event);
    const wrapRect = canvasWrap.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvasRect.height / canvas.height;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ie-text-input';
    input.style.left = `${event.clientX - wrapRect.left}px`;
    input.style.top = `${event.clientY - wrapRect.top}px`;
    input.style.color = color;
    input.style.fontSize = `${Math.round(18 * scale)}px`;
    canvasWrap.appendChild(input);
    input.focus();

    let committed = false;
    const commitText = () => {
      if (committed) return;
      committed = true;
      const text = input.value.trim();
      input.remove();
      if (!text) return;
      history.push({ tool: 'text', color, text, x: point.x, y: point.y, fontSize: 18 });
      redraw();
    };

    input.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Enter') {
        keyEvent.preventDefault();
        commitText();
      }
      if (keyEvent.key === 'Escape') {
        committed = true;
        input.remove();
      }
    });
    input.addEventListener('blur', commitText);
  }

  canvas.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (tool === 'text') {
      handleTextClick(event);
      return;
    }
    const point = canvasXY(event);
    activeOp =
      tool === 'pen'
        ? { tool, color, width: lineWidth, points: [point] }
        : { tool, color, width: lineWidth, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  });

  // On document, not canvas, so a drag that leaves the image still tracks.
  const onMove = (event: MouseEvent) => {
    if (!activeOp) return;
    const point = canvasXY(event);
    if (activeOp.tool === 'pen') activeOp.points?.push(point);
    else {
      activeOp.x2 = point.x;
      activeOp.y2 = point.y;
    }
    redraw();
  };

  const onUp = (event: MouseEvent) => {
    if (!activeOp) return;
    const point = canvasXY(event);
    if (activeOp.tool === 'pen') {
      activeOp.points?.push(point);
      if ((activeOp.points?.length ?? 0) >= 2) history.push(activeOp);
    } else {
      activeOp.x2 = point.x;
      activeOp.y2 = point.y;
      history.push(activeOp);
    }
    activeOp = null;
    redraw();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  const cleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  editorCleanup = cleanup;

  saveBtn.addEventListener('click', () => {
    activeOp = null;
    redraw();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    cleanup();
    editorCleanup = null;
    persistStep(index, { ...step, screenshot: dataUrl });
  });

  cancelBtn.addEventListener('click', () => {
    cleanup();
    editorCleanup = null;
    history = [];
    editor.remove();
  });

  editor.append(toolbar, canvasWrap);
  return editor;
}

// ── Export ───────────────────────────────────────────────────────────────────

function downloadBlob(filename: string, blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function downloadFile(filename: string, content: string, mimeType: string): void {
  downloadBlob(filename, new Blob([content], { type: mimeType }));
}

function getExportOpts(): ExportOptions {
  return {
    images: el<HTMLInputElement>('opt-images').checked,
    network: el<HTMLInputElement>('opt-network').checked,
    logs: el<HTMLInputElement>('opt-logs').checked,
  };
}

function loadExportOpts(): void {
  chrome.storage.local.get('exportOptions', (data) => {
    const opts = (data as { exportOptions?: ExportOptions }).exportOptions ?? {
      images: true,
      network: true,
      logs: true,
    };
    el<HTMLInputElement>('opt-images').checked = opts.images !== false;
    el<HTMLInputElement>('opt-network').checked = opts.network !== false;
    el<HTMLInputElement>('opt-logs').checked = opts.logs !== false;
  });
}

async function doExportZip(name: string, opts: ExportOptions): Promise<void> {
  if (!currentSteps.length) return;

  const encoder = new TextEncoder();
  const files: ZipEntry[] = [];
  const imageNames: (string | null)[] = [];

  currentSteps.forEach((step, i) => {
    const shot = step.screenshot;
    if (opts.images !== false && typeof shot === 'string' && shot.startsWith('data:')) {
      const { bytes, ext } = dataUrlToBytes(shot);
      const imgName = `images/step-${pad2(i + 1)}.${ext}`;
      files.push({ name: imgName, data: bytes });
      imageNames.push(imgName);
    } else {
      imageNames.push(null);
    }
  });

  const markdown = exportToMarkdown(currentSteps, {
    title: 'Flow Recording',
    images: opts.images === false ? { kind: 'none' } : { kind: 'file', names: imageNames },
    network: opts.network,
    logs: opts.logs,
  });
  files.push({ name: 'flow.md', data: encoder.encode(markdown) });

  const json = exportToJSON(currentSteps, { ...opts, imageNames });
  files.push({ name: 'flow.json', data: encoder.encode(json) });

  downloadBlob(`${name}.zip`, await createZip(files));
}

function doExportMd(name: string, opts: ExportOptions): void {
  const markdown = exportToMarkdown(currentSteps, {
    title: document.title || 'Flow Recording',
    images: opts.images,
    network: opts.network,
    logs: opts.logs,
  });
  downloadFile(`${name}.md`, markdown, 'text/markdown');
}

function doExportJson(name: string, opts: ExportOptions): void {
  downloadFile(`${name}.json`, exportToJSON(currentSteps, opts), 'application/json');
}

// ── Filename modal ───────────────────────────────────────────────────────────

type ExportKind = 'zip' | 'md' | 'json';

const EXTENSIONS: Record<ExportKind, string> = { zip: '.zip', md: '.md', json: '.json' };

let modalCleanup: (() => void) | null = null;

function promptAndExport(kind: ExportKind): void {
  if (!currentSteps.length) return;
  modalCleanup?.();
  modalCleanup = null;

  const modal = el('filename-modal');
  const input = el<HTMLInputElement>('filename-input');
  const confirmBtn = el<HTMLButtonElement>('filename-confirm');
  const cancelBtn = el<HTMLButtonElement>('filename-cancel');

  input.value = defaultFilename();
  el('filename-ext').textContent = EXTENSIONS[kind];
  modal.style.display = 'flex';
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);

  const hide = () => {
    modal.style.display = 'none';
    modalCleanup?.();
    modalCleanup = null;
  };

  const onConfirm = () => {
    const name = sanitizeFilename(input.value);
    hide();
    const opts = getExportOpts();
    if (kind === 'zip') void doExportZip(name, opts);
    else if (kind === 'md') doExportMd(name, opts);
    else doExportJson(name, opts);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onConfirm();
    }
    if (event.key === 'Escape') hide();
  };

  const onBackdrop = (event: MouseEvent) => {
    if (event.target === modal) hide();
  };

  confirmBtn.addEventListener('click', onConfirm);
  cancelBtn.addEventListener('click', hide);
  input.addEventListener('keydown', onKey);
  modal.addEventListener('click', onBackdrop);

  modalCleanup = () => {
    confirmBtn.removeEventListener('click', onConfirm);
    cancelBtn.removeEventListener('click', hide);
    input.removeEventListener('keydown', onKey);
    modal.removeEventListener('click', onBackdrop);
  };
}

// ── Saved flows ──────────────────────────────────────────────────────────────

function loadSavedFlowsMeta(): Promise<FlowMeta[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get('savedFlowsMeta', (data) => {
      const meta = (data as { savedFlowsMeta?: FlowMeta[] }).savedFlowsMeta;
      resolve(Array.isArray(meta) ? meta : []);
    });
  });
}

async function refreshSavedFlowsCount(): Promise<void> {
  const meta = await loadSavedFlowsMeta();
  el('saved-flows-count').textContent = String(meta.length);
}

async function renderSavedFlowsList(): Promise<void> {
  const meta = await loadSavedFlowsMeta();
  const list = el('saved-flows-list');
  list.textContent = '';

  if (!meta.length) {
    const empty = document.createElement('div');
    empty.className = 'saved-flows-empty';
    empty.textContent = 'No saved flows yet. Click "Save Flow" to archive the current recording.';
    list.appendChild(empty);
    return;
  }

  for (const entry of meta) {
    const item = document.createElement('div');
    item.className = 'saved-flow-item';

    const info = document.createElement('div');
    info.className = 'saved-flow-info';

    const name = document.createElement('div');
    name.className = 'saved-flow-name';
    name.textContent = entry.name;

    const created = new Date(entry.createdAt);
    const details = document.createElement('div');
    details.className = 'saved-flow-meta';
    details.textContent = `${entry.stepCount} steps · ${created.toLocaleDateString()} ${created.toLocaleTimeString()}`;

    info.append(name, details);

    const actions = document.createElement('div');
    actions.className = 'saved-flow-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-load-flow';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', () => {
      chrome.storage.local.get(savedFlowKey(entry.id), (data) => {
        const steps = (data as Record<string, Step[]>)[savedFlowKey(entry.id)] ?? [];
        viewingMode = { id: entry.id, name: entry.name };
        deleteHistory = [];
        el('saved-flows-panel').style.display = 'none';
        render(steps);
      });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-flow';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      void (async () => {
        const existing = await loadSavedFlowsMeta();
        chrome.storage.local.set(
          {
            savedFlowsMeta: existing.filter((x) => x.id !== entry.id),
            [savedFlowKey(entry.id)]: null,
          },
          () => {
            void refreshSavedFlowsCount();
            void renderSavedFlowsList();
          },
        );
      })();
    });

    actions.append(loadBtn, deleteBtn);
    item.append(info, actions);
    list.appendChild(item);
  }
}

function promptSaveFlow(): void {
  if (!currentSteps.length) return;

  const modal = el('save-flow-modal');
  const input = el<HTMLInputElement>('save-flow-input');
  const confirmBtn = el<HTMLButtonElement>('save-flow-confirm');
  const cancelBtn = el<HTMLButtonElement>('save-flow-cancel');

  const now = new Date();
  input.value = `Recording – ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
  modal.style.display = 'flex';
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);

  const cleanup = () => {
    confirmBtn.removeEventListener('click', doSave);
    cancelBtn.removeEventListener('click', hide);
    input.removeEventListener('keydown', onKey);
    modal.removeEventListener('click', onBackdrop);
  };

  function hide(): void {
    modal.style.display = 'none';
    cleanup();
  }

  function doSave(): void {
    const name = input.value.trim() || 'Untitled Flow';
    hide();

    const id = `flow_${Date.now()}`;
    const meta: FlowMeta = { id, name, createdAt: Date.now(), stepCount: currentSteps.length };

    void (async () => {
      const existing = await loadSavedFlowsMeta();
      chrome.storage.local.set(
        { savedFlowsMeta: [...existing, meta], [savedFlowKey(id)]: currentSteps.slice() },
        () => void refreshSavedFlowsCount(),
      );
    })();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      doSave();
    }
    if (event.key === 'Escape') hide();
  }

  function onBackdrop(event: MouseEvent): void {
    if (event.target === modal) hide();
  }

  confirmBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', hide);
  input.addEventListener('keydown', onKey);
  modal.addEventListener('click', onBackdrop);
}

// ── Loading ──────────────────────────────────────────────────────────────────

function loadSteps(): void {
  void (async () => {
    const response = await sendToWorker({ type: 'GET_STEPS' });
    if (response?.steps.length) {
      render(response.steps);
      return;
    }
    // The worker may be asleep, or genuinely have nothing — either way storage
    // is the source of truth.
    chrome.storage.local.get('recordedSteps', (data) => {
      render((data as { recordedSteps?: Step[] }).recordedSteps ?? []);
    });
  })();
}

// ── Send to Claude (MCP) ─────────────────────────────────────────────────────

function getMcpUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ mcpServerUrl: DEFAULT_MCP_URL }, (data) => {
      resolve((data as { mcpServerUrl: string }).mcpServerUrl);
    });
  });
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showMcpToast(nodes: (string | Node)[], durationMs = 6000): void {
  const toast = el('mcp-toast');
  toast.textContent = '';
  toast.append(...nodes);
  toast.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.style.display = 'none'), durationMs);
}

function flowIdChip(id: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'flow-id';
  chip.textContent = id;
  return chip;
}

async function sendToMcp(): Promise<void> {
  if (!currentSteps.length) {
    showMcpToast(['No steps to send. Record a flow first.'], 3000);
    return;
  }

  const button = el<HTMLButtonElement>('btn-send-claude');
  button.disabled = true;
  button.textContent = 'Sending…';

  const id = viewingMode ? viewingMode.id : `flow-${Date.now()}`;
  const name = viewingMode ? viewingMode.name : `Flow ${new Date().toLocaleString()}`;
  const first = startUrl(currentSteps);

  try {
    const res = await fetch(await getMcpUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, timestamp: Date.now(), startUrl: first, steps: currentSteps }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { id: savedId } = (await res.json()) as { id: string };

    const prompt =
      `Call get_flow("${savedId}") now (flowsnap MCP) — ${currentSteps.length}-step recording` +
      `${first ? ` @ ${first}` : ''}. Read the steps, identify what the user did or what broke, then help.`;
    await navigator.clipboard.writeText(prompt).catch(() => undefined);

    showMcpToast(
      ['Flow sent! Prompt copied — paste into Claude.', document.createElement('br'), 'ID: ', flowIdChip(savedId)],
      8000,
    );
  } catch {
    showMcpToast(
      [
        'Could not reach the FlowSnap MCP server.',
        document.createElement('br'),
        'Start it first: ',
        flowIdChip('cd mcp-server && npm start'),
      ],
      8000,
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Send to Claude';
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSteps();
  loadExportOpts();
  void refreshSavedFlowsCount();

  el('btn-send-claude').addEventListener('click', () => void sendToMcp());
  el('btn-export-zip').addEventListener('click', () => promptAndExport('zip'));
  el('btn-export-md').addEventListener('click', () => promptAndExport('md'));
  el('btn-export-json').addEventListener('click', () => promptAndExport('json'));
  el('btn-save-flow').addEventListener('click', promptSaveFlow);

  el('btn-saved-flows').addEventListener('click', () => {
    const panel = el('saved-flows-panel');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) void renderSavedFlowsList();
  });

  el('btn-back-to-live').addEventListener('click', () => {
    viewingMode = null;
    deleteHistory = [];
    loadSteps();
  });

  for (const id of ['opt-images', 'opt-network', 'opt-logs']) {
    el(id).addEventListener('change', () => {
      void chrome.storage.local.set({ exportOptions: getExportOpts() });
    });
  }

  el('btn-clear').addEventListener('click', () => {
    if (viewingMode) {
      // In viewing mode this means "stop viewing", not "wipe the recording".
      viewingMode = null;
      deleteHistory = [];
      loadSteps();
      return;
    }
    void sendToWorker({ type: 'CLEAR_STEPS' });
    chrome.storage.local.set({ recordedSteps: [], recordingActive: false }, () => {
      deleteHistory = [];
      render([]);
    });
  });
});
