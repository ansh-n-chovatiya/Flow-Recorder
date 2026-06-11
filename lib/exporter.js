// FlowSnap — export utilities.
// Loaded in viewer.html BEFORE viewer.js. These top-level function
// declarations are visible to viewer.js in the shared page global scope.
// Do NOT wrap in a module/IIFE.

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
function appendStep(lines, step, n, prevPath, imageRef) {
  lines.push('### ' + n + '. ' + (step.action || step.type || 'Step'));

  const path = urlPath(step.url);
  if (path && path !== prevPath) lines.push('📍 ' + path);

  const el = step.element;
  if (el && isStableSelector(el.cssSelector)) lines.push('`' + el.cssSelector + '`');

  if (step.value) lines.push('↳ value: "' + step.value + '"');

  if (imageRef) lines.push('![' + n + '](' + imageRef + ')');

  lines.push('');
  return path;
}

// Build a Claude-ready Markdown document (screenshots embedded as data URLs).
function exportToMarkdown(steps, title = 'Flow Recording') {
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
    prevPath = appendStep(lines, step, i + 1, prevPath, step.screenshot ? step.screenshot : null);
  });

  return lines.join('\n');
}

// Serialize recorded steps to JSON.
// imageNames (optional): per-step relative image path for the ZIP export — when
// provided, `screenshot` becomes the filename instead of a placeholder string.
function exportToJSON(steps, imageNames) {
  const list = steps || [];
  return JSON.stringify(
    {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      stepCount: list.length,
      steps: list.map((s, i) => ({
        ...s,
        screenshot: imageNames
          ? imageNames[i] || null
          : s.screenshot
          ? '[base64 image data]'
          : null,
      })),
    },
    null,
    2
  );
}

// Build a Claude-ready Markdown doc that references screenshots by FILE PATH
// (for the ZIP export) rather than embedding base64. imageNames[i] is the
// relative path to step i's image, or null if it has no screenshot.
function exportToMarkdownWithRefs(steps, title, imageNames) {
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
    prevPath = appendStep(lines, step, i + 1, prevPath, names[i] || null);
  });

  return lines.join('\n');
}
