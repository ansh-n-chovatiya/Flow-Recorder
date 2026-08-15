/**
 * MV3 service worker: screenshot capture, step persistence, badge, MCP export.
 *
 * Every Chrome call goes through `src/chrome/`, so failures arrive as values.
 * The worker's job is to decide what a failure means for the recording — most
 * of the time "save the step without an image and tell the user why".
 */

import { annotateScreenshot } from './annotator.js';
import { getLocal, getSync, setLocal } from '../chrome/storage.js';
import { captureVisibleTab } from '../chrome/tabs.js';
import {
  BADGE_COLOR,
  DEFAULT_MCP_URL,
  MAX_STEPS,
  PRECAPTURE_TTL_MS,
  SETTLE_DELAY_MS,
} from '../shared/constants.js';
import { flowError, type FlowError } from '../shared/errors.js';
import type { WorkerRequest } from '../shared/messages.js';
import type { BoundingBox, DraftStep, Step } from '../shared/types.js';

/** Serialises captures so concurrent clicks never clobber each other's write. */
let captureQueue: Promise<void> = Promise.resolve();

/**
 * Screenshots taken on pointerdown, waiting for the click that follows.
 * Keyed by tab, because two tabs can be mid-interaction at once.
 */
const precaptures = new Map<number, { dataUrl: string; at: number }>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateBadge(count: number): void {
  void chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

/**
 * Record a failure where the UI can find it. The popup and the viewer both read
 * `lastError`, so a silent capture or storage failure becomes something the user
 * can actually see.
 */
async function reportError(error: FlowError): Promise<void> {
  console.warn(`FlowSnap: ${error.code} — ${error.detail ?? error.message}`);
  await setLocal({ lastError: { ...error, at: Date.now() } });
}

/** Take the pre-capture for a tab if one is fresh enough to still be true. */
function claimPrecapture(tabId: number | undefined): string | null {
  if (tabId == null) return null;
  const held = precaptures.get(tabId);
  if (!held) return null;
  precaptures.delete(tabId);
  return Date.now() - held.at <= PRECAPTURE_TTL_MS ? held.dataUrl : null;
}

/** Capture, annotate and persist one step, enforcing the step limit. */
async function captureAndSave(
  step: DraftStep,
  elementBox: BoundingBox | null,
  dpr: number,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  // A pre-capture is already the right frame — waiting would only let the page
  // navigate further away from the moment being described.
  const preShot = claimPrecapture(sender.tab?.id);
  if (!preShot) await delay(SETTLE_DELAY_MS);

  const stored = await getLocal(['recordedSteps', 'recordingActive']);
  if (!stored.ok) {
    await reportError(stored.error);
    return;
  }

  const recordedSteps = (stored.value.recordedSteps ?? []);
  const recordingActive = Boolean(stored.value.recordingActive);

  // Bail if recording stopped while this capture sat in the queue. Without this,
  // every queued capture sees length >= MAX_STEPS and pushes its own duplicate
  // "limit reached" note.
  if (!recordingActive) return;

  if (recordedSteps.length >= MAX_STEPS) {
    recordedSteps.push({
      type: 'note',
      url: step.url,
      timestamp: Date.now(),
      action: 'limit-reached',
      value: `Recording stopped at ${MAX_STEPS} steps, FlowSnap's safety limit. Every step up to here was saved.`,
      screenshot: null,
      stepNumber: recordedSteps.length + 1,
    });
    const written = await setLocal({ recordingActive: false, recordedSteps });
    if (!written.ok) await reportError(written.error);
    updateBadge(recordedSteps.length);
    return;
  }

  let dataUrl: string | null = preShot;
  if (!dataUrl) {
    const captured = await captureVisibleTab(sender.tab?.windowId);
    if (captured.ok) {
      dataUrl = captured.value;
    } else {
      // A step with no image still carries its selectors, timing and network —
      // losing the whole step because the screenshot failed would be worse.
      await reportError(captured.error);
    }
  }

  let screenshot: string | null = null;
  let screenshotOriginal: string | null = null;

  if (dataUrl) {
    screenshot = await annotateScreenshot(dataUrl, elementBox, dpr);
    // Only when annotating changed the image — otherwise the two are identical
    // and every capture rewrites both. Readers resolve null as `?? screenshot`.
    // Compared, not inferred from `elementBox`: the annotator also returns the
    // source unchanged when it cannot get a canvas.
    screenshotOriginal = screenshot === dataUrl ? null : dataUrl;
  }

  recordedSteps.push({
    ...step,
    screenshotOriginal,
    highlightBox: elementBox,
    dpr: dpr || 1,
    screenshot,
    stepNumber: recordedSteps.length + 1,
  } as Step);

  const written = await setLocal({ recordedSteps });
  if (!written.ok) {
    await reportError(written.error);
    return;
  }

  updateBadge(recordedSteps.length);
}

// ── MCP auto-export ──────────────────────────────────────────────────────────

async function autoExportToMcp(steps: Step[]): Promise<void> {
  const settings = await getSync({ mcpServerUrl: DEFAULT_MCP_URL, mcpAutoSend: false });
  if (!settings.ok || !settings.value.mcpAutoSend) return;

  const payload = JSON.stringify({
    id: `flow-${Date.now()}`,
    name: `Flow ${new Date().toLocaleString()}`,
    timestamp: Date.now(),
    startUrl: steps[0]?.url,
    steps,
  });

  try {
    const res = await fetch(settings.value.mcpServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    await setLocal({ lastMcpFlowId: id });
  } catch (error) {
    await reportError(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('recordingActive' in changes)) return;

  if (changes.recordingActive.newValue === true) {
    void chrome.action.setBadgeText({ text: '0' });
    void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    return;
  }

  // Clearing also sets recordingActive false, in the same batch as an empty
  // recordedSteps — that is a clear, not a finished recording.
  const isClearing =
    'recordedSteps' in changes &&
    Array.isArray(changes.recordedSteps.newValue) &&
    changes.recordedSteps.newValue.length === 0;
  if (isClearing) return;

  void getLocal('recordedSteps').then((stored) => {
    const steps = stored.ok ? ((stored.value.recordedSteps ?? [])) : [];
    if (steps.length) void autoExportToMcp(steps);
  });
});

/** A tab that goes away cannot claim its pre-capture. */
chrome.tabs.onRemoved.addListener((tabId) => precaptures.delete(tabId));

chrome.runtime.onMessage.addListener((message: WorkerRequest, sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    case 'PRECAPTURE': {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false });
        return true;
      }
      void captureVisibleTab(sender.tab?.windowId).then((captured) => {
        if (captured.ok) precaptures.set(tabId, { dataUrl: captured.value, at: Date.now() });
        // Respond either way: the page is holding its recording indicator hidden
        // until this resolves.
        sendResponse({ ok: captured.ok });
      });
      return true;
    }

    case 'CAPTURE_AND_SAVE_STEP': {
      const { step, elementBox, dpr } = message;
      // Enqueue so captures run one at a time. A rejected step is swallowed so
      // one failure cannot break the chain for later steps.
      captureQueue = captureQueue.then(() =>
        captureAndSave(step, elementBox, dpr, sender).catch((error: unknown) =>
          console.error('FlowSnap: captureAndSave rejected', error),
        ),
      );
      // Resolve immediately — the caller only needs to know the request landed,
      // and waiting for the queue would hold the page's indicator hidden for as
      // long as the backlog takes.
      sendResponse({ ok: true });
      return true;
    }

    case 'ANNOTATE_SCREENSHOT': {
      const { screenshot, box, dpr } = message;
      annotateScreenshot(screenshot, box, dpr || 1)
        .then((annotated) => sendResponse({ screenshot: annotated }))
        .catch(() => sendResponse({ screenshot: null }));
      return true;
    }

    case 'GET_STEPS': {
      void getLocal('recordedSteps').then((stored) => {
        sendResponse({ steps: stored.ok ? ((stored.value.recordedSteps ?? [])) : [] });
      });
      return true;
    }

    case 'CLEAR_STEPS': {
      void setLocal({
        recordedSteps: [],
        recordingActive: false,
        recordingPaused: false,
      }).then((written) => {
        updateBadge(0);
        sendResponse({ ok: written.ok });
      });
      return true;
    }

    default:
      return;
  }
});
