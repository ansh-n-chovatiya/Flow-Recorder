/** Tunables shared across the worker, content script, injected agent and UI. */

/**
 * Runaway guard, not a product limit — stopping a recording mid-task makes the
 * user redo everything.
 *
 * Every capture rewrites the whole `recordedSteps` key, so a step costs more the
 * longer the flow: measured against real screenshot sizes, ~8 ms at 30 steps,
 * 43 ms at 200, 106 ms at 500 — all inside `CAPTURE_MIN_INTERVAL_MS`. Going
 * higher would mean splitting the array into a key per step first.
 */
export const MAX_STEPS = 500;

/** Where the popup mentions export weight. Not a countdown to `MAX_STEPS`. */
export const WARN_STEPS = 150;

/**
 * How long to wait after an interaction before screenshotting, so the page has
 * painted its response (a menu opening, a field filling). Only used when there
 * is no pre-capture to fall back on — see PRECAPTURE_TTL_MS.
 */
export const SETTLE_DELAY_MS = 150;

/**
 * Chrome allows roughly two `captureVisibleTab` calls per second and rejects the
 * rest. Captures are spaced by this instead of being fired and lost.
 */
export const CAPTURE_MIN_INTERVAL_MS = 550;

/**
 * How long a pre-capture stays usable.
 *
 * A click on a link or a submit button navigates before the settle delay
 * elapses, so the screenshot used to show the *destination* while the step text
 * described the element that was clicked, with a highlight box positioned for a
 * layout that no longer existed. For those interactions the screenshot is taken
 * on pointerdown instead, and claimed by the click that follows.
 */
export const PRECAPTURE_TTL_MS = 3000;

/**
 * How long to wait for a repaint before giving up and capturing anyway.
 *
 * The recording indicator is removed from the page before every screenshot, and
 * the removal has to be painted or the capture still contains it. In a
 * background tab no frame is ever painted, so the wait needs a ceiling.
 */
export const PAINT_TIMEOUT_MS = 50;

/*
 * No storage quota constant: the manifest asks for `unlimitedStorage`, so the
 * only ceiling is the user's disk. A genuinely full disk still surfaces as
 * `STORAGE_QUOTA` from `chrome/storage.ts`, handled where it happens.
 */

/**
 * How recent a stored failure has to be for the popup to interrupt with it. An
 * hour-old capture error is noise; one from thirty seconds ago is the reason the
 * user just opened the popup.
 */
export const ERROR_TTL_MS = 60_000;

/** JPEG quality for captured screenshots — legible text at a third of PNG size. */
export const SCREENSHOT_QUALITY = 60;

/** Delay before an `input` event is committed as a step, so typing is one step. */
export const INPUT_DEBOUNCE_MS = 800;

/**
 * How long to let a single-page app render its new route before screenshotting.
 *
 * The URL changes first and the framework paints afterwards, so a capture in the
 * same task photographs the route the user has just left.
 */
export const SPA_SETTLE_MS = 250;

/**
 * How long to wait for a reloading tab to come back before recording anyway.
 *
 * Only a backstop: a page that never fires `complete` — a hung request, a
 * download — should not leave the user staring at a Start button that does
 * nothing.
 */
export const RELOAD_TIMEOUT_MS = 10_000;

/** Response and request bodies are truncated to this before leaving the page. */
export const BODY_CAP = 51_200;

/** Bodies longer than this are replaced by an inferred schema in exports. */
export const SCHEMA_THRESHOLD = 1024;

/** Where recorded flows are POSTed when the MCP integration is enabled. */
export const DEFAULT_MCP_URL = 'http://127.0.0.1:7734/flows';

/**
 * The version of the `FlowPayload` wire format.
 *
 * Bump when a field the server reads changes meaning or disappears — adding one
 * is not a bump, since the server ignores what it does not know. The two sides
 * ship separately (the extension as a zip, the server to npm), so this is the
 * only thing that tells a server which shape it has been handed.
 */
export const FLOW_SCHEMA_VERSION = 1;

/**
 * `localStorage` key holding a copy of the theme preference.
 *
 * `chrome.storage.sync` is the authority, but it is asynchronous and an
 * extension page cannot run an inline script to beat first paint. This mirror is
 * read synchronously so an explicit theme choice does not flash the other one.
 */
export const THEME_MIRROR_KEY = 'flowsnap.theme';

/** Marks messages the injected agent posts to the content script. */
export const AGENT_MESSAGE_SOURCE = 'page-injector';

/** DOM id of the on-page recording indicator. */
export const INDICATOR_ID = 'flowsnap-indicator';

/** Badge colour while recording. */
export const BADGE_COLOR = '#FF3B30';

/** Highlight box baked into screenshots. */
export const ANNOTATION_STROKE = '#FF3B30';
export const ANNOTATION_FILL = 'rgba(255, 59, 48, 0.08)';

// ── React source attribution ─────────────────────────────────────────────────

/** Marks control messages the content script posts *to* the MAIN-world agent. */
export const CONTROL_MESSAGE_SOURCE = 'flowsnap-control';

/**
 * How many components of the chain above a clicked element are kept, counting
 * outwards from the element.
 *
 * Upstream's picker keeps 50 because it draws a browsable tree. A flow wants to
 * say where a click landed, and the far end of a deep tree is `App` wrapped in
 * nine providers — nothing an AI can use, at the cost of a `toString()` and a
 * hash each.
 */
export const MAX_COMPONENT_CHAIN = 12;

/** Hard cap on raw fibers visited while walking (cycle guard). */
export const MAX_FIBER_WALK = 2000;

/**
 * How long the content script waits for the component chain before writing the
 * step without it.
 *
 * The chain crosses from the MAIN world by `postMessage`, which is a task, so it
 * can land after the click handler has already run. The wait is a ceiling, not a
 * delay: the message has normally arrived before this is even awaited, and the
 * step then still passes through `afterPaint()` and the worker's 150 ms settle.
 * A step is never held hostage to it — no chain simply means no chain.
 */
export const REACT_CHAIN_TIMEOUT_MS = 50;

/** Chains held for a step that has not asked for them yet. */
export const REACT_BUFFER_SIZE = 16;

/**
 * How long an unclaimed chain stays in the buffer.
 *
 * Some interactions are captured by the agent and then deliberately dropped by
 * the recorder — a click on a `<select>` is covered by the `change` step
 * instead. Those chains are never claimed, and this is what stops them
 * accumulating.
 */
export const REACT_BUFFER_TTL_MS = 5000;

/** How long a chain computed on `pointerdown` may be reused by the `click`. */
export const REACT_PREWARM_TTL_MS = 1000;

/**
 * How many interactions may fail to find React before the agent gives up on a
 * document and detaches.
 *
 * Not one: an SPA can mount React after the first interaction, and a click can
 * land outside the React root on a page that is otherwise entirely React.
 */
export const REACT_PROBE_ATTEMPTS = 3;

/**
 * Defaults for the three React settings.
 *
 * Three contexts read them independently — the content script gates capture,
 * the worker gates resolution, the settings page renders both — and a default
 * that disagreed between them would show a switch that does not match what is
 * actually happening. Both toggles default on: capture costs nothing on a page
 * that is not React, and resolution's fetches are cache-first and never leave
 * the machine.
 */
export const REACT_SETTING_DEFAULTS: {
  reactCapture: boolean;
  reactResolve: boolean;
  projectRoot: string;
  editor: string;
  customEditorTemplate: string;
} = {
  reactCapture: true,
  reactResolve: true,
  projectRoot: '',
  // VS Code, because its scheme is the one most other editors chose to answer
  // to as well. Nothing is opened until a project root is set regardless.
  editor: 'vscode',
  customEditorTemplate: '',
};

/** Length of the high-specificity needle taken from the head of `fn.toString()`. */
export const NEEDLE_HEAD_LEN = 200;

/** Length of the secondary needle taken from the function body. */
export const NEEDLE_BODY_LEN = 80;

/** Shortest needle worth searching; below this, false positives dominate. */
export const MIN_NEEDLE_LEN = 12;

/** Function sources longer than this are sliced before a needle is built. */
export const MAX_FN_SOURCE_LEN = 65_536;

/**
 * Distinct components recorded per flow.
 *
 * A runaway guard for a page that renders thousands of one-off components, not
 * a product limit — a real flow touches a handful. Hitting it is recorded in the
 * table rather than passed over in silence.
 */
export const MAX_COMPONENTS_PER_FLOW = 128;

/**
 * Distinct occurrences of a needle worth counting.
 *
 * Above one the match is ambiguous and the path may be the wrong one; the exact
 * number past a handful changes nothing anybody would do about it.
 */
export const MAX_MATCHES_TRACKED = 5;

/** Scripts larger than this are assets or data, not code worth scanning. */
export const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;

/**
 * Source maps larger than this are skipped outright.
 *
 * The streaming decode means a big map costs time rather than memory, but the
 * JSON parse ahead of it does not: the string and its parsed form both sit in
 * the worker's heap at once, and an MV3 worker that overruns is killed with no
 * warning and no error to report.
 */
export const MAX_MAP_BYTES = 64 * 1024 * 1024;

/** Bundles fetched at once while resolving. */
export const RESOLVE_CONCURRENCY = 4;

/**
 * Active resolution work permitted per flow.
 *
 * A ceiling for a pathological site — hundreds of chunks, no maps, nothing ever
 * matching — not a product limit. Whatever is cut off is recorded as `skipped`
 * with a sentence rather than left looking unresolvable.
 */
export const MAX_RESOLVE_MS_PER_FLOW = 30_000;

/**
 * Quiet time after a step before resolution runs.
 *
 * Resolution happens *during* recording, on idle, because the page is still open
 * and its bundles are still warm in the HTTP cache. Waiting for Stop would mean
 * fetching bundles for a tab that may be closed, from a session that may have
 * expired. Long enough that a burst of clicks resolves once, not once each.
 */
export const RESOLVE_DEBOUNCE_MS = 1500;

/** Bundle texts held in the worker's cache at once, and their total size. */
export const BUNDLE_CACHE_ENTRIES = 24;
export const BUNDLE_CACHE_BYTES = 48 * 1024 * 1024;

/**
 * Script URLs remembered per origin.
 *
 * A code-split app can legitimately load a hundred chunks; a page that
 * generates script URLs in a loop is a runaway, and searching more than this
 * would cost more than the answer is worth.
 */
export const MAX_SCRIPTS_PER_ORIGIN = 200;

/**
 * How long a blank launcher tab is given to hand off to an editor.
 *
 * Chrome losing focus is the reliable signal that the handoff happened, so this
 * only covers the case where nothing ever launched — long enough that the
 * protocol prompt is not dismissed out from under the user while they read it.
 */
export const LAUNCHER_TAB_TIMEOUT_MS = 20_000;
