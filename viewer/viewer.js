// FlowSnap — viewer page logic.
// Loads recorded steps, renders cards, and handles export / delete / clear.
// exportToMarkdown / exportToJSON come from ../lib/exporter.js (loaded first).

let currentSteps = [];
let _hlCleanup = null; // cleanup fn for any open highlight editor's document listeners

// Escape text for safe insertion into innerHTML contexts.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Append a labelled meta item to a container when the value exists.
function appendMetaItem(container, key, value, asSelector) {
  if (!value) return;
  const item = document.createElement('span');
  item.className = 'meta-item';

  const keyEl = document.createElement('span');
  keyEl.className = 'meta-key';
  keyEl.textContent = key + ':';
  item.appendChild(keyEl);

  const valEl = document.createElement('span');
  if (asSelector) {
    valEl.className = 'selector';
  }
  valEl.textContent = value;
  item.appendChild(valEl);

  container.appendChild(item);
}

// ── Network & log render helpers ─────────────────────────────────────────────

const METHOD_STYLE = {
  GET:     { bg: '#dbeafe', fg: '#1d4ed8' },
  POST:    { bg: '#dcfce7', fg: '#15803d' },
  PUT:     { bg: '#ffedd5', fg: '#c2410c' },
  PATCH:   { bg: '#f3e8ff', fg: '#7e22ce' },
  DELETE:  { bg: '#fee2e2', fg: '#b91c1c' },
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

  // ── summary row ──
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

  // ── expand body ──
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

  expand.appendChild(tabsEl);
  expand.appendChild(reqPanel);
  expand.appendChild(resPanel);
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

// Build and return the DOM for a single step card.
function buildStepCard(step, index) {
  const card = document.createElement('div');
  card.className = 'step';

  const head = document.createElement('div');
  head.className = 'step-head';

  const num = document.createElement('div');
  num.className = 'step-num';
  num.textContent = String(index + 1);
  head.appendChild(num);

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
      persistStep(index, Object.assign({}, step, { action: val }));
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { committed = true; inp.replaceWith(action); }
    });
  });
  head.appendChild(action);

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
    if (meta.childNodes.length) {
      card.appendChild(meta);
    }
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
    value.appendChild(key);
    value.appendChild(chip);
    card.appendChild(value);
  }

  if (step.screenshot) {
    const img = document.createElement('img');
    img.className = 'step-screenshot';
    img.src = step.screenshot;
    img.alt = 'Screenshot for step ' + (index + 1);
    card.appendChild(img);
  }

  // Edit bar: Edit Highlight (when original available) + Replace Image
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

  const del = document.createElement('button');
  del.className = 'delete-step';
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Delete this step';
  del.addEventListener('click', () => deleteStep(index));
  card.appendChild(del);

  return card;
}

// Render the full list of steps (or an empty state).
function render(steps) {
  if (_hlCleanup) { _hlCleanup(); _hlCleanup = null; }
  currentSteps = Array.isArray(steps) ? steps : [];
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
    container.appendChild(buildStepCard(step, i));
  });
}

// Remove a step, persist to storage (source of truth), then re-render.
function deleteStep(index) {
  currentSteps.splice(index, 1);
  const next = currentSteps.slice();
  chrome.storage.local.set({ recordedSteps: next }, () => render(next));
}

// Persist a step update and re-render all cards.
function persistStep(index, updated) {
  currentSteps[index] = updated;
  chrome.storage.local.set({ recordedSteps: currentSteps.slice() }, () => render(currentSteps));
}

// Persist a step update without re-rendering (for in-place edits like notes textarea).
function saveStep(index, updated) {
  currentSteps[index] = updated;
  chrome.storage.local.set({ recordedSteps: currentSteps.slice() });
}

// ── Image editor helpers ──────────────────────────────────────────────────────

function drawArrow(ctx, x1, y1, x2, y2, w) {
  const headLen = Math.max(15, w * 5);
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
      const w = Math.abs(op.x2 - op.x1), h = Math.abs(op.y2 - op.y1);
      ctx.strokeRect(x, y, w, h);
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
      const w = Math.abs(op.x2 - op.x1), h = Math.abs(op.y2 - op.y1);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = op.color;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

// Full canvas-based image editor: pen, rect, ellipse, arrow, highlighter.
// screenshotOriginal (if present) is used as the immutable base so repeated
// edits never compound. The final canvas output replaces step.screenshot.
function buildImageEditor(step, index) {
  const editor = document.createElement('div');
  editor.className = 'img-editor';

  // ── State ─────────────────────────────────────────────────────────────
  let tool      = 'pen';
  let color     = '#FF3B30';
  let lineWidth = 3;
  let history   = [];
  let activeOp  = null;

  // ── Toolbar ───────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'ie-toolbar';

  function makeGroup() {
    const g = document.createElement('div');
    g.className = 'ie-group';
    return g;
  }

  // Tools
  const toolGroup = makeGroup();
  const TOOLS = [
    { id: 'pen',       label: 'Pen',     title: 'Freehand pen' },
    { id: 'rect',      label: 'Rect',    title: 'Rectangle' },
    { id: 'ellipse',   label: 'Ellipse', title: 'Ellipse / circle' },
    { id: 'arrow',     label: 'Arrow',   title: 'Arrow' },
    { id: 'highlight', label: 'Hi-lite', title: 'Highlight (semi-transparent fill)' },
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

  // Colors
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

  // Stroke widths
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

  // Actions
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

  // ── Canvas ────────────────────────────────────────────────────────────
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'ie-canvas-wrap';

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

  // ── Drawing interaction ───────────────────────────────────────────────
  canvas.addEventListener('mousedown', e => {
    e.preventDefault();
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

  // ── Save / Cancel ─────────────────────────────────────────────────────
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

// Trigger a client-side file download from a string payload.
function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

// Trigger a download from an already-built Blob (e.g. the ZIP).
function downloadBlob(filename, blob) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Build and download a ZIP: separate image files + a Markdown + JSON manifest.
// This is the AI-friendly export — Claude reads attached image FILES via
// vision, but cannot see base64 embedded as text in a pasted document.
function exportZip() {
  if (!currentSteps.length) return;

  const encoder = new TextEncoder();
  const files = [];
  const imageNames = [];

  currentSteps.forEach((step, i) => {
    const shot = step.screenshot;
    if (typeof shot === 'string' && shot.startsWith('data:')) {
      const { bytes, ext } = dataUrlToBytes(shot);
      const name = 'images/step-' + pad2(i + 1) + '.' + ext;
      files.push({ name: name, data: bytes });
      imageNames.push(name);
    } else {
      imageNames.push(null);
    }
  });

  const title = 'Flow Recording';
  const md = exportToMarkdownWithRefs(currentSteps, title, imageNames);
  files.push({ name: 'flow.md', data: encoder.encode(md) });

  const json = exportToJSON(currentSteps, imageNames);
  files.push({ name: 'flow.json', data: encoder.encode(json) });

  const blob = createZip(files);
  downloadBlob('flowsnap-flow-' + timestampSlug() + '.zip', blob);
}

// Load steps from background, falling back to storage when empty.
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

document.addEventListener('DOMContentLoaded', () => {
  loadSteps();

  document.getElementById('btn-export-zip').addEventListener('click', exportZip);

  document.getElementById('btn-export-md').addEventListener('click', () => {
    const title = document.title || 'Flow Recording';
    const md = exportToMarkdown(currentSteps, title);
    downloadFile('flowsnap-flow-' + timestampSlug() + '.md', md, 'text/markdown');
  });

  document.getElementById('btn-export-json').addEventListener('click', () => {
    const json = exportToJSON(currentSteps);
    downloadFile('flowsnap-flow-' + timestampSlug() + '.json', json, 'application/json');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_STEPS' });
    chrome.storage.local.set({ recordedSteps: [], recordingActive: false }, () => {
      render([]);
    });
  });
});
