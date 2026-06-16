// FlowSnap — viewer page logic.
// exportToMarkdown / exportToJSON / compactBody come from ../lib/exporter.js.
// createZip / dataUrlToBytes come from ../lib/zip.js.

let currentSteps = [];
let _hlCleanup = null;    // cleanup fn for the open image-editor's doc listeners
let deleteHistory = [];   // [{index, step}] stack for Ctrl+Z undo
let _viewingMode = null;  // null = live recording, {id, name} = saved flow

// ── Utility helpers ───────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function appendMetaItem(container, key, value, asSelector) {
  if (!value) return;
  const item = document.createElement('span');
  item.className = 'meta-item';
  const keyEl = document.createElement('span');
  keyEl.className = 'meta-key';
  keyEl.textContent = key + ':';
  item.appendChild(keyEl);
  const valEl = document.createElement('span');
  if (asSelector) valEl.className = 'selector';
  valEl.textContent = value;
  item.appendChild(valEl);
  container.appendChild(item);
}

// ── Network & log render helpers ──────────────────────────────────────────────

const METHOD_STYLE = {
  GET:    { bg: '#dbeafe', fg: '#1d4ed8' },
  POST:   { bg: '#dcfce7', fg: '#15803d' },
  PUT:    { bg: '#ffedd5', fg: '#c2410c' },
  PATCH:  { bg: '#f3e8ff', fg: '#7e22ce' },
  DELETE: { bg: '#fee2e2', fg: '#b91c1c' },
};
const METHOD_DEFAULT = { bg: '#f1f5f9', fg: '#475569' };

function methodStyle(m) { return METHOD_STYLE[(m || '').toUpperCase()] || METHOD_DEFAULT; }

function statusStyle(code) {
  if (!code)       return { bg: '#fee2e2', fg: '#b91c1c' };
  if (code >= 500) return { bg: '#fee2e2', fg: '#b91c1c' };
  if (code >= 400) return { bg: '#ffedd5', fg: '#c2410c' };
  if (code >= 300) return { bg: '#dbeafe', fg: '#1d4ed8' };
  return               { bg: '#dcfce7', fg: '#15803d' };
}

const LOG_STYLE = {
  error: { bg: '#fee2e2', fg: '#b91c1c', border: '#e53935' },
  warn:  { bg: '#fff7ed', fg: '#c2410c', border: '#fb8c00' },
  info:  { bg: '#eff6ff', fg: '#1d4ed8', border: '#1e88e5' },
  debug: { bg: '#faf5ff', fg: '#7e22ce', border: '#9c27b0' },
  log:   { bg: '#f8fafc', fg: '#475569', border: '#94a3b8' },
};

function logStyle(lvl) { return LOG_STYLE[lvl] || LOG_STYLE.log; }

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search.length > 1 ? u.search.slice(0, 40) + (u.search.length > 41 ? '…' : '') : '');
    return u.hostname + path;
  } catch (_) {
    return url.length > 70 ? url.slice(0, 70) + '…' : url;
  }
}

function tryPretty(str) {
  if (!str || typeof str !== 'string') return str;
  const t = str.trim();
  if (t[0] !== '{' && t[0] !== '[') return str;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch (_) { return str; }
}

function makeHeadersTable(headers) {
  if (!headers || !Object.keys(headers).length) return null;
  const t = document.createElement('table');
  t.className = 'nc-htable';
  Object.entries(headers).forEach(([k, v]) => {
    const tr = document.createElement('tr');
    const k1 = document.createElement('td'); k1.className = 'nc-hk'; k1.textContent = k;
    const v1 = document.createElement('td'); v1.className = 'nc-hv'; v1.textContent = v;
    tr.appendChild(k1); tr.appendChild(v1); t.appendChild(tr);
  });
  return t;
}

function makePanel(id, headers, body) {
  const p = document.createElement('div');
  p.className = 'nc-panel';
  p.dataset.id = id;
  const hasHeaders = headers && Object.keys(headers).length;
  const hasBody = !!body;
  if (!hasHeaders && !hasBody) {
    const e = document.createElement('span'); e.className = 'nc-empty';
    e.textContent = 'No data'; p.appendChild(e); return p;
  }
  if (hasHeaders) {
    const lbl = document.createElement('div'); lbl.className = 'nc-slabel'; lbl.textContent = 'Headers';
    p.appendChild(lbl); p.appendChild(makeHeadersTable(headers));
  }
  if (hasBody) {
    const lbl = document.createElement('div'); lbl.className = 'nc-slabel'; lbl.textContent = 'Body';
    p.appendChild(lbl);
    const compact = compactBody(body);
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
      p.appendChild(toggle);
    }
    p.appendChild(pre);
  }
  return p;
}

function buildNetworkCard(call) {
  const ms = methodStyle(call.method);
  const ss = statusStyle(call.status);
  const card = document.createElement('div');
  card.className = 'nc-card';
  const row = document.createElement('div');
  row.className = 'nc-row';
  const mBadge = document.createElement('span');
  mBadge.className = 'nc-method';
  mBadge.textContent = (call.method || 'GET').toUpperCase();
  mBadge.style.cssText = `background:${ms.bg};color:${ms.fg}`;
  const urlEl = document.createElement('span');
  urlEl.className = 'nc-url';
  urlEl.textContent = shortUrl(call.url || '');
  urlEl.title = call.url || '';
  const sBadge = document.createElement('span');
  sBadge.className = 'nc-status';
  sBadge.textContent = call.status || 'ERR';
  sBadge.style.cssText = `background:${ss.bg};color:${ss.fg}`;
  const dur = document.createElement('span');
  dur.className = 'nc-dur';
  dur.textContent = (call.durationMs || 0) + 'ms';
  const caret = document.createElement('span');
  caret.className = 'nc-caret';
  caret.textContent = '›';
  row.appendChild(mBadge); row.appendChild(urlEl);
  row.appendChild(sBadge); row.appendChild(dur); row.appendChild(caret);
  card.appendChild(row);
  const expand = document.createElement('div');
  expand.className = 'nc-expand';
  expand.style.display = 'none';
  const tabsEl = document.createElement('div');
  tabsEl.className = 'nc-tabs';
  const reqTab = document.createElement('button'); reqTab.className = 'nc-tab'; reqTab.textContent = 'Request'; reqTab.dataset.id = 'req';
  const resTab = document.createElement('button'); resTab.className = 'nc-tab'; resTab.textContent = 'Response'; resTab.dataset.id = 'res';
  tabsEl.appendChild(reqTab); tabsEl.appendChild(resTab);
  const reqPanel = makePanel('req', call.requestHeaders, call.requestBody);
  const resPanel = makePanel('res', call.responseHeaders, call.responseBody);
  function activate(id) {
    [reqTab, resTab].forEach(t => t.classList.toggle('active', t.dataset.id === id));
    [reqPanel, resPanel].forEach(p => p.classList.toggle('active', p.dataset.id === id));
  }
  activate('res');
  tabsEl.addEventListener('click', e => { const t = e.target.closest('.nc-tab'); if (t) activate(t.dataset.id); });
  expand.appendChild(tabsEl); expand.appendChild(reqPanel); expand.appendChild(resPanel);
  card.appendChild(expand);
  let open = false;
  row.addEventListener('click', () => {
    open = !open;
    expand.style.display = open ? 'block' : 'none';
    caret.style.transform = open ? 'rotate(90deg)' : '';
  });
  return card;
}

function buildLogRow(log) {
  const s = logStyle(log.level);
  const row = document.createElement('div');
  row.className = 'cl-row';
  row.style.borderLeftColor = s.border;
  const badge = document.createElement('span');
  badge.className = 'cl-badge';
  badge.textContent = log.level || 'log';
  badge.style.cssText = `background:${s.bg};color:${s.fg}`;
  const msg = document.createElement('span');
  msg.className = 'cl-msg';
  msg.textContent = (log.args || []).join(' ');
  const ts = document.createElement('span');
  ts.className = 'cl-ts';
  ts.textContent = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
  row.appendChild(badge); row.appendChild(msg); row.appendChild(ts);
  return row;
}

// ── Step card ─────────────────────────────────────────────────────────────────

// Format millisecond delta as "+1.2s" or "+1m 3s".
function formatDelta(ms) {
  if (ms < 0) return '';
  if (ms < 60000) return '+' + (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return '+' + m + 'm ' + s + 's';
}

// Build and return the DOM for a single step card.
// prevStep is used to calculate the timing delta shown on the card.
function buildStepCard(step, index, prevStep) {
  const card = document.createElement('div');
  card.className = 'step';
  card.tabIndex = 0;            // keyboard-focusable for Del/E shortcuts
  card.dataset.index = index;

  const head = document.createElement('div');
  head.className = 'step-head';

  const num = document.createElement('div');
  num.className = 'step-num';
  num.textContent = String(index + 1);
  head.appendChild(num);

  // Step type badge
  const typeBadge = document.createElement('span');
  typeBadge.className = 'step-type-badge ' + (step.type || 'click');
  typeBadge.textContent = step.type || 'click';
  head.appendChild(typeBadge);

  // Editable action title
  const action = document.createElement('div');
  action.className = 'step-action editable';
  action.textContent = step.action || step.type || 'Step';
  action.title = 'Click to edit';
  action.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'step-edit-input';
    inp.value = step.action || step.type || '';
    action.replaceWith(inp);
    inp.focus(); inp.select();
    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      const val = inp.value.trim() || action.textContent;
      step.action = val;
      inp.replaceWith(action);
      action.textContent = val;
      saveStep(index, Object.assign({}, step, { action: val }));
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { committed = true; inp.replaceWith(action); }
    });
  });
  head.appendChild(action);

  // Timing delta from the previous step
  if (prevStep && prevStep.timestamp && step.timestamp) {
    const delta = step.timestamp - prevStep.timestamp;
    if (delta >= 0) {
      const timing = document.createElement('span');
      timing.className = 'step-timing';
      timing.title = 'Time since previous step';
      timing.textContent = formatDelta(delta);
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

  const el = step.element;
  if (el) {
    const meta = document.createElement('div');
    meta.className = 'step-meta';
    appendMetaItem(meta, 'Tag', el.tag);
    appendMetaItem(meta, 'Label', el.label || el.text);
    appendMetaItem(meta, 'Role', el.role);
    appendMetaItem(meta, 'Aria', el.ariaLabel);
    appendMetaItem(meta, 'CSS', el.cssSelector, true);
    appendMetaItem(meta, 'XPath', el.xpath, true);
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
    value.appendChild(key); value.appendChild(chip);
    card.appendChild(value);
  }

  // Screenshot — lazy-loaded via IntersectionObserver
  if (step.screenshot) {
    const img = document.createElement('img');
    img.className = 'step-screenshot';
    img.alt = 'Screenshot for step ' + (index + 1);
    if ('IntersectionObserver' in window) {
      img.dataset.src = step.screenshot;
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
      const obs = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            e.target.src = e.target.dataset.src;
            obs.unobserve(e.target);
          }
        });
      }, { rootMargin: '300px' });
      obs.observe(img);
    } else {
      img.src = step.screenshot;
    }
    card.appendChild(img);
  }

  // Edit bar
  const editBar = document.createElement('div');
  editBar.className = 'step-edit-bar';

  if (step.screenshot || step.screenshotOriginal) {
    const editImgBtn = document.createElement('button');
    editImgBtn.className = 'edit-bar-btn';
    editImgBtn.textContent = 'Edit Image';
    editImgBtn.addEventListener('click', () => {
      const existing = card.querySelector('.img-editor');
      if (existing) {
        if (_hlCleanup) { _hlCleanup(); _hlCleanup = null; }
        existing.remove();
        return;
      }
      const editorEl = buildImageEditor(step, index);
      editBar.insertAdjacentElement('afterend', editorEl);
    });
    editBar.appendChild(editImgBtn);
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
      const file = fileInput.files[0];
      document.body.removeChild(fileInput);
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        persistStep(index, Object.assign({}, step, {
          screenshot: e.target.result,
          screenshotOriginal: null,
          highlightBox: null,
        }));
      };
      reader.readAsDataURL(file);
    });
    fileInput.click();
  });
  editBar.appendChild(replaceBtn);
  card.appendChild(editBar);

  // Network calls
  const net = step.networkCalls;
  if (Array.isArray(net) && net.length) {
    const det = document.createElement('details');
    det.className = 'step-details';
    const sum = document.createElement('summary');
    sum.innerHTML = 'Network calls <span class="detail-count">' + net.length + '</span><span class="detail-chevron">›</span>';
    det.appendChild(sum);
    const inner = document.createElement('div');
    inner.className = 'step-details-inner';
    net.forEach(call => inner.appendChild(buildNetworkCard(call)));
    det.appendChild(inner);
    card.appendChild(det);
  }

  // Console logs
  const logs = step.consoleLogs;
  if (Array.isArray(logs) && logs.length) {
    const det = document.createElement('details');
    det.className = 'step-details';
    const sum = document.createElement('summary');
    sum.innerHTML = 'Console logs <span class="detail-count">' + logs.length + '</span><span class="detail-chevron">›</span>';
    det.appendChild(sum);
    const rows = document.createElement('div');
    rows.className = 'cl-rows';
    logs.forEach(log => rows.appendChild(buildLogRow(log)));
    det.appendChild(rows);
    card.appendChild(det);
  }

  // Notes
  const notesEl = document.createElement('textarea');
  notesEl.className = 'step-notes';
  notesEl.placeholder = 'Add notes…';
  notesEl.rows = step.notes ? 3 : 2;
  notesEl.value = step.notes || '';
  notesEl.addEventListener('blur', () => {
    const val = notesEl.value;
    if (val !== (step.notes || '')) {
      step.notes = val;
      saveStep(index, Object.assign({}, step, { notes: val }));
    }
  });
  card.appendChild(notesEl);

  // Delete button
  const del = document.createElement('button');
  del.className = 'delete-step';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Delete this step';
  del.addEventListener('click', () => deleteStep(index));
  card.appendChild(del);

  return card;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(steps) {
  if (_hlCleanup) { _hlCleanup(); _hlCleanup = null; }
  currentSteps = Array.isArray(steps) ? steps : [];

  // Viewing-mode banner
  const banner = document.getElementById('viewing-banner');
  const nameEl = document.getElementById('viewing-name');
  if (_viewingMode) {
    nameEl.textContent = _viewingMode.name;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }

  const container = document.getElementById('steps-container');
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

// ── Step persistence helpers ──────────────────────────────────────────────────

function deleteStep(index) {
  const removed = currentSteps.splice(index, 1)[0];
  deleteHistory.push({ index, step: removed });
  const next = currentSteps.slice();
  // Only write back to recordedSteps when viewing live recording
  if (!_viewingMode) {
    chrome.storage.local.set({ recordedSteps: next }, () => render(next));
  } else {
    render(next);
  }
}

function undoDelete() {
  if (!deleteHistory.length) return;
  const { index, step } = deleteHistory.pop();
  const restored = currentSteps.slice();
  restored.splice(index, 0, step);
  if (!_viewingMode) {
    chrome.storage.local.set({ recordedSteps: restored }, () => render(restored));
  } else {
    render(restored);
  }
}

// Persist a structural step change and re-render.
function persistStep(index, updated) {
  currentSteps[index] = updated;
  const next = currentSteps.slice();
  if (!_viewingMode) {
    chrome.storage.local.set({ recordedSteps: next }, () => render(next));
  } else {
    render(next);
  }
}

// Persist a step update without re-rendering (lightweight: notes, inline title).
function saveStep(index, updated) {
  currentSteps[index] = updated;
  if (!_viewingMode) {
    chrome.storage.local.set({ recordedSteps: currentSteps.slice() });
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Don't fire when typing in an input / textarea / editable element.
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

  // Del → delete focused step card (Backspace omitted: muscle-memory "back")
  if (e.key === 'Delete') {
    const card = document.activeElement && document.activeElement.closest('.step[data-index]');
    if (card) {
      e.preventDefault();
      deleteStep(Number(card.dataset.index));
    }
    return;
  }

  // Ctrl+Z → undo last delete
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undoDelete();
    return;
  }

  // E → open/close image editor for focused step (the Edit Image button, not Replace)
  if (e.key === 'e' || e.key === 'E') {
    const card = document.activeElement && document.activeElement.closest('.step[data-index]');
    if (card) {
      e.preventDefault();
      // Find the "Edit Image" button specifically — first edit-bar-btn is "Replace
      // Image" when the step has no screenshot, so match by text content.
      const editBtns = card.querySelectorAll('.edit-bar-btn');
      const editImgBtn = Array.from(editBtns).find(b => b.textContent.trim() === 'Edit Image');
      if (editImgBtn) editImgBtn.click();
    }
  }
});

// ── Image editor ──────────────────────────────────────────────────────────────

function drawArrow(ctx, x1, y1, x2, y2, w) {
  const headLen = Math.max(15, w * 5);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function renderOp(ctx, op) {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.lineWidth = op.width || 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (op.tool) {
    case 'pen': {
      const pts = op.points;
      if (!pts || pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      break;
    }
    case 'rect': {
      const x = Math.min(op.x1, op.x2), y = Math.min(op.y1, op.y2);
      ctx.strokeRect(x, y, Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
      break;
    }
    case 'ellipse': {
      const cx = (op.x1 + op.x2) / 2, cy = (op.y1 + op.y2) / 2;
      const rx = Math.abs(op.x2 - op.x1) / 2, ry = Math.abs(op.y2 - op.y1) / 2;
      if (!rx || !ry) break;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arrow':
      drawArrow(ctx, op.x1, op.y1, op.x2, op.y2, op.width || 2);
      break;
    case 'highlight': {
      const x = Math.min(op.x1, op.x2), y = Math.min(op.y1, op.y2);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = op.color;
      ctx.fillRect(x, y, Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
      ctx.restore();
      break;
    }
    case 'blur': {
      // Pixelate the region to obscure PII. Reads current canvas state, scales
      // it down then back up with smoothing disabled for a mosaic effect.
      const x = Math.min(op.x1, op.x2), y = Math.min(op.y1, op.y2);
      const w = Math.abs(op.x2 - op.x1), h = Math.abs(op.y2 - op.y1);
      if (w < 2 || h < 2) break;
      const blockSize = 12;
      const pw = Math.max(1, Math.round(w / blockSize));
      const ph = Math.max(1, Math.round(h / blockSize));
      const temp = document.createElement('canvas');
      temp.width = pw; temp.height = ph;
      const tc = temp.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.drawImage(ctx.canvas, x, y, w, h, 0, 0, pw, ph);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(temp, 0, 0, pw, ph, x, y, w, h);
      ctx.restore();
      break;
    }
    case 'text': {
      ctx.save();
      ctx.fillStyle = op.color;
      ctx.font = 'bold ' + (op.fontSize || 18) + 'px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 3;
      ctx.fillText(op.text, op.x, op.y);
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

// Full canvas-based image editor: pen, rect, ellipse, arrow, highlight,
// blur (pixelate), and text label tools.
function buildImageEditor(step, index) {
  const editor = document.createElement('div');
  editor.className = 'img-editor';

  // ── State ──────────────────────────────────────────────────────────────
  let tool      = 'pen';
  let color     = '#FF3B30';
  let lineWidth = 3;
  let history   = [];
  let activeOp  = null;

  // ── Toolbar ────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'ie-toolbar';

  function makeGroup() {
    const g = document.createElement('div');
    g.className = 'ie-group';
    return g;
  }

  const toolGroup = makeGroup();
  const TOOLS = [
    { id: 'pen',       label: 'Pen',     title: 'Freehand pen' },
    { id: 'rect',      label: 'Rect',    title: 'Rectangle' },
    { id: 'ellipse',   label: 'Ellipse', title: 'Ellipse / circle' },
    { id: 'arrow',     label: 'Arrow',   title: 'Arrow' },
    { id: 'highlight', label: 'Hi-lite', title: 'Highlight (semi-transparent fill)' },
    { id: 'blur',      label: 'Blur',    title: 'Pixelate region (hide PII)' },
    { id: 'text',      label: 'Text',    title: 'Add text label (click to place)' },
  ];
  const toolBtns = {};
  TOOLS.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'ie-btn' + (t.id === tool ? ' active' : '');
    btn.textContent = t.label;
    btn.title = t.title;
    btn.addEventListener('click', () => {
      tool = t.id;
      Object.values(toolBtns).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    toolBtns[t.id] = btn;
    toolGroup.appendChild(btn);
  });

  const colorGroup = makeGroup();
  const COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#000000', '#FFFFFF'];
  const colorBtns = {};
  COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'ie-color' + (c === color ? ' active' : '');
    btn.style.background = c;
    btn.title = c;
    btn.addEventListener('click', () => {
      color = c;
      Object.values(colorBtns).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    colorBtns[c] = btn;
    colorGroup.appendChild(btn);
  });

  const widthGroup = makeGroup();
  const WIDTHS = [{ v: 2, label: 'S' }, { v: 4, label: 'M' }, { v: 8, label: 'L' }];
  const widthBtns = {};
  WIDTHS.forEach(w => {
    const btn = document.createElement('button');
    btn.className = 'ie-btn' + (w.v === lineWidth ? ' active' : '');
    btn.textContent = w.label;
    btn.title = w.v + 'px stroke';
    btn.addEventListener('click', () => {
      lineWidth = w.v;
      Object.values(widthBtns).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    widthBtns[w.v] = btn;
    widthGroup.appendChild(btn);
  });

  const actionGroup = makeGroup();
  actionGroup.className += ' ie-actions';

  const undoBtn = document.createElement('button');
  undoBtn.className = 'ie-btn';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', () => { if (history.length) { history.pop(); redraw(); } });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'ie-btn ie-save';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ie-btn ie-cancel';
  cancelBtn.textContent = 'Cancel';

  actionGroup.appendChild(undoBtn);
  actionGroup.appendChild(saveBtn);
  actionGroup.appendChild(cancelBtn);

  toolbar.appendChild(toolGroup);
  toolbar.appendChild(colorGroup);
  toolbar.appendChild(widthGroup);
  toolbar.appendChild(actionGroup);

  // ── Canvas ─────────────────────────────────────────────────────────────
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'ie-canvas-wrap';
  canvasWrap.style.position = 'relative'; // required for text-input overlay

  const canvas = document.createElement('canvas');
  canvas.className = 'ie-canvas';
  canvasWrap.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  const baseImg = new Image();
  baseImg.src = step.screenshotOriginal || step.screenshot || '';

  baseImg.onload = () => {
    canvas.width  = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    redraw();
  };

  function redraw() {
    if (!canvas.width) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (baseImg.complete && baseImg.naturalWidth) ctx.drawImage(baseImg, 0, 0);
    history.forEach(op => renderOp(ctx, op));
    if (activeOp) renderOp(ctx, activeOp);
  }

  function canvasXY(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width  / r.width),
      y: (e.clientY - r.top)  * (canvas.height / r.height),
    };
  }

  // ── Text tool: floating input overlay ─────────────────────────────────
  function handleTextClick(e) {
    e.preventDefault();
    const p = canvasXY(e);
    const wr = canvasWrap.getBoundingClientRect();
    const r  = canvas.getBoundingClientRect();
    const scale = r.height / canvas.height;

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'ie-text-input';
    textInput.style.left  = (e.clientX - wr.left) + 'px';
    textInput.style.top   = (e.clientY - wr.top)  + 'px';
    textInput.style.color = color;
    textInput.style.fontSize = Math.round(18 * scale) + 'px';
    canvasWrap.appendChild(textInput);
    textInput.focus();

    let committed = false;
    function commitText() {
      if (committed) return;
      committed = true;
      const text = textInput.value.trim();
      if (textInput.parentNode) canvasWrap.removeChild(textInput);
      if (text) {
        history.push({ tool: 'text', color, text, x: p.x, y: p.y, fontSize: 18 });
        redraw();
      }
    }
    textInput.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  { ev.preventDefault(); commitText(); }
      if (ev.key === 'Escape') { committed = true; if (textInput.parentNode) canvasWrap.removeChild(textInput); }
    });
    textInput.addEventListener('blur', commitText);
  }

  // ── Drawing interaction ────────────────────────────────────────────────
  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    if (tool === 'text') { handleTextClick(e); return; }
    const p = canvasXY(e);
    activeOp = tool === 'pen'
      ? { tool, color, width: lineWidth, points: [p] }
      : { tool, color, width: lineWidth, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  });

  function onMove(e) {
    if (!activeOp) return;
    const p = canvasXY(e);
    if (activeOp.tool === 'pen') activeOp.points.push(p);
    else { activeOp.x2 = p.x; activeOp.y2 = p.y; }
    redraw();
  }

  function onUp(e) {
    if (!activeOp) return;
    const p = canvasXY(e);
    if (activeOp.tool === 'pen') {
      activeOp.points.push(p);
      if (activeOp.points.length >= 2) history.push(activeOp);
    } else {
      activeOp.x2 = p.x; activeOp.y2 = p.y;
      history.push(activeOp);
    }
    activeOp = null;
    redraw();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  function cleanup() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  _hlCleanup = cleanup;

  // ── Save / Cancel ──────────────────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    activeOp = null;
    redraw();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    cleanup();
    _hlCleanup = null;
    persistStep(index, Object.assign({}, step, { screenshot: dataUrl }));
  });

  cancelBtn.addEventListener('click', () => {
    cleanup();
    _hlCleanup = null;
    editor.remove();
  });

  editor.appendChild(toolbar);
  editor.appendChild(canvasWrap);

  return editor;
}

// ── Export helpers ────────────────────────────────────────────────────────────

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

function downloadBlob(filename, blob) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

function pad2(n) { return String(n).padStart(2, '0'); }

// ── Export opts ───────────────────────────────────────────────────────────────

function getExportOpts() {
  return {
    images:  document.getElementById('opt-images').checked,
    network: document.getElementById('opt-network').checked,
    logs:    document.getElementById('opt-logs').checked,
  };
}

function loadExportOpts() {
  chrome.storage.local.get('exportOptions', ({ exportOptions }) => {
    const opts = exportOptions || { images: true, network: true, logs: true };
    document.getElementById('opt-images').checked  = opts.images  !== false;
    document.getElementById('opt-network').checked = opts.network !== false;
    document.getElementById('opt-logs').checked    = opts.logs    !== false;
  });
}

// ── Export implementations ────────────────────────────────────────────────────

async function doExportZip(name, opts) {
  if (!currentSteps.length) return;
  const encoder = new TextEncoder();
  const files = [];
  const imageNames = [];

  currentSteps.forEach((step, i) => {
    const shot = step.screenshot;
    if (opts.images !== false && typeof shot === 'string' && shot.startsWith('data:')) {
      const { bytes, ext } = dataUrlToBytes(shot);
      const imgName = 'images/step-' + pad2(i + 1) + '.' + ext;
      files.push({ name: imgName, data: bytes });
      imageNames.push(imgName);
    } else {
      imageNames.push(null);
    }
  });

  const title = 'Flow Recording';
  const md = exportToMarkdownWithRefs(currentSteps, title, imageNames, opts);
  files.push({ name: 'flow.md',   data: encoder.encode(md) });

  const json = exportToJSON(currentSteps, imageNames, opts);
  files.push({ name: 'flow.json', data: encoder.encode(json) });

  // createZip is async (deflates text files via CompressionStream)
  const blob = await createZip(files);
  downloadBlob(name + '.zip', blob);
}

function doExportMd(name, opts) {
  const title = document.title || 'Flow Recording';
  const md = exportToMarkdown(currentSteps, title, opts);
  downloadFile(name + '.md', md, 'text/markdown');
}

function doExportJson(name, opts) {
  const json = exportToJSON(currentSteps, undefined, opts);
  downloadFile(name + '.json', json, 'application/json');
}

// ── Filename modal ────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '').trim().replace(/^\.+|\.+$/g, '') || 'flowsnap-flow';
}

function defaultFilename() {
  const d = new Date();
  return 'flowsnap-flow-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

let _modalCleanup = null;

function promptAndExport(type) {
  if (!currentSteps.length) return;
  if (_modalCleanup) { _modalCleanup(); _modalCleanup = null; }

  const modal     = document.getElementById('filename-modal');
  const input     = document.getElementById('filename-input');
  const extEl     = document.getElementById('filename-ext');
  const confirmBtn = document.getElementById('filename-confirm');
  const cancelBtn  = document.getElementById('filename-cancel');

  const ext = type === 'zip' ? '.zip' : type === 'md' ? '.md' : '.json';
  input.value = defaultFilename();
  extEl.textContent = ext;
  modal.style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 0);

  function hide() {
    modal.style.display = 'none';
    if (_modalCleanup) { _modalCleanup(); _modalCleanup = null; }
  }

  function onConfirm() {
    const name = sanitizeFilename(input.value);
    hide();
    const opts = getExportOpts();
    if (type === 'zip')     doExportZip(name, opts);
    else if (type === 'md') doExportMd(name, opts);
    else                    doExportJson(name, opts);
  }

  function onKey(e) {
    if (e.key === 'Enter')  { e.preventDefault(); onConfirm(); }
    if (e.key === 'Escape') hide();
  }

  confirmBtn.addEventListener('click', onConfirm);
  cancelBtn.addEventListener('click', hide);
  input.addEventListener('keydown', onKey);
  modal.addEventListener('click', e => { if (e.target === modal) hide(); });

  _modalCleanup = () => {
    confirmBtn.removeEventListener('click', onConfirm);
    cancelBtn.removeEventListener('click', hide);
    input.removeEventListener('keydown', onKey);
  };
}

// ── Named session save / load ─────────────────────────────────────────────────

function savedFlowKey(id) { return 'savedFlow_' + id; }

function loadSavedFlowsMeta(cb) {
  chrome.storage.local.get('savedFlowsMeta', ({ savedFlowsMeta }) => {
    cb(Array.isArray(savedFlowsMeta) ? savedFlowsMeta : []);
  });
}

function refreshSavedFlowsCount() {
  loadSavedFlowsMeta(meta => {
    document.getElementById('saved-flows-count').textContent = String(meta.length);
  });
}

function renderSavedFlowsList() {
  loadSavedFlowsMeta(meta => {
    const list = document.getElementById('saved-flows-list');
    list.textContent = '';
    if (!meta.length) {
      const empty = document.createElement('div');
      empty.className = 'saved-flows-empty';
      empty.textContent = 'No saved flows yet. Click "Save Flow" to archive the current recording.';
      list.appendChild(empty);
      return;
    }
    meta.forEach(m => {
      const item = document.createElement('div');
      item.className = 'saved-flow-item';

      const info = document.createElement('div');
      info.className = 'saved-flow-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'saved-flow-name';
      nameEl.textContent = m.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'saved-flow-meta';
      const d = new Date(m.createdAt);
      metaEl.textContent = m.stepCount + ' steps · ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
      info.appendChild(nameEl);
      info.appendChild(metaEl);

      const actions = document.createElement('div');
      actions.className = 'saved-flow-actions';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn-load-flow';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => {
        chrome.storage.local.get(savedFlowKey(m.id), (data) => {
          const steps = data[savedFlowKey(m.id)] || [];
          _viewingMode = { id: m.id, name: m.name };
          deleteHistory = [];
          document.getElementById('saved-flows-panel').style.display = 'none';
          render(steps);
        });
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete-flow';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        loadSavedFlowsMeta(existing => {
          const updated = existing.filter(x => x.id !== m.id);
          const toRemove = {};
          toRemove[savedFlowKey(m.id)] = null;
          toRemove.savedFlowsMeta = updated;
          chrome.storage.local.set(toRemove, () => {
            refreshSavedFlowsCount();
            renderSavedFlowsList();
          });
        });
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      item.appendChild(info);
      item.appendChild(actions);
      list.appendChild(item);
    });
  });
}

function promptSaveFlow() {
  if (!currentSteps.length) return;

  const modal     = document.getElementById('save-flow-modal');
  const input     = document.getElementById('save-flow-input');
  const confirmBtn = document.getElementById('save-flow-confirm');
  const cancelBtn  = document.getElementById('save-flow-cancel');

  const d = new Date();
  input.value = 'Recording – ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  modal.style.display = 'flex';
  setTimeout(() => { input.focus(); input.select(); }, 0);

  function hide() { modal.style.display = 'none'; cleanup(); }

  function doSave() {
    const name = input.value.trim() || 'Untitled Flow';
    hide();
    const id = 'flow_' + Date.now();
    const meta = { id, name, createdAt: Date.now(), stepCount: currentSteps.length };
    loadSavedFlowsMeta(existing => {
      const key = savedFlowKey(id);
      const update = { savedFlowsMeta: [...existing, meta] };
      update[key] = currentSteps.slice();
      chrome.storage.local.set(update, () => {
        refreshSavedFlowsCount();
      });
    });
  }

  function onKey(e) {
    if (e.key === 'Enter')  { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') hide();
  }

  confirmBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', hide);
  input.addEventListener('keydown', onKey);
  modal.addEventListener('click', e => { if (e.target === modal) hide(); });

  function cleanup() {
    confirmBtn.removeEventListener('click', doSave);
    cancelBtn.removeEventListener('click', hide);
    input.removeEventListener('keydown', onKey);
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

function loadSteps() {
  chrome.runtime.sendMessage({ type: 'GET_STEPS' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.steps || !response.steps.length) {
      chrome.storage.local.get('recordedSteps', (data) => {
        render((data && data.recordedSteps) || []);
      });
      return;
    }
    render(response.steps);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadSteps();
  loadExportOpts();
  refreshSavedFlowsCount();

  document.getElementById('btn-export-zip').addEventListener('click',  () => promptAndExport('zip'));
  document.getElementById('btn-export-md').addEventListener('click',   () => promptAndExport('md'));
  document.getElementById('btn-export-json').addEventListener('click', () => promptAndExport('json'));

  document.getElementById('btn-save-flow').addEventListener('click', promptSaveFlow);

  document.getElementById('btn-saved-flows').addEventListener('click', () => {
    const panel = document.getElementById('saved-flows-panel');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) renderSavedFlowsList();
  });

  // "Back to recording" banner button
  document.getElementById('btn-back-to-live').addEventListener('click', () => {
    _viewingMode = null;
    deleteHistory = [];
    loadSteps();
  });

  ['opt-images', 'opt-network', 'opt-logs'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      chrome.storage.local.set({ exportOptions: getExportOpts() });
    });
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (_viewingMode) {
      // In viewing mode, clear only the current view — don't wipe live recording.
      _viewingMode = null;
      deleteHistory = [];
      loadSteps();
      return;
    }
    chrome.runtime.sendMessage({ type: 'CLEAR_STEPS' });
    chrome.storage.local.set({ recordedSteps: [], recordingActive: false }, () => {
      deleteHistory = [];
      render([]);
    });
  });
});
