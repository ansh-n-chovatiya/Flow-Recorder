// background.js — FlowSnap MV3 service worker.
// annotator.js is imported here (NOT in manifest) and exposes annotateScreenshot.
importScripts('lib/annotator.js');

const MAX_STEPS = 30;
const WARN_STEPS = 25;
const SETTLE_DELAY_MS = 150;

// Serializes captures. Each captureAndSave does an async read-modify-write of
// recordedSteps; without this, two fast events both read the same array, both
// push, and the second setStorage clobbers the first — dropping a step and
// duplicating stepNumber. Chaining every capture off the previous one makes
// the read-modify-write atomic relative to other captures.
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

  const { recordedSteps = [] } = await getStorage('recordedSteps');

  // Step-limit enforcement is owned here: at 30 stop recording, do not save.
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
    return;
  }

  if (recordedSteps.length >= WARN_STEPS) {
    console.warn(
      `FlowSnap: ${recordedSteps.length} steps recorded — approaching ${MAX_STEPS}-step limit.`
    );
  }

  try {
    const dataUrl = await captureScreenshot();
    let screenshot = null;
    if (dataUrl) {
      screenshot = elementBox
        ? await annotateScreenshot(dataUrl, elementBox, dpr || 1)
        : dataUrl;
    }

    step.screenshot = screenshot;
    step.stepNumber = recordedSteps.length + 1;

    recordedSteps.push(step);
    await setStorage({ recordedSteps });
  } catch (err) {
    console.error('FlowSnap: captureAndSave failed', err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'CAPTURE_AND_SAVE_STEP': {
      const { step, elementBox, dpr } = message;
      // Enqueue so captures run one at a time (see captureQueue above). Swallow
      // a rejected step so one failure can't break the chain for later steps.
      captureQueue = captureQueue.then(() =>
        captureAndSave(step, elementBox, dpr).catch((err) =>
          console.error('FlowSnap: captureAndSave rejected', err)
        )
      );
      return; // fire-and-forget; no response expected
    }

    case 'GET_STEPS': {
      getStorage('recordedSteps').then(({ recordedSteps }) => {
        sendResponse({ steps: recordedSteps || [] });
      });
      return true; // async response
    }

    case 'CLEAR_STEPS': {
      setStorage({ recordedSteps: [], recordingActive: false }).then(() => {
        sendResponse({ ok: true });
      });
      return true; // async response
    }

    default:
      return;
  }
});
