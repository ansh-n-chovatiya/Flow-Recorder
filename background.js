// background.js — FlowSnap MV3 service worker.
// annotator.js is imported here (NOT in manifest) and exposes annotateScreenshot.
importScripts('lib/annotator.js');

const MAX_STEPS = 30;
const WARN_STEPS = 25;
const SETTLE_DELAY_MS = 150;
// chrome.storage.local quota is 10 MB. Drop screenshots once content approaches
// this to keep metadata safe (the step itself is still saved, just no image).
const STORAGE_BUDGET = 8_000_000; // 8 MB

// Serializes captures so concurrent clicks never clobber each other's write.
let captureQueue = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF3B30' });
}

// Capture the visible tab as JPEG. Returns null on failure (protected page /
// rate limit) so the caller can still save the step without a screenshot.
async function captureScreenshot() {
  try {
    return await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
  } catch (err) {
    console.error('FlowSnap: captureVisibleTab failed', err);
    return null;
  }
}

// Capture + annotate + persist a single step, enforcing the step limit.
async function captureAndSave(step, elementBox, dpr) {
  await delay(SETTLE_DELAY_MS);

  const { recordedSteps = [], recordingActive } = await getStorage(['recordedSteps', 'recordingActive']);

  // Bail if recording was stopped (by user or by a prior limit-hit) while this
  // capture was sitting in the queue. Without this, multiple queued captures all
  // see length >= MAX_STEPS and each push a duplicate "limit-reached" note.
  if (!recordingActive) return;

  if (recordedSteps.length >= MAX_STEPS) {
    recordedSteps.push({
      type: 'note',
      url: step && step.url,
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

    // Storage budget guard: getBytesInUse avoids re-serializing the full steps
    // array (which can be ~8 MB of base64) just to measure it.
    const bytesInUse = await new Promise(resolve => chrome.storage.local.getBytesInUse(null, resolve));
    const screenshotSize = dataUrl ? dataUrl.length : 0;
    const overBudget = bytesInUse + screenshotSize > STORAGE_BUDGET;

    let screenshot = null;
    let screenshotOriginal = null;

    if (!overBudget && dataUrl) {
      screenshotOriginal = dataUrl;
      screenshot = elementBox
        ? await annotateScreenshot(dataUrl, elementBox, dpr || 1)
        : dataUrl;
    } else if (overBudget) {
      console.warn('FlowSnap: storage near limit — dropping screenshot for step', recordedSteps.length + 1);
    }

    step.screenshotOriginal = screenshotOriginal;
    step.highlightBox = elementBox || null;
    step.dpr = dpr || 1;
    step.screenshot = screenshot;
    step.stepNumber = recordedSteps.length + 1;

    recordedSteps.push(step);
    await setStorage({ recordedSteps });
    updateBadge(recordedSteps.length);
  } catch (err) {
    console.error('FlowSnap: captureAndSave failed', err);
  }
}

// ── MCP auto-export ────────────────────────────────────────────────────────

const DEFAULT_MCP_HTTP = 'http://127.0.0.1:7734/flows';

async function getMcpUrl() {
  return new Promise(resolve => {
    chrome.storage.sync.get({ mcpServerUrl: DEFAULT_MCP_HTTP }, d => resolve(d.mcpServerUrl));
  });
}

async function autoExportToMcp(steps) {
  const id        = 'flow-' + Date.now();
  const name      = 'Flow ' + new Date().toLocaleString();
  const startUrl  = steps[0] && steps[0].url;
  const payload   = JSON.stringify({ id, name, timestamp: Date.now(), startUrl, steps });

  try {
    const mcpUrl = await getMcpUrl();
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) {
      const { id: savedId } = await res.json();
      await setStorage({ lastMcpFlowId: savedId });
      console.info('FlowSnap: auto-exported flow', savedId);
    }
  } catch {
    // MCP server not running — fail silently, user can send manually from viewer
  }
}

// Reset badge on new recording start; auto-export to MCP on stop.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  if ('recordingActive' in changes && changes.recordingActive.newValue === true) {
    chrome.action.setBadgeText({ text: '0' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF3B30' });
  }

  // Auto-export when recording stops (but not on clear — clear sets recordedSteps: [] in same batch)
  if ('recordingActive' in changes && changes.recordingActive.newValue === false) {
    const isClearing = 'recordedSteps' in changes &&
      Array.isArray(changes.recordedSteps.newValue) &&
      changes.recordedSteps.newValue.length === 0;
    if (isClearing) return;

    const { recordedSteps } = await getStorage('recordedSteps');
    if (Array.isArray(recordedSteps) && recordedSteps.length > 0) {
      autoExportToMcp(recordedSteps);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'CAPTURE_AND_SAVE_STEP': {
      const { step, elementBox, dpr } = message;
      // Enqueue so captures run one at a time. Swallow a rejected step so one
      // failure can't break the chain for later steps.
      captureQueue = captureQueue.then(() =>
        captureAndSave(step, elementBox, dpr).catch((err) =>
          console.error('FlowSnap: captureAndSave rejected', err)
        )
      );
      return;
    }

    case 'ANNOTATE_SCREENSHOT': {
      const { screenshot, box, dpr } = message;
      annotateScreenshot(screenshot, box, dpr || 1)
        .then(annotated => sendResponse({ screenshot: annotated }))
        .catch(() => sendResponse({ screenshot: null }));
      return true;
    }

    case 'GET_STEPS': {
      getStorage('recordedSteps').then(({ recordedSteps }) => {
        sendResponse({ steps: recordedSteps || [] });
      });
      return true;
    }

    case 'CLEAR_STEPS': {
      setStorage({ recordedSteps: [], recordingActive: false, recordingPaused: false }).then(() => {
        updateBadge(0);
        sendResponse({ ok: true });
      });
      return true;
    }

    default:
      return;
  }
});
