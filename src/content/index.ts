/**
 * Isolated-world content script: watches the page and turns interactions into
 * steps.
 *
 * Shares the DOM with the page but not its JS context, which is why network and
 * console data arrives from `injected/agent.ts` by `postMessage` rather than
 * being read directly.
 */

import {
  accessibleName,
  describeTarget,
  getElementLabel,
  getElementText,
} from '../core/describe/index.js';
import { generateSelector, generateXPath } from '../core/selector/index.js';
import { AGENT_MESSAGE_SOURCE, INDICATOR_ID, INPUT_DEBOUNCE_MS } from '../shared/constants.js';
import type { AgentMessage, ContentRequest } from '../shared/messages.js';
import type { BoundingBox, ConsoleEntry, DraftStep, NetworkCall } from '../shared/types.js';

let isRecording = false;
let isPaused = false;

/** Buffers filled by the MAIN-world agent, drained onto the next step. */
let pendingLogs: ConsoleEntry[] = [];
let pendingNetworkCalls: NetworkCall[] = [];

// ── Agent bridge ─────────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<AgentMessage>) => {
  if (!isRecording || isPaused) return;

  const data = event.data;
  if (!data || data.__flowsnap_source__ !== AGENT_MESSAGE_SOURCE) return;

  if (data.kind === 'log') {
    pendingLogs.push({
      level: data.level as ConsoleEntry['level'],
      args: data.args,
      timestamp: data.timestamp,
    });
  } else if (data.kind === 'network') {
    pendingNetworkCalls.push({
      method: data.method,
      url: data.url,
      requestHeaders: data.requestHeaders,
      requestBody: data.requestBody,
      status: data.status,
      responseHeaders: data.responseHeaders,
      responseBody: data.responseBody,
      durationMs: data.durationMs,
      timestamp: data.timestamp,
    });
  }
});

// ── Control messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ContentRequest) => {
  if (!message?.type) return;

  switch (message.type) {
    case 'START_RECORDING':
      isRecording = true;
      isPaused = false;
      showRecordingIndicator(false);
      break;

    case 'STOP_RECORDING':
      isRecording = false;
      isPaused = false;
      hideRecordingIndicator();
      pendingLogs = [];
      pendingNetworkCalls = [];
      break;

    case 'PAUSE_RECORDING':
      isPaused = true;
      pendingLogs = [];
      pendingNetworkCalls = [];
      showRecordingIndicator(true);
      break;

    case 'RESUME_RECORDING':
      isPaused = false;
      showRecordingIndicator(false);
      break;

    case 'CLEAR_STEPS':
      pendingLogs = [];
      pendingNetworkCalls = [];
      break;
  }
});

// ── Resume after a navigation ────────────────────────────────────────────────

chrome.storage.local.get(['recordingActive', 'recordingPaused'], (result) => {
  const { recordingActive, recordingPaused } = result as {
    recordingActive?: boolean;
    recordingPaused?: boolean;
  };
  if (!recordingActive) return;

  isRecording = true;
  isPaused = Boolean(recordingPaused);
  showRecordingIndicator(isPaused);
  if (!isPaused) captureNavigationStep();
});

function captureNavigationStep(): void {
  requestScreenshotAndSave({
    type: 'navigate',
    url: window.location.href,
    title: document.title,
    timestamp: Date.now(),
    action: `Navigated to ${document.title || window.location.href}`,
  });
}

// ── Capture ──────────────────────────────────────────────────────────────────

function toPlainRect(rect: DOMRect | null): BoundingBox | null {
  if (!rect) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

document.addEventListener(
  'click',
  (event) => {
    if (!isRecording || isPaused) return;

    const rawEl = event.target;
    if (!(rawEl instanceof Element)) return;

    const { el, action } = describeTarget(rawEl);

    // A native <select> is fully covered by the `change` listener below
    // ("Selected X from …"). Swallowing the click avoids a redundant
    // "Opened dropdown" step on every dropdown interaction.
    if (el.tagName.toLowerCase() === 'select') return;

    requestScreenshotAndSave({
      type: 'click',
      url: window.location.href,
      timestamp: Date.now(),
      element: {
        tag: el.tagName.toLowerCase(),
        text: getElementText(el),
        label: accessibleName(el) || getElementLabel(el),
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        cssSelector: generateSelector(el),
        xpath: generateXPath(el),
        boundingBox: toPlainRect(el.getBoundingClientRect()),
        ariaLabel: el.getAttribute('aria-label'),
      },
      action,
    });
  },
  true,
);

let inputDebounceTimer: ReturnType<typeof setTimeout> | null = null;

document.addEventListener(
  'input',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;

    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);

    inputDebounceTimer = setTimeout(() => {
      const rawValue = el.value != null ? String(el.value) : '';
      const isPassword = el instanceof HTMLInputElement && el.type === 'password';
      const value = isPassword ? '•'.repeat(rawValue.length) : rawValue;
      const label = getElementLabel(el);

      requestScreenshotAndSave({
        type: 'input',
        url: window.location.href,
        timestamp: Date.now(),
        element: {
          tag: el.tagName.toLowerCase(),
          label,
          cssSelector: generateSelector(el),
          xpath: generateXPath(el),
          boundingBox: toPlainRect(el.getBoundingClientRect()),
        },
        value,
        action: `Typed "${value}" into ${label}`,
      });
    }, INPUT_DEBOUNCE_MS);
  },
  true,
);

/**
 * `input` fires for text fields; `change` is the right event for `<select>` —
 * clicking an option fires `click` on the `<option>`, but the value is not set
 * until `change`.
 */
document.addEventListener(
  'change',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!(el instanceof HTMLSelectElement)) return;

    const label = getElementLabel(el);
    const selectedText = el.options[el.selectedIndex]?.text || el.value;

    requestScreenshotAndSave({
      type: 'input',
      url: window.location.href,
      timestamp: Date.now(),
      element: {
        tag: 'select',
        label,
        cssSelector: generateSelector(el),
        xpath: generateXPath(el),
        boundingBox: toPlainRect(el.getBoundingClientRect()),
      },
      value: selectedText,
      action: `Selected "${selectedText}" from ${label}`,
    });
  },
  true,
);

function requestScreenshotAndSave(step: DraftStep): void {
  const enriched: DraftStep = {
    ...step,
    consoleLogs: pendingLogs.splice(0),
    networkCalls: pendingNetworkCalls.splice(0),
  };

  void chrome.runtime.sendMessage({
    type: 'CAPTURE_AND_SAVE_STEP',
    step: enriched,
    elementBox: enriched.element?.boundingBox ?? null,
    dpr: window.devicePixelRatio || 1,
  });
}

// ── On-page indicator ────────────────────────────────────────────────────────

function showRecordingIndicator(paused: boolean): void {
  if (!document.body) return;

  let indicator = document.getElementById(INDICATOR_ID);
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = INDICATOR_ID;
    document.body.appendChild(indicator);
  }

  indicator.textContent = paused ? '⏸ Paused' : '● Recording';
  indicator.classList.toggle('paused', paused);
}

function hideRecordingIndicator(): void {
  document.getElementById(INDICATOR_ID)?.remove();
}
