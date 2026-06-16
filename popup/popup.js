// FlowSnap popup controller.
// Drives recording state (idle / recording / paused), button visibility,
// and live step count.

const statusEl    = document.getElementById('status');
const stepCountEl = document.getElementById('step-count');
const btnStart    = document.getElementById('btn-start');
const btnStop     = document.getElementById('btn-stop');
const btnPause    = document.getElementById('btn-pause');
const btnResume   = document.getElementById('btn-resume');
const btnView     = document.getElementById('btn-view');
const btnClear    = document.getElementById('btn-clear');

// state: 'idle' | 'recording' | 'paused'
function updateUI(state, count) {
  const stepCount = count || 0;

  // status line
  if (state === 'recording') {
    statusEl.textContent = '● Recording in progress...';
    statusEl.className = 'recording';
  } else if (state === 'paused') {
    statusEl.textContent = '⏸ Recording paused';
    statusEl.className = 'paused';
  } else {
    statusEl.textContent = 'Ready to record';
    statusEl.className = '';
  }

  // button visibility
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  hide(btnStart); hide(btnStop); hide(btnPause); hide(btnResume);
  hide(btnView);  hide(btnClear);

  if (state === 'recording') {
    show(btnPause);
    show(btnStop);
  } else if (state === 'paused') {
    show(btnResume);
    show(btnStop);
  } else {
    show(btnStart);
    if (stepCount > 0) { show(btnView); show(btnClear); }
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
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn('FlowSnap: could not message tab', err);
  }
}

async function refresh() {
  const { recordingActive, recordingPaused, recordedSteps } =
    await chrome.storage.local.get(['recordingActive', 'recordingPaused', 'recordedSteps']);
  const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
  const state = recordingActive
    ? (recordingPaused ? 'paused' : 'recording')
    : 'idle';
  updateUI(state, count);
}

async function init() {
  await refresh();
  setInterval(refresh, 1000);
}

btnStart.addEventListener('click', async () => {
  await chrome.storage.local.set({ recordingActive: true, recordingPaused: false, recordedSteps: [] });
  await sendToTab({ type: 'START_RECORDING' });
  updateUI('recording', 0);
});

btnStop.addEventListener('click', async () => {
  await chrome.storage.local.set({ recordingActive: false, recordingPaused: false });
  await sendToTab({ type: 'STOP_RECORDING' });
  const { recordedSteps } = await chrome.storage.local.get('recordedSteps');
  const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
  updateUI('idle', count);
});

btnPause.addEventListener('click', async () => {
  await chrome.storage.local.set({ recordingPaused: true });
  await sendToTab({ type: 'PAUSE_RECORDING' });
  const { recordedSteps } = await chrome.storage.local.get('recordedSteps');
  const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
  updateUI('paused', count);
});

btnResume.addEventListener('click', async () => {
  await chrome.storage.local.set({ recordingPaused: false });
  await sendToTab({ type: 'RESUME_RECORDING' });
  const { recordedSteps } = await chrome.storage.local.get('recordedSteps');
  const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
  updateUI('recording', count);
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
  await chrome.storage.local.set({ recordedSteps: [], recordingActive: false, recordingPaused: false });
  updateUI('idle', 0);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('recordedSteps' in changes) && !('recordingActive' in changes) && !('recordingPaused' in changes)) return;
  chrome.storage.local.get(['recordingActive', 'recordingPaused', 'recordedSteps']).then(
    ({ recordingActive, recordingPaused, recordedSteps }) => {
      const count = Array.isArray(recordedSteps) ? recordedSteps.length : 0;
      const state = recordingActive ? (recordingPaused ? 'paused' : 'recording') : 'idle';
      updateUI(state, count);
    }
  );
});

init();
