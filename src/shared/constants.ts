/** Tunables shared across the worker, content script, injected agent and UI. */

/** Hard cap on steps per recording; the recorder stops itself on reaching it. */
export const MAX_STEPS = 30;

/** Step count at which the recorder starts warning that the cap is close. */
export const WARN_STEPS = 25;

/**
 * How long to wait after an interaction before screenshotting, so the page has
 * painted its response (a menu opening, a field filling).
 */
export const SETTLE_DELAY_MS = 150;

/**
 * `chrome.storage.local` allows 10 MB. Screenshots are dropped once usage
 * approaches this, so step metadata is never the thing that fails to save.
 */
export const STORAGE_BUDGET = 8_000_000;

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

/** Marks messages the injected agent posts to the content script. */
export const AGENT_MESSAGE_SOURCE = 'page-injector';

/** DOM id of the on-page recording indicator. */
export const INDICATOR_ID = 'flowsnap-indicator';

/** Badge colour while recording. */
export const BADGE_COLOR = '#FF3B30';

/** Highlight box baked into screenshots. */
export const ANNOTATION_STROKE = '#FF3B30';
export const ANNOTATION_FILL = 'rgba(255, 59, 48, 0.08)';
