// FlowSnap popup controller.
// Drives recording state, button visibility, and live step count.

const statusEl = document.getElementById('status');
const stepCountEl = document.getElementById('step-count');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnView = document.getElementById('btn-view');
const btnClear = document.getElementById('btn-clear');

function updateUI(recording, count) {
  const stepCount = count || 0;

  if (recording) {
    statusEl.textContent = '● Recording in progress...';
    statusEl.classList.add('recording');
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnView.classList.add('hidden');
    btnClear.classList.add('hidden');
  } else {
    statusEl.textContent = 'Ready to record';
    statusEl.classList.remove('recording');
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    if (stepCount > 0) {
      btnView.classList.remove('hidden');
      btnClear.classList.remove('hidden');
    } else {
      btnView.classList.add('hidden');
      btnClear.classList.add('hidden');
    }
  }

  stepCountEl.textContent =
    stepCount === 1 ? '1 step captured' : `${stepCount} steps captured`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(message) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;
  try {
    // Content script may not be injected on chrome:// or extension pages.
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn('FlowSnap: could not message tab', err);
  }
}

async function refresh() {
  const { recordingActive, recordedSteps } = await chrome.storage.local.get([
    'recordingActive',
    'recordedSteps',
  ]);
  const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
  updateUI(Boolean(recordingActive), count);
}

async function init() {
  await refresh();
  // Poll the step count while the popup is open (belt-and-suspenders alongside
  // the storage.onChanged listener below).
  setInterval(refresh, 1000);
}

btnStart.addEventListener('click', async () => {
  await chrome.storage.local.set({ recordingActive: true, recordedSteps: [] });
  await sendToTab({ type: 'START_RECORDING' });
  updateUI(true, 0);
});

btnStop.addEventListener('click', async () => {
  await chrome.storage.local.set({ recordingActive: false });
  await sendToTab({ type: 'STOP_RECORDING' });
  const { recordedSteps } = await chrome.storage.local.get('recordedSteps');
  const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
  updateUI(false, count);
});

btnView.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
});

btnClear.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_STEPS' });
  } catch (err) {
    console.warn('FlowSnap: CLEAR_STEPS message failed', err);
  }
  await chrome.storage.local.set({ recordedSteps: [], recordingActive: false });
  updateUI(false, 0);
});

// Live-update the step count (and recording state) while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('recordedSteps' in changes) && !('recordingActive' in changes)) return;

  chrome.storage.local.get(['recordingActive', 'recordedSteps']).then(
    ({ recordingActive, recordedSteps }) => {
      const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
      updateUI(Boolean(recordingActive), count);
    }
  );
});

init();
