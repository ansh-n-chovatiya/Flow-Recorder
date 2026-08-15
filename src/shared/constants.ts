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

/** Response and request bodies are truncated to this before leaving the page. */
export const BODY_CAP = 51_200;

/** Bodies longer than this are replaced by an inferred schema in exports. */
export const SCHEMA_THRESHOLD = 1024;

/** Where recorded flows are POSTed when the MCP integration is enabled. */
export const DEFAULT_MCP_URL = 'http://127.0.0.1:7734/flows';

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
