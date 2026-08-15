/**
 * MV3 service worker: screenshot capture, step persistence, badge, MCP export.
 *
 * Behaviour here is a faithful port of the pre-TypeScript worker. The known
 * defects in it — capturing from the focused window rather than the sender's tab,
 * and exceeding Chrome's `captureVisibleTab` rate limit — are addressed in the
 * recording feature module, not in this move.
 */

import { annotateScreenshot } from './annotator.js';
import {
  BADGE_COLOR,
  DEFAULT_MCP_URL,
  MAX_STEPS,
  SCREENSHOT_QUALITY,
  SETTLE_DELAY_MS,
  STORAGE_BUDGET,
  WARN_STEPS,
} from '../shared/constants.js';
import type { WorkerRequest } from '../shared/messages.js';
import type { BoundingBox, DraftStep, Step } from '../shared/types.js';

/** Serialises captures so concurrent clicks never clobber each other's write. */
let captureQueue: Promise<void> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStorage<T = Record<string, unknown>>(keys: string | string[]): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items as T));
  });
}

function setStorage(obj: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function updateBadge(count: number): void {
  void chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

/**
 * Capture the visible tab as JPEG. Returns null on failure — a protected page or
 * a rate-limit rejection — so the caller still saves the step, without an image.
 */
async function captureScreenshot(): Promise<string | null> {
  try {
    return await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: SCREENSHOT_QUALITY });
  } catch (err) {
    console.error('FlowSnap: captureVisibleTab failed', err);
    return null;
  }
}

/** Capture, annotate and persist one step, enforcing the step limit. */
async function captureAndSave(
  step: DraftStep,
  elementBox: BoundingBox | null,
  dpr: number,
): Promise<void> {
  await delay(SETTLE_DELAY_MS);

  const { recordedSteps = [], recordingActive } = await getStorage<{
    recordedSteps?: Step[];
    recordingActive?: boolean;
  }>(['recordedSteps', 'recordingActive']);

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
      value: `Recording stopped: reached ${MAX_STEPS}-step limit.`,
      screenshot: null,
      stepNumber: recordedSteps.length + 1,
    });
    await setStorage({ recordingActive: false, recordedSteps });
    updateBadge(recordedSteps.length);
    return;
  }

  if (recordedSteps.length >= WARN_STEPS) {
    console.warn(`FlowSnap: ${recordedSteps.length} steps — approaching ${MAX_STEPS}-step limit.`);
  }

  try {
    const dataUrl = await captureScreenshot();

    // `getBytesInUse` avoids re-serialising the whole steps array — up to ~8 MB
    // of base64 — just to measure it.
    const bytesInUse = await new Promise<number>((resolve) => {
      chrome.storage.local.getBytesInUse(null, resolve);
    });
    const overBudget = bytesInUse + (dataUrl?.length ?? 0) > STORAGE_BUDGET;

    let screenshot: string | null = null;
    let screenshotOriginal: string | null = null;

    if (!overBudget && dataUrl) {
      screenshotOriginal = dataUrl;
      screenshot = elementBox ? await annotateScreenshot(dataUrl, elementBox, dpr) : dataUrl;
    } else if (overBudget) {
      console.warn(
        'FlowSnap: storage near limit — dropping screenshot for step',
        recordedSteps.length + 1,
      );
    }

    const saved = {
      ...step,
      screenshotOriginal,
      highlightBox: elementBox,
      dpr: dpr || 1,
      screenshot,
      stepNumber: recordedSteps.length + 1,
    } as Step;

    recordedSteps.push(saved);
    await setStorage({ recordedSteps });
    updateBadge(recordedSteps.length);
  } catch (err) {
    console.error('FlowSnap: captureAndSave failed', err);
  }
}

// ── MCP auto-export ──────────────────────────────────────────────────────────

function getMcpUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ mcpServerUrl: DEFAULT_MCP_URL }, (data) => {
      resolve((data as { mcpServerUrl: string }).mcpServerUrl);
    });
  });
}

async function autoExportToMcp(steps: Step[]): Promise<void> {
  const id = `flow-${Date.now()}`;
  const payload = JSON.stringify({
    id,
    name: `Flow ${new Date().toLocaleString()}`,
    timestamp: Date.now(),
    startUrl: steps[0]?.url,
    steps,
  });

  try {
    const res = await fetch(await getMcpUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) {
      const { id: savedId } = (await res.json()) as { id: string };
      await setStorage({ lastMcpFlowId: savedId });
    }
  } catch {
    // MCP server not running — the user can still send manually from the viewer.
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if ('recordingActive' in changes && changes.recordingActive.newValue === true) {
    void chrome.action.setBadgeText({ text: '0' });
    void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  }

  if ('recordingActive' in changes && changes.recordingActive.newValue === false) {
    // Clearing also sets recordingActive false, in the same batch as an empty
    // recordedSteps — that is a clear, not a finished recording.
    const isClearing =
      'recordedSteps' in changes &&
      Array.isArray(changes.recordedSteps.newValue) &&
      changes.recordedSteps.newValue.length === 0;
    if (isClearing) return;

    void getStorage<{ recordedSteps?: Step[] }>('recordedSteps').then(({ recordedSteps }) => {
      if (recordedSteps?.length) void autoExportToMcp(recordedSteps);
    });
  }
});

chrome.runtime.onMessage.addListener((message: WorkerRequest, _sender, sendResponse) => {
  if (!message?.type) return;

  switch (message.type) {
    case 'CAPTURE_AND_SAVE_STEP': {
      const { step, elementBox, dpr } = message;
      // Enqueue so captures run one at a time. A rejected step is swallowed so
      // one failure cannot break the chain for later steps.
      captureQueue = captureQueue.then(() =>
        captureAndSave(step, elementBox, dpr).catch((err: unknown) =>
          console.error('FlowSnap: captureAndSave rejected', err),
        ),
      );
      return;
    }

    case 'ANNOTATE_SCREENSHOT': {
      const { screenshot, box, dpr } = message;
      annotateScreenshot(screenshot, box, dpr || 1)
        .then((annotated) => sendResponse({ screenshot: annotated }))
        .catch(() => sendResponse({ screenshot: null }));
      return true;
    }

    case 'GET_STEPS': {
      void getStorage<{ recordedSteps?: Step[] }>('recordedSteps').then(({ recordedSteps }) => {
        sendResponse({ steps: recordedSteps ?? [] });
      });
      return true;
    }

    case 'CLEAR_STEPS': {
      void setStorage({ recordedSteps: [], recordingActive: false, recordingPaused: false }).then(
        () => {
          updateBadge(0);
          sendResponse({ ok: true });
        },
      );
      return true;
    }

    default:
      return;
  }
});
