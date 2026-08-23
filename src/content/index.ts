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
  mayNavigate,
} from '../core/describe/index.js';
import { generateSelector, generateXPath } from '../core/selector/index.js';
import {
  AGENT_MESSAGE_SOURCE,
  CONTROL_MESSAGE_SOURCE,
  INDICATOR_ID,
  INPUT_DEBOUNCE_MS,
  PAINT_TIMEOUT_MS,
  REACT_BUFFER_SIZE,
  REACT_BUFFER_TTL_MS,
  REACT_CHAIN_TIMEOUT_MS,
  REACT_SETTING_DEFAULTS,
} from '../shared/constants.js';
import { createChainBuffer } from '../core/react/chains.js';
import {
  sendToWorker,
  type AgentMessage,
  type CapturedComponent,
  type ContentRequest,
} from '../shared/messages.js';
import type { BoundingBox, ConsoleEntry, DraftStep, NetworkCall } from '../shared/types.js';

let isRecording = false;
let isPaused = false;

/** Buffers filled by the MAIN-world agent, drained onto the next step. */
let pendingLogs: ConsoleEntry[] = [];
let pendingNetworkCalls: NetworkCall[] = [];

function clearBuffers(): void {
  pendingLogs = [];
  pendingNetworkCalls = [];
  reactChains.clear();
}

// ── React component chains ───────────────────────────────────────────────────

/** See `core/react/chains.ts` for why chains are keyed rather than buffered. */
const reactChains = createChainBuffer<{ chain: CapturedComponent[]; truncated: boolean }>({
  size: REACT_BUFFER_SIZE,
  ttlMs: REACT_BUFFER_TTL_MS,
  timeoutMs: REACT_CHAIN_TIMEOUT_MS,
});

/**
 * The master capture setting. Assumed on until the read below says otherwise:
 * a recording that starts in the same tick as the page loads should attribute
 * its first click, and the setting is on for all but the user who turned it off.
 */
let captureReact = REACT_SETTING_DEFAULTS.reactCapture;

/** Tell the agent whether to watch for interactions at all. */
function postControl(recording: boolean): void {
  window.postMessage({ __flowsnap_control__: CONTROL_MESSAGE_SOURCE, recording }, '*');
}

/** What the agent should be doing right now: recording, live, and switched on. */
function syncAgent(): void {
  postControl(isRecording && !isPaused && captureReact);
}

// ── Agent bridge ─────────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<AgentMessage>) => {
  // Only this window's own agent may contribute. Without this check any page
  // script or cross-origin iframe could post the same envelope and inject
  // fabricated network calls and log lines into the recording — which then flow
  // into an AI's context as if they had been observed.
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isRecording || isPaused) return;

  const data = event.data;
  if (!data || data.__flowsnap_source__ !== AGENT_MESSAGE_SOURCE) return;

  if (data.kind === 'log') {
    pendingLogs.push({
      level: data.level as ConsoleEntry['level'],
      args: data.args,
      timestamp: data.timestamp,
    });
  } else if (data.kind === 'react') {
    reactChains.deliver({
      eventTime: data.eventTime,
      value: { chain: data.chain, truncated: data.truncated },
      at: Date.now(),
    });
  } else if (data.kind === 'scripts') {
    // Straight through to the worker. The content script keeps no state for
    // this — the agent already sends each URL once, and the worker is the only
    // thing that has to remember them across a page it may outlive.
    void sendToWorker({ type: 'REACT_SCRIPTS', urls: data.urls, pageUrl: location.href });
  } else if (data.kind === 'react-meta') {
    void sendToWorker({
      type: 'REACT_META',
      meta: { detected: data.detected, version: data.version, build: data.build },
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

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    // Answering this is how the extension knows a tab can record at all.
    case 'PING':
      sendResponse({ ok: true });
      return true;

    case 'START_RECORDING':
      applyState(true, false);
      break;

    case 'STOP_RECORDING':
      applyState(false, false);
      break;

    case 'PAUSE_RECORDING':
      applyState(true, true);
      break;

    case 'RESUME_RECORDING':
      applyState(true, false);
      break;

    case 'CLEAR_STEPS':
      clearBuffers();
      break;
  }

  return;
});

function applyState(recording: boolean, paused: boolean): void {
  isRecording = recording;
  isPaused = paused;
  if (!recording || paused) clearBuffers();
  // Paused counts as not watching: the agent should not walk fibers for
  // interactions that will never become steps.
  syncAgent();
  renderIndicator();
}

/**
 * Follow the recording state wherever it changes.
 *
 * A runtime message only reaches the tab the popup was opened over, so a tab the
 * user switched to — or one that was already open when recording started — never
 * learned it was supposed to be recording, and captured nothing at all with no
 * indicator and no error. Storage is shared by every tab, so watching it is what
 * makes a recording follow the user across tabs.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('recordingActive' in changes) && !('recordingPaused' in changes)) return;

  void chrome.storage.local.get(['recordingActive', 'recordingPaused']).then((state) => {
    const active = Boolean(state.recordingActive);
    const paused = Boolean(state.recordingPaused);
    const wasRecording = isRecording && !isPaused;
    applyState(active, paused);

    // Entering a live recording in a tab that was idle: log the page, so the
    // flow shows where the user went rather than jumping between contexts.
    if (active && !paused && !wasRecording) captureNavigationStep();
  });
});

// ── The capture setting ──────────────────────────────────────────────────────

function applyCaptureSetting(enabled: boolean): void {
  if (enabled === captureReact) return;
  captureReact = enabled;
  // Chains already collected for a step that has not claimed them are dropped:
  // turning capture off should stop attribution now, not after the buffer
  // drains into the next two steps.
  if (!enabled) reactChains.clear();
  syncAgent();
}

void chrome.storage.sync
  .get({ reactCapture: REACT_SETTING_DEFAULTS.reactCapture })
  .then((stored) => {
    applyCaptureSetting(stored.reactCapture !== false);
  })
  .catch(() => {
    // Sync storage is unavailable in some profiles. The default is on, which is
    // what `captureReact` already holds.
  });

/**
 * The toggle takes effect immediately, including part-way through a recording.
 *
 * A setting that only applied to the next recording would leave someone who has
 * just switched capture off watching components keep being recorded, with
 * nothing on screen to explain why.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !('reactCapture' in changes)) return;
  // A cleared key reads as undefined, which means "back to the default".
  applyCaptureSetting(changes.reactCapture.newValue !== false);
});

// ── Resume after a navigation ────────────────────────────────────────────────

void chrome.storage.local.get(['recordingActive', 'recordingPaused']).then((state) => {
  if (!state.recordingActive) return;
  applyState(true, Boolean(state.recordingPaused));
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

/**
 * Screenshot before a navigating click lands.
 *
 * The worker holds the frame and the click that follows claims it. Restricted to
 * interactions that may actually navigate, because Chrome rate-limits captures
 * and spending one on every pointerdown would starve the real steps.
 */
document.addEventListener(
  'pointerdown',
  (event) => {
    if (!isRecording || isPaused) return;
    const target = event.target;
    if (!(target instanceof Element) || !mayNavigate(target)) return;
    void withIndicatorHidden(() => sendToWorker({ type: 'PRECAPTURE' }));
  },
  true,
);

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

    requestScreenshotAndSave(
      {
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
      },
      event.timeStamp,
    );
  },
  true,
);

/**
 * One debounce timer per field, not one for the page.
 *
 * A single shared timer meant that tabbing from email to password inside the
 * debounce window discarded the email step entirely — filling a form quickly
 * lost steps.
 */
/**
 * The timer also carries the `timeStamp` of the event that armed it.
 *
 * The step is written 800 ms after the interaction, long after the component
 * chain for it arrived, so the chain has to be claimed by the key of the event
 * that *caused* the step rather than by whatever is current when it fires.
 */
const inputTimers = new WeakMap<Element, { timer: ReturnType<typeof setTimeout>; eventTime: number }>();

document.addEventListener(
  'input',
  (event) => {
    if (!isRecording || isPaused) return;

    const el = event.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;

    const existing = inputTimers.get(el);
    if (existing) clearTimeout(existing.timer);

    const eventTime = event.timeStamp;
    inputTimers.set(el, {
      eventTime,
      timer: setTimeout(() => {
        inputTimers.delete(el);

        const rawValue = el.value ?? '';
        const isPassword = el instanceof HTMLInputElement && el.type === 'password';
        const value = isPassword ? '•'.repeat(rawValue.length) : rawValue;
        const label = getElementLabel(el);

        requestScreenshotAndSave(
          {
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
          },
          eventTime,
        );
      }, INPUT_DEBOUNCE_MS),
    });
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

    requestScreenshotAndSave(
      {
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
      },
      event.timeStamp,
    );
  },
  true,
);

/**
 * `eventTime` is the `timeStamp` of the interaction that produced this step, and
 * is how its component chain is claimed. Steps with no originating event — a
 * navigation — pass nothing and simply carry no components.
 */
function requestScreenshotAndSave(step: DraftStep, eventTime?: number): void {
  // Drained synchronously, exactly as before: waiting for a component chain must
  // not change which console and network activity lands on which step.
  const enriched: DraftStep = {
    ...step,
    consoleLogs: pendingLogs.splice(0),
    networkCalls: pendingNetworkCalls.splice(0),
  };

  void (async () => {
    let components: CapturedComponent[] | undefined;

    if (eventTime !== undefined && enriched.element) {
      const found = await reactChains.take(eventTime, Date.now());
      if (found && found.chain.length > 0) {
        components = found.chain;
        enriched.element.react = {
          chain: found.chain.map((component) => component.id),
          ...(found.truncated ? { truncated: true } : {}),
        };
      }
    }

    await withIndicatorHidden(() =>
      sendToWorker({
        type: 'CAPTURE_AND_SAVE_STEP',
        step: enriched,
        elementBox: enriched.element?.boundingBox ?? null,
        dpr: window.devicePixelRatio || 1,
        components,
        componentsPageUrl: components ? window.location.href : undefined,
      }),
    );
  })();
}

// ── On-page indicator ────────────────────────────────────────────────────────

/**
 * Depth of nested capture requests. The indicator is FlowSnap's own UI, and
 * `captureVisibleTab` photographs whatever is on screen — so without hiding it,
 * every screenshot the tool has ever taken contains its own badge, which then
 * ships to an AI as if it were part of the recorded page.
 */
let captureDepth = 0;

/**
 * Resolve once the browser has painted a frame, so an element removed a moment
 * ago is genuinely off screen before anything photographs it.
 *
 * `requestAnimationFrame` never fires in a background tab, so this races a
 * timeout — waiting forever would mean the step is never sent at all.
 */
function afterPaint(): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, PAINT_TIMEOUT_MS)),
  ]);
}

async function withIndicatorHidden<T>(action: () => Promise<T>): Promise<T> {
  const wasVisible = document.getElementById(INDICATOR_ID) !== null;

  captureDepth++;
  renderIndicator();
  if (wasVisible) await afterPaint();

  try {
    return await action();
  } finally {
    captureDepth--;
    renderIndicator();
  }
}

function renderIndicator(): void {
  const existing = document.getElementById(INDICATOR_ID);

  if (!isRecording || captureDepth > 0) {
    existing?.remove();
    return;
  }

  if (!document.body) return;

  const indicator = existing ?? document.createElement('div');
  if (!existing) {
    indicator.id = INDICATOR_ID;
    document.body.appendChild(indicator);
  }

  // The status dot is drawn by content.css as a ::before, so it can pulse and
  // can stop pulsing under prefers-reduced-motion. It used to be a "●" in the
  // text, which could do neither — and the design system allows no emoji.
  indicator.textContent = isPaused ? 'Paused' : 'Recording';
  indicator.classList.toggle('paused', isPaused);
}
