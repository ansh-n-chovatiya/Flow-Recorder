/** Tunables shared across the worker, content script, injected agent and UI. */

/** Hard cap on steps per recording; the recorder stops itself on reaching it. */
export const MAX_STEPS = 30;

/** Step count at which the recorder starts warning that the cap is close. */
export const WARN_STEPS = 25;

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

/**
 * What Chrome actually allows in `chrome.storage.local` without the
 * `unlimitedStorage` permission. Shown to the user; never used as the guard.
 */
export const STORAGE_QUOTA = 10_485_760;

/**
 * `chrome.storage.local` allows 10 MB. Screenshots are dropped once usage
 * approaches this, so step metadata is never the thing that fails to save.
 */
export const STORAGE_BUDGET = 8_000_000;

/** Fraction of the quota at which the storage meter starts warning. */
export const STORAGE_WARN_RATIO = 0.75;

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
