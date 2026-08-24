/**
 * Settings controller.
 *
 * Structural decision E: settings leave the popup. They used to live in a
 * disclosure triangle under the primary recording controls, which is how a
 * developer's server address ended up on the surface a user opens to press
 * Record.
 */

import {
  bytesInUse,
  getAllLocal,
  getLocal,
  getSync,
  removeLocal,
  setLocal,
  setSync,
} from '../../chrome/storage.js';
import { checkMcp } from '../../features/mcp/health.js';
import { EDITORS } from '../../core/react/editor.js';
import { DEFAULT_MCP_URL, REACT_SETTING_DEFAULTS } from '../../shared/constants.js';
import {
  savedFlowKey,
  savedFlowReactKey,
  type FlowMeta,
  type ThemePreference,
} from '../../shared/types.js';
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

  reactCapture: el<HTMLInputElement>('react-capture'),
  reactResolve: el<HTMLInputElement>('react-resolve'),
  projectRoot: el<HTMLInputElement>('project-root'),
  editor: el<HTMLSelectElement>('editor'),
  editorCustom: el('editor-custom'),
  editorTemplate: el<HTMLInputElement>('editor-template'),

  mcpUrl: el<HTMLInputElement>('mcp-url'),
  mcpTest: el<HTMLButtonElement>('mcp-test'),
  mcpResult: el('mcp-result'),
  autoSend: el<HTMLInputElement>('mcp-autosend'),
  autoSendWarning: el('autosend-warning'),

  storageUsed: el('storage-used'),
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

// ── React components ─────────────────────────────────────────────────────────

/**
 * Resolution and the project root do nothing without a captured component, so
 * they follow the master toggle rather than sitting there looking as though
 * they still apply. Their stored values are left alone: switching capture back
 * on restores whatever was chosen before, instead of silently resetting it.
 */
function markCapture(enabled: boolean): void {
  dom.reactResolve.disabled = !enabled;
  dom.projectRoot.disabled = !enabled;
  dom.editor.disabled = !enabled;
  dom.editorTemplate.disabled = !enabled;
}

/** The template field is only asked for when no built-in editor was chosen. */
function markEditor(choice: string): void {
  dom.editorCustom.classList.toggle('hidden', choice !== 'custom');
}

// The list is built from `EDITORS` rather than written out in the markup, so
// this extension and its sibling cannot drift into offering different editors.
for (const [value, { label }] of Object.entries(EDITORS)) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  dom.editor.append(option);
}

dom.editor.addEventListener('change', () => {
  const choice = dom.editor.value;
  markEditor(choice);

  void setSync({ editor: choice }).then((written) => {
    if (!written.ok) showToast({ message: written.error.message, tone: 'danger' });
  });
});

dom.editorTemplate.addEventListener('change', () => {
  const template = dom.editorTemplate.value.trim();
  dom.editorTemplate.value = template;

  void setSync({ customEditorTemplate: template }).then((written) => {
    if (!written.ok) showToast({ message: written.error.message, tone: 'danger' });
  });
});

dom.reactCapture.addEventListener('change', () => {
  const enabled = dom.reactCapture.checked;
  markCapture(enabled);

  void setSync({ reactCapture: enabled }).then((written) => {
    if (written.ok) return;
    // Reflect the truth: the setting did not change, so neither should the UI.
    dom.reactCapture.checked = !enabled;
    markCapture(!enabled);
    showToast({ message: written.error.message, tone: 'danger' });
  });
});

dom.reactResolve.addEventListener('change', () => {
  const enabled = dom.reactResolve.checked;

  void setSync({ reactResolve: enabled }).then((written) => {
    if (written.ok) return;
    dom.reactResolve.checked = !enabled;
    showToast({ message: written.error.message, tone: 'danger' });
  });
});

/**
 * Saved on blur, like the MCP address above it.
 *
 * The trailing slash goes because every path built from this joins one on, and
 * `/repo//src/App.tsx` is a path no editor opens.
 */
dom.projectRoot.addEventListener('change', () => {
  const root = dom.projectRoot.value.trim().replace(/[/\\]+$/, '');
  dom.projectRoot.value = root;

  void setSync({ projectRoot: root }).then((written) => {
    if (!written.ok) showToast({ message: written.error.message, tone: 'danger' });
  });
});

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

  // `null` is Chrome refusing to measure, not an empty store. Printing "0 B"
  // for it would tell somebody with a full library that they have room to
  // spare, which is the one thing this figure exists to answer.
  dom.storageUsed.textContent = used === null ? 'Unknown' : formatBytes(used);

  const stored = await getLocal(['savedFlowsMeta', 'recordedSteps']);
  savedFlows = stored.ok && Array.isArray(stored.value.savedFlowsMeta)
    ? stored.value.savedFlowsMeta
    : [];

  const steps = savedFlows.reduce((total, flow) => total + flow.stepCount, 0);
  dom.flowsSummary.textContent =
    savedFlows.length === 0
      ? 'No saved flows.'
      : `${savedFlows.length} saved ${savedFlows.length === 1 ? 'flow' : 'flows'}, ${steps} steps in total. The flow you are recording now is not included.`;

  // Per-step is what lets someone predict the cost of the next recording.
  dom.storageDetail.textContent =
    used !== null && steps > 0
      ? `About ${formatBytes(Math.round(used / steps))} per step, mostly screenshots.`
      : '';

  /*
   * Enabled even with an empty index, because the index is not the whole story.
   *
   * The sweep on the other side of this button removes orphaned `savedFlow_*`
   * keys as well as the ones the index names — and orphans are exactly what an
   * empty index cannot see. Disabling on `savedFlows.length === 0` left the only
   * control that can reclaim that space switched off precisely when it was the
   * one thing left to do. Gated on there being *something* stored instead: the
   * byte count is already read for the line above, so this costs nothing.
   */
  dom.deleteFlows.disabled = savedFlows.length === 0 && !used;
}

dom.deleteFlows.addEventListener('click', () => {
  dom.deleteBody.textContent =
    savedFlows.length === 0
      ? 'The library is already empty. Any flow data left behind by a failed save will be deleted. This cannot be undone.'
      : savedFlows.length === 1
        ? 'The one saved flow, and its screenshots, will be deleted. This cannot be undone.'
        : `All ${savedFlows.length} saved flows, and their screenshots, will be deleted. This cannot be undone.`;
  dom.deleteDialog.showModal();
});

dom.deleteDialog.addEventListener('close', () => {
  if (dom.deleteDialog.returnValue !== 'delete') return;

  void (async () => {
    const listed: string[] = savedFlows.flatMap((flow) => [
      savedFlowKey(flow.id),
      savedFlowReactKey(flow.id),
    ]);

    /*
     * Sweep for orphans as well as for what the index names.
     *
     * Deriving the removal list from `savedFlowsMeta` alone is what made this
     * button unable to do what it says. A save writes the steps first and the
     * index second, so an index write that failed leaves a `savedFlow_<id>` key
     * the index never carried — and since ids are `flow_<ms>` and never recur,
     * nothing will ever overwrite it either. Megabytes, in a 10 MB store, that
     * no screen lists and no button could free.
     *
     * The read costs the whole area, so it happens here, on a button the user
     * pressed and confirmed, rather than on every refresh of this page.
     */
    const all = await getAllLocal();
    const orphans = all.ok
      ? Object.keys(all.value).filter(
          (key) =>
            (key.startsWith('savedFlow_') || key.startsWith('savedFlowReact_')) &&
            !listed.includes(key),
        )
      : [];

    const removed = await removeLocal([...listed, ...orphans]);
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

  const settings = await getSync({
    mcpServerUrl: DEFAULT_MCP_URL,
    mcpAutoSend: false,
    ...REACT_SETTING_DEFAULTS,
  });
  if (settings.ok) {
    dom.mcpUrl.value = settings.value.mcpServerUrl;
    dom.autoSend.checked = settings.value.mcpAutoSend;
    dom.autoSendWarning.classList.toggle('hidden', !settings.value.mcpAutoSend);

    dom.reactCapture.checked = settings.value.reactCapture;
    dom.reactResolve.checked = settings.value.reactResolve;
    dom.projectRoot.value = settings.value.projectRoot;
    // An editor removed from `EDITORS` since it was chosen falls back to the
    // default rather than leaving the select showing whatever is first.
    dom.editor.value = settings.value.editor in EDITORS ? settings.value.editor : 'vscode';
    dom.editorTemplate.value = settings.value.customEditorTemplate;
    markCapture(settings.value.reactCapture);
    markEditor(dom.editor.value);
  }

  const { version } = chrome.runtime.getManifest();
  dom.version.textContent = `FlowSnap ${version}`;

  await refreshStorage();
})();
