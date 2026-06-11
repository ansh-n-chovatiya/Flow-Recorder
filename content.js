// FlowSnap — content script.
// selector.js is loaded before this file in the same content_scripts array,
// so generateSelector() and generateXPath() are available in this scope.

let isRecording = false;

// --- Messaging from background/popup -----------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  if (message.type === 'START_RECORDING') {
    isRecording = true;
    showRecordingIndicator();
  } else if (message.type === 'STOP_RECORDING') {
    isRecording = false;
    hideRecordingIndicator();
  }
});

// --- Resume recording on page load (e.g. after navigation) -------------------

chrome.storage.local.get('recordingActive', (result) => {
  if (result && result.recordingActive) {
    isRecording = true;
    showRecordingIndicator();
    captureNavigationStep();
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
    if (!isRecording) return;

    const rawEl = event.target;
    // e.target may be a text node, the document, or null — skip non-Elements.
    if (!rawEl || rawEl.nodeType !== 1) return;

    // Resolve the raw target (often a presentational <svg>/<span>) to the real
    // control, then describe it. We record the resolved element so the label,
    // selector and highlight box all point at the thing the user meant to click.
    const { el, action } = describeTarget(rawEl);

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
    if (!isRecording) return;

    const el = event.target;
    if (!el || el.nodeType !== 1) return;

    if (inputDebounceTimer) {
      clearTimeout(inputDebounceTimer);
    }

    inputDebounceTimer = setTimeout(() => {
      // Mask password values with bullets.
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

// --- Element description helpers ---------------------------------------------

// chrome.runtime.sendMessage uses JSON serialization, and DOMRect's fields are
// prototype getters (not own-enumerable) — so a raw DOMRect serializes to "{}".
// Copy the fields we need into a plain object so they survive the message.
function toPlainRect(rect) {
  if (!rect) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

// Best-effort human-readable text for an element, capped at 80 chars.
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

// Best-effort label for a form/control element.
function getElementLabel(el) {
  // Associated <label> elements (HTMLInputElement.labels).
  if (el.labels && el.labels.length > 0) {
    const labelText = el.labels[0].innerText && el.labels[0].innerText.trim();
    if (labelText) return labelText;
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  // <label for="id"> lookup.
  if (el.id) {
    const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (forLabel && forLabel.innerText && forLabel.innerText.trim()) {
      return forLabel.innerText.trim();
    }
  }

  // Fall back to the element's own text.
  return getElementText(el) || el.tagName.toLowerCase();
}

// --- Semantic target resolution ----------------------------------------------
// Icon-only and nested clicks (an <svg> inside a <button>) carry no useful text.
// We climb to the nearest real control and derive a human name from it, so the
// AI sees "Clicked sort ascending" instead of "Clicked element" / label "svg".

const INTERACTIVE_TAGS = new Set(['a', 'button', 'select', 'summary']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'switch', 'checkbox', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
]);

// lucide-<name> icon classes → a readable verb/noun. Anything not mapped falls
// back to the dash-stripped class (e.g. "grip-vertical" → "grip vertical").
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

// Climb at most 4 levels from the raw target to the nearest real control.
// Returns the original element if nothing more meaningful is found.
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

// Name of a lucide icon on the element or its first descendant svg, if any.
function iconName(el) {
  const svg = el.tagName.toLowerCase() === 'svg' ? el : (el.querySelector && el.querySelector('svg'));
  const cls = (svg && svg.getAttribute && svg.getAttribute('class')) || '';
  const m = cls.match(/lucide-([a-z0-9-]+)/i);
  if (!m) return '';
  const key = m[1].toLowerCase();
  return ICON_NAMES[key] || key.replace(/-/g, ' ');
}

// Accessible name for a control: aria-label > labelledby > text/value > title >
// alt > icon name > nearest column-header text. Empty string if none found.
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

// Resulting on/off state of a toggle (read post-click, so it reflects the new
// state). null when the element is not a toggle.
function toggleState(el) {
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true') return 'on';
  if (checked === 'false') return 'off';
  if (el.tagName.toLowerCase() === 'input' && el.type === 'checkbox') {
    return el.checked ? 'on' : 'off';
  }
  return null;
}

// Resolve the clicked element and build a short natural-language action.
// Returns { el, action } — el is the resolved control to record.
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

  // Generic click. Prefer the accessible name; annotate with the icon meaning
  // when the icon adds information the name doesn't already carry.
  const icon = iconName(el);
  if (name) {
    const suffix = icon && icon !== name && !name.toLowerCase().includes(icon) ? ' (' + icon + ')' : '';
    return { el, action: 'Clicked "' + name + '"' + suffix };
  }
  if (icon) return { el, action: 'Clicked "' + icon + '"' };
  return { el, action: 'Clicked element' };
}

// --- Capture + persistence ---------------------------------------------------

// Ask the background to capture a screenshot and persist the step.
function requestScreenshotAndSave(step) {
  chrome.runtime.sendMessage({
    type: 'CAPTURE_AND_SAVE_STEP',
    step: step,
    elementBox: (step.element && step.element.boundingBox) || null,
    dpr: window.devicePixelRatio || 1,
  });
}

// --- Recording indicator -----------------------------------------------------

function showRecordingIndicator() {
  // Guard against duplicates.
  if (document.getElementById('flowsnap-indicator')) return;
  if (!document.body) return;

  const indicator = document.createElement('div');
  indicator.id = 'flowsnap-indicator';
  indicator.textContent = '● Recording';
  document.body.appendChild(indicator);
}

function hideRecordingIndicator() {
  const indicator = document.getElementById('flowsnap-indicator');
  if (indicator && indicator.parentNode) {
    indicator.parentNode.removeChild(indicator);
  }
}
