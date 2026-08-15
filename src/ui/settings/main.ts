/**
 * Settings controller.
 *
 * Structural decision E: settings leave the popup. They used to live in a
 * disclosure triangle under the primary recording controls, which is how a
 * developer's server address ended up on the surface a user opens to press
 * Record.
 */

import { bytesInUse, getLocal, getSync, removeLocal, setLocal, setSync } from '../../chrome/storage.js';
import { checkMcp } from '../../features/mcp/health.js';
import {
  DEFAULT_MCP_URL,
  STORAGE_QUOTA,
  STORAGE_WARN_RATIO,
} from '../../shared/constants.js';
import { savedFlowKey, type FlowMeta, type ThemePreference } from '../../shared/types.js';
import { formatBytes } from '../format.js';
import { hydrateIcons, icon } from '../icons.js';
import { initTheme, loadTheme, saveTheme } from '../theme.js';
import { showToast } from '../toast.js';

initTheme();
hydrateIcons();

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`FlowSnap: missing #${id} in settings.html`);
  return node as T;
}

const dom = {
  back: el<HTMLButtonElement>('back'),

  themeOptions: [...document.querySelectorAll<HTMLButtonElement>('[data-theme-option]')],

  mcpUrl: el<HTMLInputElement>('mcp-url'),
  mcpTest: el<HTMLButtonElement>('mcp-test'),
  mcpResult: el('mcp-result'),
  autoSend: el<HTMLInputElement>('mcp-autosend'),
  autoSendWarning: el('autosend-warning'),

  storageUsed: el('storage-used'),
  storageQuota: el('storage-quota'),
  storageMeter: el('storage-meter'),
  storageFill: el('storage-fill'),
  storageDetail: el('storage-detail'),

  flowsSummary: el('flows-summary'),
  deleteFlows: el<HTMLButtonElement>('delete-flows'),
  deleteDialog: el<HTMLDialogElement>('delete-dialog'),
  deleteBody: el('delete-body'),

  version: el('version'),
};

// ── Leaving ──────────────────────────────────────────────────────────────────

/**
 * `openOptionsPage` opens settings in a tab of its own, so there is usually no
 * history to go back to and a plain `history.back()` would do nothing at all.
 * The library is the destination that always exists; going back is only right
 * when the user actually navigated here from somewhere.
 */
dom.back.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = chrome.runtime.getURL('viewer.html');
});

// ── Appearance ───────────────────────────────────────────────────────────────

function markTheme(active: ThemePreference): void {
  for (const button of dom.themeOptions) {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === active));
  }
}

for (const button of dom.themeOptions) {
  button.addEventListener('click', () => {
    const choice = button.dataset.themeOption as ThemePreference;
    markTheme(choice);
    void saveTheme(choice);
  });
}

// ── MCP ──────────────────────────────────────────────────────────────────────

function setResult(state: 'idle' | 'checking' | 'ok' | 'error', message: string): void {
  dom.mcpResult.dataset.state = state;
  dom.mcpResult.replaceChildren();

  if (state === 'checking') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    dom.mcpResult.append(spinner);
  } else if (state === 'ok') {
    dom.mcpResult.append(icon('circle-check'));
  } else if (state === 'error') {
    dom.mcpResult.append(icon('triangle-alert'));
  }

  if (message) {
    const text = document.createElement('span');
    text.textContent = message;
    dom.mcpResult.append(text);
  }
}

/** Saved on blur rather than behind a Save button — there is nothing to batch. */
dom.mcpUrl.addEventListener('change', () => {
  const url = dom.mcpUrl.value.trim() || DEFAULT_MCP_URL;
  dom.mcpUrl.value = url;
  setResult('idle', '');

  void setSync({ mcpServerUrl: url }).then((written) => {
    if (!written.ok) showToast({ message: written.error.message, tone: 'danger' });
  });
});

dom.mcpTest.addEventListener('click', () => {
  void (async () => {
    const url = dom.mcpUrl.value.trim() || DEFAULT_MCP_URL;
    dom.mcpTest.disabled = true;
    setResult('checking', 'Checking…');

    const health = await checkMcp(url);
    dom.mcpTest.disabled = false;

    if (health.ok) setResult('ok', `Connected · ${health.value.service} (${health.value.mode})`);
    else setResult('error', health.error.message);
  })();
});

dom.autoSend.addEventListener('change', () => {
  const enabled = dom.autoSend.checked;
  dom.autoSendWarning.classList.toggle('hidden', !enabled);

  void setSync({ mcpAutoSend: enabled }).then((written) => {
    if (written.ok) return;
    // Reflect the truth: the setting did not change, so neither should the UI.
    dom.autoSend.checked = !enabled;
    dom.autoSendWarning.classList.toggle('hidden', enabled);
    showToast({ message: written.error.message, tone: 'danger' });
  });
});

// ── Storage ──────────────────────────────────────────────────────────────────

let savedFlows: FlowMeta[] = [];

async function refreshStorage(): Promise<void> {
  const used = await bytesInUse();
  const ratio = Math.min(used / STORAGE_QUOTA, 1);

  dom.storageUsed.textContent = formatBytes(used);
  dom.storageQuota.textContent = formatBytes(STORAGE_QUOTA);
  dom.storageFill.style.width = `${Math.round(ratio * 100)}%`;
  dom.storageMeter.dataset.level = ratio >= 1 ? 'full' : ratio >= STORAGE_WARN_RATIO ? 'warn' : 'ok';
  dom.storageDetail.textContent = `${Math.round(ratio * 100)}% used`;

  const stored = await getLocal(['savedFlowsMeta', 'recordedSteps']);
  savedFlows = stored.ok && Array.isArray(stored.value.savedFlowsMeta)
    ? stored.value.savedFlowsMeta
    : [];

  const steps = savedFlows.reduce((total, flow) => total + flow.stepCount, 0);
  dom.flowsSummary.textContent =
    savedFlows.length === 0
      ? 'No saved flows.'
      : `${savedFlows.length} saved ${savedFlows.length === 1 ? 'flow' : 'flows'}, ${steps} steps in total. The flow you are recording now is not included.`;

  dom.deleteFlows.disabled = savedFlows.length === 0;
}

dom.deleteFlows.addEventListener('click', () => {
  dom.deleteBody.textContent =
    savedFlows.length === 1
      ? 'The one saved flow, and its screenshots, will be deleted. This cannot be undone.'
      : `All ${savedFlows.length} saved flows, and their screenshots, will be deleted. This cannot be undone.`;
  dom.deleteDialog.showModal();
});

dom.deleteDialog.addEventListener('close', () => {
  if (dom.deleteDialog.returnValue !== 'delete') return;

  void (async () => {
    const removed = await removeLocal(savedFlows.map((flow) => savedFlowKey(flow.id)));
    if (!removed.ok) {
      showToast({ message: removed.error.message, tone: 'danger' });
      return;
    }

    // The index is cleared second: if the removal above failed halfway, the
    // flows that survive are still listed rather than becoming unreachable.
    const cleared = await setLocal({ savedFlowsMeta: [] });
    if (!cleared.ok) {
      showToast({ message: cleared.error.message, tone: 'danger' });
      return;
    }

    const count = savedFlows.length;
    await refreshStorage();
    showToast({
      message: `Deleted ${count} ${count === 1 ? 'flow' : 'flows'}.`,
      tone: 'success',
    });
  })();
});

// ── Start ────────────────────────────────────────────────────────────────────

void (async () => {
  markTheme(await loadTheme());

  const settings = await getSync({ mcpServerUrl: DEFAULT_MCP_URL, mcpAutoSend: false });
  if (settings.ok) {
    dom.mcpUrl.value = settings.value.mcpServerUrl;
    dom.autoSend.checked = settings.value.mcpAutoSend;
    dom.autoSendWarning.classList.toggle('hidden', !settings.value.mcpAutoSend);
  }

  const { version } = chrome.runtime.getManifest();
  dom.version.textContent = `FlowSnap ${version}`;

  await refreshStorage();
})();
