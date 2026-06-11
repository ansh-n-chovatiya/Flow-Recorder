// FlowSnap — viewer page logic.
// Loads recorded steps, renders cards, and handles export / delete / clear.
// exportToMarkdown / exportToJSON come from ../lib/exporter.js (loaded first).

let currentSteps = [];

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
  action.className = 'step-action';
  action.textContent = step.action || step.type || 'Step';
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
