// FlowSnap — content script.
// selector.js is loaded before this file, so generateSelector() and
// generateXPath() are available in this scope.

let isRecording = false;
let isPaused = false;

// Buffers for logs/network captured by page-injector.js (MAIN world).
let pendingLogs = [];
let pendingNetworkCalls = [];

// postMessage is the reliable cross-world channel (CustomEvent.detail is null
// when read across the MAIN/ISOLATED boundary in Chrome MV3).
window.addEventListener('message', (event) => {
  if (!isRecording || isPaused) return;
  const d = event.data;
  if (!d || d.__flowsnap_source__ !== 'page-injector') return;
  if (d.kind === 'log') {
    pendingLogs.push({ level: d.level, args: d.args, timestamp: d.timestamp });
  } else if (d.kind === 'network') {
    pendingNetworkCalls.push({
      method: d.method,
      url: d.url,
      requestHeaders: d.requestHeaders,
      requestBody: d.requestBody,
      status: d.status,
      responseHeaders: d.responseHeaders,
      responseBody: d.responseBody,
      durationMs: d.durationMs,
      timestamp: d.timestamp,
    });
  }
});

// --- Messaging from background/popup -----------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  if (message.type === 'START_RECORDING') {
    isRecording = true;
    isPaused = false;
    showRecordingIndicator(false);
  } else if (message.type === 'STOP_RECORDING') {
    isRecording = false;
    isPaused = false;
    hideRecordingIndicator();
    pendingLogs = [];
    pendingNetworkCalls = [];
  } else if (message.type === 'PAUSE_RECORDING') {
    isPaused = true;
    pendingLogs = [];
    pendingNetworkCalls = [];
    showRecordingIndicator(true); // paused state shows different colour
  } else if (message.type === 'RESUME_RECORDING') {
    isPaused = false;
    showRecordingIndicator(false);
  } else if (message.type === 'CLEAR_STEPS') {
    pendingLogs = [];
    pendingNetworkCalls = [];
  }
});

// --- Resume recording on page load (e.g. after navigation) -------------------

chrome.storage.local.get(['recordingActive', 'recordingPaused'], (result) => {
  if (result && result.recordingActive) {
    isRecording = true;
    isPaused = Boolean(result.recordingPaused);
    showRecordingIndicator(isPaused);
    if (!isPaused) captureNavigationStep();
  }
});

// Record a navigation step. Navigation steps have no element.
function captureNavigationStep() {
  const step = {
    type: 'navigate',
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    action: 'Navigated to ' + (document.title || window.location.href),
  };
  requestScreenshotAndSave(step);
}

// --- Click capture -----------------------------------------------------------

document.addEventListener(
  'click',
  (event) => {
    if (!isRecording || isPaused) return;

    const rawEl = event.target;
    if (!rawEl || rawEl.nodeType !== 1) return;

    const { el, action } = describeTarget(rawEl);

    // Native <select> interactions are fully captured by the `change` listener
    // below ("Selected X from [label]"). Swallowing the click avoids recording
    // a redundant "Opened dropdown" step for every dropdown interaction.
    if (el.tagName.toLowerCase() === 'select') return;

    const step = {
      type: 'click',
      url: window.location.href,
      timestamp: Date.now(),
      element: {
        tag: el.tagName.toLowerCase(),
        text: getElementText(el),
        label: accessibleName(el) || getElementLabel(el),
        role: el.getAttribute('role') || null,
        type: el.getAttribute('type') || null,
        cssSelector: generateSelector(el),
        xpath: generateXPath(el),
        boundingBox: toPlainRect(el.getBoundingClientRect()),
        ariaLabel: el.getAttribute('aria-label') || null,
      },
      action: action,
    };

    requestScreenshotAndSave(step);
  },
  true
);

// --- Input capture (debounced) -----------------------------------------------

let inputDebounceTimer = null;

document.addEventListener(
  'input',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!el || el.nodeType !== 1) return;

    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);

    inputDebounceTimer = setTimeout(() => {
      const rawValue = el.value != null ? String(el.value) : '';
      const isPassword = el.type === 'password';
      const value = isPassword ? '•'.repeat(rawValue.length) : rawValue;
      const label = getElementLabel(el);

      const step = {
        type: 'input',
        url: window.location.href,
        timestamp: Date.now(),
        element: {
          tag: el.tagName.toLowerCase(),
          label: label,
          cssSelector: generateSelector(el),
          xpath: generateXPath(el),
          boundingBox: toPlainRect(el.getBoundingClientRect()),
        },
        value: value,
        action: 'Typed "' + value + '" into ' + label,
      };

      requestScreenshotAndSave(step);
    }, 800);
  },
  true
);

// --- Select capture ----------------------------------------------------------
// The `input` event fires for text fields; `change` is the right event for
// <select> elements (clicking an option triggers `click` on the <option>, which
// bubbles to the <select> — but the selected value isn't set until `change`).

document.addEventListener(
  'change',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (el.tagName.toLowerCase() !== 'select') return;

    const label = getElementLabel(el);
    const selectedOpt = el.options[el.selectedIndex];
    const selectedText = (selectedOpt && selectedOpt.text) || el.value;

    const step = {
      type: 'input',
      url: window.location.href,
      timestamp: Date.now(),
      element: {
        tag: 'select',
        label: label,
        cssSelector: generateSelector(el),
        xpath: generateXPath(el),
        boundingBox: toPlainRect(el.getBoundingClientRect()),
      },
      value: selectedText,
      action: 'Selected "' + selectedText + '" from ' + label,
    };

    requestScreenshotAndSave(step);
  },
  true
);

// --- Element description helpers ---------------------------------------------

function toPlainRect(rect) {
  if (!rect) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function getElementText(el) {
  let text =
    (el.innerText && el.innerText.trim()) ||
    (el.value != null && String(el.value).trim()) ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    '';
  return text.trim().slice(0, 80);
}

function getElementLabel(el) {
  if (el.labels && el.labels.length > 0) {
    const labelText = el.labels[0].innerText && el.labels[0].innerText.trim();
    if (labelText) return labelText;
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  if (el.id) {
    const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forLabel && forLabel.innerText && forLabel.innerText.trim()) {
      return forLabel.innerText.trim();
    }
  }

  return getElementText(el) || el.tagName.toLowerCase();
}

// --- Semantic target resolution ----------------------------------------------

const INTERACTIVE_TAGS = new Set(['a', 'button', 'select', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'switch', 'checkbox', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
]);

const ICON_NAMES = {
  'move-up': 'sort ascending', 'move-down': 'sort descending',
  'arrow-up': 'sort ascending', 'arrow-down': 'sort descending',
  'arrow-up-down': 'sort', 'chevrons-up-down': 'sort',
  'chevron-down': 'expand', 'chevron-up': 'collapse',
  'chevron-right': 'expand', 'x': 'close', 'trash': 'delete', 'trash-2': 'delete',
  'plus': 'add', 'pencil': 'edit', 'pen': 'edit', 'search': 'search',
  'settings': 'settings', 'sliders-horizontal': 'filters',
  'more-horizontal': 'more options', 'more-vertical': 'more options',
  'eye': 'show', 'eye-off': 'hide', 'filter': 'filter', 'funnel': 'filter',
  'refresh-cw': 'refresh', 'rotate-cw': 'refresh', 'play': 'run',
  'star': 'favorite', 'download': 'download', 'upload': 'upload',
  'copy': 'copy', 'check': 'confirm', 'external-link': 'open in new tab',
};

function isInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'input' || tag === 'textarea') return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return el.hasAttribute('onclick');
}

function resolveTarget(el) {
  if (isInteractive(el)) return el;
  let node = el.parentElement;
  let hops = 0;
  while (node && node.nodeType === 1 && hops < 4) {
    if (node.tagName.toLowerCase() === 'body') break;
    if (isInteractive(node)) return node;
    node = node.parentElement;
    hops++;
  }
  return el;
}

function iconName(el) {
  const svg = el.tagName.toLowerCase() === 'svg' ? el : (el.querySelector && el.querySelector('svg'));
  const cls = (svg && svg.getAttribute && svg.getAttribute('class')) || '';
  const m = cls.match(/lucide-([a-z0-9-]+)/i);
  if (!m) return '';
  const key = m[1].toLowerCase();
  return ICON_NAMES[key] || key.replace(/-/g, ' ');
}

function accessibleName(el) {
  if (!el || !el.getAttribute) return '';

  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim().slice(0, 80);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const ref = document.getElementById(labelledby);
    if (ref && ref.innerText && ref.innerText.trim()) return ref.innerText.trim().slice(0, 80);
  }

  const text =
    (el.innerText && el.innerText.trim()) ||
    (el.value != null && String(el.value).trim()) || '';
  if (text) return text.slice(0, 80);

  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim().slice(0, 80);

  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim().slice(0, 80);

  const icon = iconName(el);
  if (icon) return icon;

  const th = el.closest && el.closest('th');
  if (th && th.innerText && th.innerText.trim()) return th.innerText.trim().slice(0, 40);

  return '';
}

function toggleState(el) {
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true') return 'on';
  if (checked === 'false') return 'off';
  if (el.tagName.toLowerCase() === 'input' && el.type === 'checkbox') {
    return el.checked ? 'on' : 'off';
  }
  return null;
}

function describeTarget(rawEl) {
  const el = resolveTarget(rawEl);
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const name = accessibleName(el);
  const quoted = name ? ' "' + name + '"' : '';

  if (role === 'switch' || role === 'checkbox' || (tag === 'input' && el.type === 'checkbox')) {
    const state = toggleState(el);
    return { el, action: 'Toggled' + (quoted || ' control') + (state ? ' → ' + state : '') };
  }

  if (tag === 'a' || role === 'link') return { el, action: 'Clicked link' + quoted };
  if (tag === 'select') return { el, action: 'Opened dropdown' + quoted };

  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'submit') return { el, action: 'Clicked submit' + quoted };
    if (type === 'radio') return { el, action: 'Selected' + quoted };
  }

  const icon = iconName(el);
  if (name) {
    const suffix = icon && icon !== name && !name.toLowerCase().includes(icon) ? ' (' + icon + ')' : '';
    return { el, action: 'Clicked "' + name + '"' + suffix };
  }
  if (icon) return { el, action: 'Clicked "' + icon + '"' };
  return { el, action: 'Clicked element' };
}

// --- Capture + persistence ---------------------------------------------------

function requestScreenshotAndSave(step) {
  step.consoleLogs = pendingLogs.splice(0);
  step.networkCalls = pendingNetworkCalls.splice(0);

  chrome.runtime.sendMessage({
    type: 'CAPTURE_AND_SAVE_STEP',
    step: step,
    elementBox: (step.element && step.element.boundingBox) || null,
    dpr: window.devicePixelRatio || 1,
  });
}

// --- Recording indicator -----------------------------------------------------

function showRecordingIndicator(paused) {
  let indicator = document.getElementById('flowsnap-indicator');
  if (!document.body) return;

  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'flowsnap-indicator';
    document.body.appendChild(indicator);
  }

  if (paused) {
    indicator.textContent = '⏸ Paused';
    indicator.classList.add('paused');
  } else {
    indicator.textContent = '● Recording';
    indicator.classList.remove('paused');
  }
}

function hideRecordingIndicator() {
  const indicator = document.getElementById('flowsnap-indicator');
  if (indicator && indicator.parentNode) {
    indicator.parentNode.removeChild(indicator);
  }
}
