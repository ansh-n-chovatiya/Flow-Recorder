// FlowSnap — export utilities.
// Loaded in viewer.html BEFORE viewer.js. These top-level function
// declarations are visible to viewer.js in the shared page global scope.
// Do NOT wrap in a module/IIFE.

// ── Schema inference & body compaction ───────────────────────────────────────
// Bodies > SCHEMA_THRESHOLD are replaced with an inferred schema so AI exports
// stay token-lean. Viewer keeps the raw body and adds a "Show raw" toggle.

const SCHEMA_THRESHOLD = 1024; // 1 KB

// Infer a compact type string for a single value.
// `siblings` = array of same-key values from a parent array (for enum detection).
function inferType(val, depth, siblings) {
  if (val === null || val === undefined) return 'null';
  const t = typeof val;
  if (t === 'boolean') return 'boolean';
  if (t === 'number')  return Number.isInteger(val) ? 'integer' : 'number';
  if (t === 'string') {
    // Enum detection: if sibling values all fit in ≤5 short unique strings, show as union.
    if (siblings && siblings.length) {
      const uniq = [...new Set(siblings.filter(v => typeof v === 'string' && v.length <= 30))];
      if (uniq.length >= 2 && uniq.length <= 5) return uniq.map(v => JSON.stringify(v)).join(' | ');
    }
    return val.length <= 30 ? JSON.stringify(val) : 'string';
  }
  if (Array.isArray(val)) {
    if (!val.length) return 'Array(0)';
    // Array of objects → recurse with enum-aware schema.
    if (typeof val[0] === 'object' && val[0] !== null && !Array.isArray(val[0]) && depth > 0) {
      return 'Array(' + val.length + ') of ' + inferObjectSchema(val[0], val, depth - 1);
    }
    return 'Array(' + val.length + ') of ' + inferType(val[0], depth - 1, null);
  }
  if (t === 'object') return depth > 0 ? inferObjectSchema(val, null, depth) : '{...}';
  return t;
}

// Infer schema for a single object. `parentArr` provides siblings for enum detection.
function inferObjectSchema(obj, parentArr, depth) {
  if (depth <= 0) return '{...}';
  const entries = Object.entries(obj);
  if (!entries.length) return '{}';
  const shown = entries.slice(0, 25);
  const omitted = entries.length - shown.length;
  const fields = shown.map(([k, v]) => {
    const sibs = parentArr
      ? parentArr.slice(0, 15).map(item => item && item[k]).filter(x => typeof x === 'string')
      : null;
    return '  ' + k + ': ' + inferType(v, depth - 1, sibs);
  });
  if (omitted > 0) fields.push('  // +' + omitted + ' more fields');
  return '{\n' + fields.join(',\n') + '\n}';
}

// Produce the schema string for an already-parsed JSON value.
function buildSchema(parsed) {
  if (Array.isArray(parsed)) {
    if (!parsed.length) return 'Array(0)';
    const first = parsed[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      return 'Array(' + parsed.length + ') of ' + inferObjectSchema(first, parsed, 3);
    }
    return 'Array(' + parsed.length + ') of ' + inferType(first, 2, null);
  }
  return inferType(parsed, 3, null);
}

// Replace large bodies with schema. Returns original string when under threshold
// or when body isn't parseable JSON (falls back to hard truncation).
function compactBody(bodyStr) {
  if (!bodyStr || typeof bodyStr !== 'string') return bodyStr;
  if (bodyStr.length <= SCHEMA_THRESHOLD) return bodyStr;
  const t = bodyStr.trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const schema = buildSchema(JSON.parse(t));
      return '[schema — ' + (bodyStr.length / 1024).toFixed(1) + 'KB raw]\n' + schema;
    } catch (_) {}
  }
  // Non-JSON large body: prefix + size note.
  return t.slice(0, 300) + '\n\n[non-JSON · ' + (bodyStr.length / 1024).toFixed(1) + 'KB · truncated]';
}

// --- Token-lean Markdown ------------------------------------------------------
// The Markdown is the *comprehension* artifact read by an AI: keep only what
// helps understand the flow. Brittle full-path CSS selectors and XPaths are
// noise here (hundreds of tokens/step) and live in flow.json for replay instead.

// A selector worth showing: a short, stable hook the AI can map to source code.
// Long ancestor chains and framework-generated ids (radix, _r_) are excluded.
function isStableSelector(sel) {
  if (!sel || sel.length > 60) return false;
  if (/radix|:r[0-9a-z]*:|_r_/i.test(sel)) return false;
  if (sel.indexOf(' ') !== -1) return false; // descendant chain → brittle
  return sel.charAt(0) === '#' || sel.indexOf('[data-testid') !== -1 || sel.indexOf('[aria-label') !== -1;
}

// Pathname (+ search) of a URL, for compact page-change markers.
function urlPath(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch (e) {
    return url;
  }
}

// Host of the first URL we can parse, shown once in the header.
function flowHost(steps) {
  for (const s of steps || []) {
    if (s && s.url) {
      try { return new URL(s.url).host; } catch (e) { /* keep looking */ }
    }
  }
  return '';
}

// Append one compact step block to `lines`. `prevPath` is the previous step's
// page path; returns this step's path so the caller can track transitions.
function appendStep(lines, step, n, prevPath, imageRef, opts) {
  lines.push('### ' + n + '. ' + (step.action || step.type || 'Step'));

  const path = urlPath(step.url);
  if (path && path !== prevPath) lines.push('📍 ' + path);

  const el = step.element;
  if (el && isStableSelector(el.cssSelector)) lines.push('`' + el.cssSelector + '`');

  if (step.value) lines.push('↳ value: "' + step.value + '"');

  if (step.notes && step.notes.trim()) {
    lines.push('> ' + step.notes.trim().replace(/\n/g, '\n> '));
    lines.push('');
  }

  if (imageRef) lines.push('![' + n + '](' + imageRef + ')');

  // Network calls — compact bodies so the AI doc stays token-lean.
  const net = step.networkCalls;
  if (Array.isArray(net) && net.length && !(opts && opts.network === false)) {
    lines.push('');
    net.forEach(call => {
      const p2 = urlPath(call.url);
      lines.push('`' + (call.method || 'GET') + '` ' + p2 +
        ' → ' + (call.status || 'err') + ' (' + (call.durationMs || 0) + 'ms)');
      if (call.requestBody) {
        const rb = compactBody(call.requestBody).replace(/\n/g, ' ').slice(0, 150);
        lines.push('  ↳ req: `' + rb + '`');
      }
      if (call.responseBody) {
        lines.push('  ↳ res:');
        lines.push('  ```');
        lines.push('  ' + compactBody(call.responseBody).replace(/\n/g, '\n  ').slice(0, 800));
        lines.push('  ```');
      }
    });
  }

  // Console — only errors and warnings (info/log are noise for AI).
  const logs = step.consoleLogs;
  if (Array.isArray(logs) && logs.length && !(opts && opts.logs === false)) {
    const notable = logs.filter(l => l.level === 'error' || l.level === 'warn').slice(0, 5);
    if (notable.length) {
      lines.push('');
      notable.forEach(log => {
        lines.push('⚠ `[' + log.level + ']` ' + (log.args || []).join(' ').slice(0, 200));
      });
    }
  }

  lines.push('');
  return path;
}

// Build a Claude-ready Markdown document (screenshots embedded as data URLs).
function exportToMarkdown(steps, title = 'Flow Recording', opts) {
  const list = steps || [];
  const lines = [];
  const host = flowHost(list);

  lines.push('# ' + title);
  lines.push(
    'Recorded ' + new Date().toLocaleString() + ' · ' + list.length + ' steps' +
    (host ? ' · ' + host : '')
  );
  lines.push('');
  lines.push('> A recorded UI flow. Each step is one user action; 📍 marks a page change.');
  lines.push('');

  let prevPath = '';
  list.forEach((step, i) => {
    const imgRef = (opts && opts.images === false) ? null : (step.screenshot || null);
    prevPath = appendStep(lines, step, i + 1, prevPath, imgRef, opts);
  });

  return lines.join('\n');
}

// Serialize recorded steps to JSON.
// imageNames (optional): per-step relative image path for the ZIP export — when
// provided, `screenshot` becomes the filename instead of a placeholder string.
// opts (optional): { images, network, logs } booleans — false omits that field.
function exportToJSON(steps, imageNames, opts) {
  const list = steps || [];
  return JSON.stringify(
    {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stepCount: list.length,
      steps: list.map((s, i) => {
        const out = { ...s };
        // Screenshot
        if (opts && opts.images === false) {
          out.screenshot = null;
        } else if (imageNames) {
          out.screenshot = imageNames[i] || null;
        } else {
          out.screenshot = s.screenshot ? '[base64 image data]' : null;
        }
        out.screenshotOriginal = undefined;
        // Network calls
        if (opts && opts.network === false) {
          out.networkCalls = undefined;
        } else if (Array.isArray(s.networkCalls)) {
          out.networkCalls = s.networkCalls.map(call => ({
            ...call,
            requestBody:  call.requestBody  ? compactBody(call.requestBody)  : call.requestBody,
            responseBody: call.responseBody ? compactBody(call.responseBody) : call.responseBody,
          }));
        }
        // Console logs
        if (opts && opts.logs === false) {
          out.consoleLogs = undefined;
        }
        return out;
      }),
    },
    null,
    2
  );
}

// Build a Claude-ready Markdown doc that references screenshots by FILE PATH
// (for the ZIP export) rather than embedding base64. imageNames[i] is the
// relative path to step i's image, or null if it has no screenshot.
function exportToMarkdownWithRefs(steps, title, imageNames, opts) {
  const list = steps || [];
  const names = imageNames || [];
  const lines = [];
  const host = flowHost(list);

  lines.push('# ' + (title || 'Flow Recording'));
  lines.push(
    'Recorded ' + new Date().toLocaleString() + ' · ' + list.length + ' steps' +
    (host ? ' · ' + host : '')
  );
  lines.push('');
  lines.push(
    '> Each step is one user action; 📍 marks a page change. Screenshots are the ' +
      '`images/step-NN.*` files — attach them to Claude (vision reads image files, ' +
      'not base64 text). Full selectors/XPath for replay live in `flow.json`.'
  );
  lines.push('');

  let prevPath = '';
  list.forEach((step, i) => {
    const imgRef = (opts && opts.images === false) ? null : (names[i] || null);
    prevPath = appendStep(lines, step, i + 1, prevPath, imgRef, opts);
  });

  return lines.join('\n');
}
