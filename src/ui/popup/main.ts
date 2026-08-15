/**
 * Popup controller: recording state, button visibility, live step count.
 *
 * State changes are written to storage and nothing else. Every content script
 * watches storage, so a recording follows the user across tabs — messaging only
 * the active tab is what made recording silently stop the moment you switched.
 */

import { getLocal, setLocal, setSync } from '../../chrome/storage.js';
import { preflight, type RecordingTarget } from '../../features/recording/preflight.js';
import { DEFAULT_MCP_URL } from '../../shared/constants.js';
import { sendToWorker } from '../../shared/messages.js';
import type { RecordingState } from '../../shared/types.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`FlowSnap: missing #${id} in popup.html`);
  return node as T;
}

const statusEl = el('status');
const stepCountEl = el('step-count');
const targetEl = el('target');
const noticeEl = el('notice');
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

/** Whether the active tab can be recorded, resolved when the popup opens. */
let target: RecordingTarget | null = null;

function showNotice(text: string, kind: 'blocked' | 'error'): void {
  noticeEl.textContent = text;
  noticeEl.className = kind;
}

function hideNotice(): void {
  noticeEl.textContent = '';
  noticeEl.className = 'hidden';
}

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
    // Starting is only offered when there is somewhere to record.
    btnStart.disabled = target === null;
    if (count > 0) show(btnView, btnClear);
  }

  stepCountEl.textContent = count === 1 ? '1 step captured' : `${count} steps captured`;
}

// ── State ────────────────────────────────────────────────────────────────────

async function readState(): Promise<{ state: RecordingState; count: number }> {
  const stored = await getLocal(['recordingActive', 'recordingPaused', 'recordedSteps']);
  if (!stored.ok) return { state: 'idle', count: 0 };

  const { recordingActive, recordingPaused, recordedSteps } = stored.value;
  return {
    state: recordingActive ? (recordingPaused ? 'paused' : 'recording') : 'idle',
    count: Array.isArray(recordedSteps) ? recordedSteps.length : 0,
  };
}

/**
 * Surface the last failure the worker recorded. A capture that silently produced
 * no screenshot, or a write that hit the storage ceiling, is otherwise invisible.
 */
async function showLastError(): Promise<boolean> {
  const stored = await getLocal('lastError');
  if (!stored.ok) return false;

  const lastError = stored.value.lastError;
  // Only recent failures are worth interrupting for; an hour-old one is noise.
  if (!lastError || Date.now() - lastError.at > 60_000) return false;

  showNotice(lastError.message, 'error');
  return true;
}

async function refresh(): Promise<void> {
  const { state, count } = await readState();
  updateUI(state, count);
}

/** Resolve what the popup is pointing at, without touching the page. */
async function resolveTarget(): Promise<void> {
  const result = await preflight(false);

  if (result.ok) {
    target = result.value;
    targetEl.textContent = target.host || target.url;
    if (!(await showLastError())) hideNotice();
    return;
  }

  target = null;
  targetEl.textContent = '';
  showNotice(result.error.message, 'blocked');
}

// ── Actions ──────────────────────────────────────────────────────────────────

btnStart.addEventListener('click', () => {
  void (async () => {
    btnStart.disabled = true;

    // Inject now if needed: a tab opened before FlowSnap was installed has no
    // content script, and the old code reported success anyway.
    const ready = await preflight(true);
    if (!ready.ok) {
      target = null;
      showNotice(ready.error.message, 'blocked');
      await refresh();
      return;
    }

    target = ready.value;
    hideNotice();

    const written = await setLocal({
      recordingActive: true,
      recordingPaused: false,
      recordedSteps: [],
      lastError: null,
    });
    if (!written.ok) {
      showNotice(written.error.message, 'error');
      await refresh();
      return;
    }

    updateUI('recording', 0);
  })();
});

btnStop.addEventListener('click', () => {
  void (async () => {
    await setLocal({ recordingActive: false, recordingPaused: false });
    await refresh();
  })();
});

btnPause.addEventListener('click', () => {
  void (async () => {
    await setLocal({ recordingPaused: true });
    await refresh();
  })();
});

btnResume.addEventListener('click', () => {
  void (async () => {
    await setLocal({ recordingPaused: false });
    await refresh();
  })();
});

btnView.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

btnClear.addEventListener('click', () => {
  void (async () => {
    await sendToWorker({ type: 'CLEAR_STEPS' });
    await setLocal({
      recordedSteps: [],
      recordingActive: false,
      recordingPaused: false,
      lastError: null,
    });
    hideNotice();
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
  void (async () => {
    const url = mcpInput.value.trim();
    if (!url) return;
    const written = await setSync({ mcpServerUrl: url });
    mcpStatus.textContent = written.ok ? 'Saved!' : "Couldn't save";
    setTimeout(() => (mcpStatus.textContent = ''), 2000);
  })();
});

// ── Live updates ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if ('lastError' in changes) void showLastError();

  const relevant = ['recordedSteps', 'recordingActive', 'recordingPaused'];
  if (relevant.some((key) => key in changes)) void refresh();
});

void (async () => {
  await refresh();
  await resolveTarget();
  await refresh();
})();
