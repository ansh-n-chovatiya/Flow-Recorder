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
import type { OpenEditorResponse, WorkerRequest } from '../shared/messages.js';
import { isEditorScheme } from '../core/react/editor.js';
import {
  BADGE_COLOR,
  DEFAULT_MCP_URL,
  LAUNCHER_TAB_TIMEOUT_MS,
  MAX_STEPS,
  PRECAPTURE_TTL_MS,
  REACT_SETTING_DEFAULTS,
  RESOLVE_DEBOUNCE_MS,
  SETTLE_DELAY_MS,
} from '../shared/constants.js';
import { flowError, type FlowError } from '../shared/errors.js';
import type { BoundingBox, DraftStep, Step } from '../shared/types.js';
import type { CapturedComponent } from '../shared/messages.js';
import { mergeComponents } from '../core/react/table.js';
import { mergeScripts } from '../features/react/inventory.js';
import { clearResolverCaches, resolvePending } from '../features/react/resolver.js';

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
  components?: CapturedComponent[],
  componentsPageUrl?: string,
): Promise<void> {
  // A pre-capture is already the right frame — waiting would only let the page
  // navigate further away from the moment being described.
  const preShot = claimPrecapture(sender.tab?.id);
  if (!preShot) await delay(SETTLE_DELAY_MS);

  const stored = await getLocal([
    'recordedSteps',
    'recordingActive',
    'reactComponents',
    'reactNeedles',
  ]);
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

  const merged = components?.length
    ? mergeComponents(
        components,
        componentsPageUrl ?? step.url,
        stored.value.reactComponents ?? {},
        stored.value.reactNeedles ?? {},
      )
    : null;

  const written = await setLocal({
    recordedSteps,
    // Only when something actually changed: a flow that clicks one button forty
    // times would otherwise rewrite an identical table forty times.
    ...(merged?.changed ? { reactComponents: merged.table, reactNeedles: merged.needles } : {}),
  });
  if (!written.ok) {
    await reportError(written.error);
    return;
  }

  updateBadge(recordedSteps.length);

  if (merged?.changed) scheduleResolve();
}

// ── React source resolution ──────────────────────────────────────────────────

/** Serialises passes, so two never write the component table at once. */
let resolveQueue: Promise<void> = Promise.resolve();
let resolveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Resolves whatever is pending, and writes back only what the resolver owns.
 *
 * `reactComponents` and `reactNeedles` are read and written here and nowhere
 * else that runs concurrently — `recordedSteps` is deliberately not touched,
 * because the capture queue rewrites it wholesale and two writers on one key
 * lose each other's updates.
 */
async function runResolve(requestedFinal: boolean): Promise<void> {
  const stored = await getLocal([
    'reactComponents',
    'reactNeedles',
    'reactScripts',
    'recordingActive',
  ]);
  if (!stored.ok) return;

  /*
   * A final pass writes off whatever is still pending as `skipped` — "the flow
   * finished before this could be looked up". While a recording is live that is
   * simply untrue, and the caller cannot always know: sending from the review
   * tab looks the same whether or not the tab behind it is still capturing. The
   * state lives here, so the rule is enforced here rather than at four callers.
   */
  const final = requestedFinal && !stored.value.recordingActive;

  const needles = stored.value.reactNeedles ?? {};
  const components = stored.value.reactComponents ?? {};
  if (Object.keys(needles).length === 0 && !final) return;

  // A failed read leaves resolution on, matching the setting's own default: a
  // storage hiccup should not quietly switch a feature off.
  const settings = await getSync({ reactResolve: REACT_SETTING_DEFAULTS.reactResolve });
  const disabled = settings.ok && !settings.value.reactResolve;

  const result = await resolvePending({
    components,
    needles,
    scripts: stored.value.reactScripts ?? {},
    final,
    disabled,
  });

  if (!result.changed) return;

  const written = await setLocal({
    reactComponents: result.components,
    reactNeedles: result.needles,
  });
  if (!written.ok) await reportError(written.error);
}

function enqueueResolve(final: boolean): Promise<void> {
  resolveQueue = resolveQueue.then(() =>
    runResolve(final).catch((error: unknown) =>
      // A failed pass costs some components their path and nothing else; the
      // needles are still in storage and the next trigger retries them.
      console.warn('FlowSnap: component resolution failed', error),
    ),
  );
  return resolveQueue;
}

/**
 * Resolution runs *during* recording, on idle, rather than only at the end.
 *
 * The page is still open, so its bundles are certain to be fetchable and warm
 * in the HTTP cache — after the tab closes, a private or cookie-gated bundle may
 * not be. It also means most components are already resolved by the time anyone
 * presses Stop.
 */
function scheduleResolve(): void {
  if (resolveTimer !== null) clearTimeout(resolveTimer);
  resolveTimer = setTimeout(() => {
    resolveTimer = null;
    void enqueueResolve(false);
  }, RESOLVE_DEBOUNCE_MS);
}

// ── Opening a file in an editor ──────────────────────────────────────────────

/**
 * Launches an editor deep link on the user's behalf.
 *
 * The viewer cannot: an extension page is not allowed to navigate itself to a
 * custom scheme. The scheme is checked again here even though the viewer only
 * ever offers links that already passed — this is the side that actually opens
 * a tab, and a settings field that could produce `https://…` would otherwise be
 * a way to make the extension open any page it likes.
 */
async function openEditor(url: string): Promise<OpenEditorResponse> {
  if (!isEditorScheme(url)) return { ok: false, error: 'Not an editor link.' };

  try {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id !== undefined) closeWhenLaunched(tab.id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Disposes of the blank launcher tab once it has done its job.
 *
 * Timing alone cannot decide this: while Chrome's "open this application?"
 * prompt is up, the tab looks exactly as it does when the launch has already
 * happened — so a fixed delay either dismisses the prompt before it can be
 * answered, or leaves blank tabs behind. Chrome losing focus means the editor
 * took over, which is the signal. The timeout only covers a launch that never
 * happened at all.
 */
function closeWhenLaunched(tabId: number): void {
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    void chrome.tabs.remove(tabId).catch(() => {
      /* already closed by the user */
    });
  };

  const onFocusChanged = (windowId: number): void => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) close();
  };

  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  const timer = setTimeout(close, LAUNCHER_TAB_TIMEOUT_MS);
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

  // The last chance while the page is still open and its bundles still cached.
  // Not `final`: the user may sit in the review tab for a minute and press Send,
  // which sweeps again, and calling anything skipped this early would be wrong.
  if (resolveTimer !== null) {
    clearTimeout(resolveTimer);
    resolveTimer = null;
  }
  void enqueueResolve(false);

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
      const { step, elementBox, dpr, components, componentsPageUrl } = message;
      // Enqueue so captures run one at a time. A rejected step is swallowed so
      // one failure cannot break the chain for later steps.
      captureQueue = captureQueue.then(() =>
        captureAndSave(step, elementBox, dpr, sender, components, componentsPageUrl).catch((error: unknown) =>
          console.error('FlowSnap: captureAndSave rejected', error),
        ),
      );
      // Resolve immediately — the caller only needs to know the request landed,
      // and waiting for the queue would hold the page's indicator hidden for as
      // long as the backlog takes.
      sendResponse({ ok: true });
      return true;
    }

    case 'REACT_META': {
      // Written once per recording, and never merged with a later contradiction:
      // a flow that visits a React page and then a plain one was still recorded
      // against React, and saying otherwise would lose that.
      void getLocal('reactMeta').then((stored) => {
        if (stored.ok && stored.value.reactMeta?.detected) {
          sendResponse({ ok: true });
          return;
        }
        void setLocal({ reactMeta: message.meta }).then((written) =>
          sendResponse({ ok: written.ok }),
        );
      });
      return true;
    }

    case 'REACT_SCRIPTS': {
      // `sender.url` is Chrome's word for where the message came from; the
      // page's own claim is only the fallback for a frame that has none.
      const pageUrl = sender.url ?? message.pageUrl;
      void getLocal('reactScripts').then((stored) => {
        const merged = mergeScripts(stored.ok ? (stored.value.reactScripts ?? {}) : {}, pageUrl, message.urls);
        if (!merged.changed) {
          sendResponse({ ok: true });
          return;
        }
        void setLocal({ reactScripts: merged.scripts }).then((written) => {
          // A chunk that has only just loaded may be the one a component nobody
          // could find lives in, so this is worth a pass of its own.
          if (written.ok) scheduleResolve();
          sendResponse({ ok: written.ok });
        });
      });
      return true;
    }

    case 'RESOLVE_COMPONENTS': {
      if (resolveTimer !== null) {
        clearTimeout(resolveTimer);
        resolveTimer = null;
      }
      void enqueueResolve(message.final).then(() => sendResponse({ ok: true }));
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
      clearResolverCaches();
      void setLocal({
        recordedSteps: [],
        recordingActive: false,
        recordingPaused: false,
        reactComponents: {},
        reactNeedles: {},
        reactScripts: {},
        reactMeta: null,
      }).then((written) => {
        updateBadge(0);
        sendResponse({ ok: written.ok });
      });
      return true;
    }

    case 'OPEN_EDITOR': {
      void openEditor(message.url).then(sendResponse);
      return true;
    }

    default:
      return;
  }
});
