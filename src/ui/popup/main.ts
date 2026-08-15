/**
 * Popup controller: recording state, button visibility, live step count.
 *
 * The three-state model (idle / recording / paused) is derived in one place
 * here rather than being re-computed at each call site.
 */

import { DEFAULT_MCP_URL } from '../../shared/constants.js';
import { sendToWorker } from '../../shared/messages.js';
import type { ContentRequest } from '../../shared/messages.js';
import type { RecordingState } from '../../shared/types.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`FlowSnap: missing #${id} in popup.html`);
  return node as T;
}

const statusEl = el('status');
const stepCountEl = el('step-count');
const btnStart = el<HTMLButtonElement>('btn-start');
const btnStop = el<HTMLButtonElement>('btn-stop');
const btnPause = el<HTMLButtonElement>('btn-pause');
const btnResume = el<HTMLButtonElement>('btn-resume');
const btnView = el<HTMLButtonElement>('btn-view');
const btnClear = el<HTMLButtonElement>('btn-clear');

const ALL_BUTTONS = [btnStart, btnStop, btnPause, btnResume, btnView, btnClear];

const STATUS_TEXT: Record<RecordingState, string> = {
  idle: 'Ready to record',
  recording: '● Recording in progress...',
  paused: '⏸ Recording paused',
};

function updateUI(state: RecordingState, count: number): void {
  statusEl.textContent = STATUS_TEXT[state];
  statusEl.className = state === 'idle' ? '' : state;

  for (const button of ALL_BUTTONS) button.classList.add('hidden');

  const show = (...buttons: HTMLButtonElement[]) => {
    for (const button of buttons) button.classList.remove('hidden');
  };

  if (state === 'recording') {
    show(btnPause, btnStop);
  } else if (state === 'paused') {
    show(btnResume, btnStop);
  } else {
    show(btnStart);
    if (count > 0) show(btnView, btnClear);
  }

  stepCountEl.textContent = count === 1 ? '1 step captured' : `${count} steps captured`;
}

// ── State ────────────────────────────────────────────────────────────────────

interface PopupSnapshot {
  state: RecordingState;
  count: number;
}

async function readState(): Promise<PopupSnapshot> {
  const { recordingActive, recordingPaused, recordedSteps } = await chrome.storage.local.get([
    'recordingActive',
    'recordingPaused',
    'recordedSteps',
  ]);

  return {
    state: recordingActive ? (recordingPaused ? 'paused' : 'recording') : 'idle',
    count: Array.isArray(recordedSteps) ? recordedSteps.length : 0,
  };
}

async function refresh(): Promise<void> {
  const { state, count } = await readState();
  updateUI(state, count);
}

async function sendToTab(message: ContentRequest): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.warn('FlowSnap: could not message tab', err);
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

btnStart.addEventListener('click', () => {
  void (async () => {
    await chrome.storage.local.set({
      recordingActive: true,
      recordingPaused: false,
      recordedSteps: [],
    });
    await sendToTab({ type: 'START_RECORDING' });
    updateUI('recording', 0);
  })();
});

btnStop.addEventListener('click', () => {
  void (async () => {
    await chrome.storage.local.set({ recordingActive: false, recordingPaused: false });
    await sendToTab({ type: 'STOP_RECORDING' });
    await refresh();
  })();
});

btnPause.addEventListener('click', () => {
  void (async () => {
    await chrome.storage.local.set({ recordingPaused: true });
    await sendToTab({ type: 'PAUSE_RECORDING' });
    await refresh();
  })();
});

btnResume.addEventListener('click', () => {
  void (async () => {
    await chrome.storage.local.set({ recordingPaused: false });
    await sendToTab({ type: 'RESUME_RECORDING' });
    await refresh();
  })();
});

btnView.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

btnClear.addEventListener('click', () => {
  void (async () => {
    await sendToWorker({ type: 'CLEAR_STEPS' });
    await chrome.storage.local.set({
      recordedSteps: [],
      recordingActive: false,
      recordingPaused: false,
    });
    updateUI('idle', 0);
  })();
});

// ── MCP server URL ───────────────────────────────────────────────────────────

const mcpInput = el<HTMLInputElement>('mcp-url-input');
const mcpSave = el<HTMLButtonElement>('mcp-url-save');
const mcpStatus = el('mcp-url-status');

chrome.storage.sync.get({ mcpServerUrl: DEFAULT_MCP_URL }, (data) => {
  mcpInput.value = (data as { mcpServerUrl: string }).mcpServerUrl;
});

mcpSave.addEventListener('click', () => {
  const url = mcpInput.value.trim();
  if (!url) return;
  chrome.storage.sync.set({ mcpServerUrl: url }, () => {
    mcpStatus.textContent = 'Saved!';
    setTimeout(() => (mcpStatus.textContent = ''), 2000);
  });
});

// ── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relevant = ['recordedSteps', 'recordingActive', 'recordingPaused'];
  if (!relevant.some((key) => key in changes)) return;
  void refresh();
});

void refresh();
