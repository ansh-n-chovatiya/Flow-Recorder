/**
 * Message contracts between the popup, viewer, content script and worker.
 *
 * Every `chrome.runtime` / `chrome.tabs` message in the extension is one of the
 * unions below, and every response is looked up from a type map — so a handler
 * that returns the wrong shape is a compile error rather than an undefined at
 * runtime. `sendMessage` also reads `lastError`, which unread would log
 * "Unchecked runtime.lastError" on every closed tab.
 */

import type {
  BoundingBox,
  ComponentNeedle,
  DraftStep,
  FlowReact,
  Step,
} from './types.js';

/**
 * One component the agent found above an interaction.
 *
 * The `needle` is stripped from this before anything is stored on a step — it
 * travels to the worker's resolver and stops there. See `LocalStorageShape.reactNeedles`.
 */
export interface CapturedComponent {
  id: string;
  name: string;
  /** Absent when the source could not be read: an unsettled lazy, or a native fn. */
  needle?: Omit<ComponentNeedle, 'pageUrl'> | null;
  /** Why there is no needle, so the component's status can say so. */
  needleRejection?: 'native' | 'too-short';
  /**
   * `_debugSource`, on React 18 and earlier development builds.
   *
   * Kept apart from the needle because they are different facts: a needle finds
   * where the component was *defined*, while `_debugSource` records where the
   * JSX element was *written* — which is a position in the parent's file. Useful,
   * but not the same answer, and not interchangeable with a bundle-search hit.
   */
  debugSource?: { source: string; line: number; column: number } | null;
}

// ── Page → worker ────────────────────────────────────────────────────────────

/**
 * What the region around a step's element said, once the page had responded.
 *
 * Sent separately from the step, and later, because it is a fact about what the
 * interaction *did* — which is not known at the moment the step is written. The
 * step goes as soon as it happens so the screenshot is not delayed; this arrives
 * a few hundred milliseconds behind it and is merged in by key.
 */
export interface StepDomDelta {
  type: 'STEP_DOM_DELTA';
  /** `timestamp:type`, exactly as `stepKey` builds it. */
  key: string;
  before: string;
  after: string;
}

export interface CaptureAndSaveStep {
  type: 'CAPTURE_AND_SAVE_STEP';
  step: DraftStep;
  elementBox: BoundingBox | null;
  dpr: number;
  /**
   * The components this step's element sits inside, if any.
   *
   * Sent with the step so the worker is the single writer of the component
   * table — the content script never touches storage, and the table cannot race
   * the capture queue's rewrite of `recordedSteps`.
   */
  components?: CapturedComponent[];
  /** The page the components were seen on; its bundles are what gets searched. */
  componentsPageUrl?: string;
  /**
   * Where the page was scrolled when `elementBox` was measured.
   *
   * The box is viewport-relative and the capture happens at least
   * `SETTLE_DELAY_MS` later, so the worker needs both ends to know whether the
   * element is still where it was. See `GetScroll`.
   */
  scroll?: { x: number; y: number };
}

/** Where the page is scrolled right now, asked of the tab about to be captured. */
export interface GetScrollResponse {
  x: number;
  y: number;
}

/**
 * Script URLs the page has loaded, so the resolver knows what to search.
 *
 * Sent as deltas rather than a snapshot: a code-split app fetches chunks all
 * through a recording, and a component captured on step 3 may live in a chunk
 * that only arrives at step 20.
 */
export interface ReactScripts {
  type: 'REACT_SCRIPTS';
  urls: string[];
  /** The page that loaded them. The worker prefers `sender.url` when it has one. */
  pageUrl: string;
}

/**
 * Resolve whatever is still pending, now.
 *
 * The worker resolves on its own while recording, on idle. This is the
 * last-chance sweep for the moments where nothing else will follow: the
 * recording has stopped, or the flow is about to be sent.
 */
export interface ResolveComponents {
  type: 'RESOLVE_COMPONENTS';
  /** After this there is no next trigger, so anything left is reported skipped. */
  final: boolean;
}

/**
 * Forget every React fact this recording has collected.
 *
 * Sent when capture is switched off. Stopping *new* attribution is only half of
 * what that switch promises: a recording that has been running for ten steps
 * already holds component ids on those steps, needles waiting to be searched
 * and a table of resolved paths, and leaving them behind would mean the flow
 * still ships the React data the user has just asked it not to keep.
 *
 * Handled in the worker rather than the content script because `recordedSteps`
 * has exactly one writer, and this has to be one of its writes rather than a
 * read-modify-write racing it. Archived flows are untouched: they are finished
 * records, and deleting from them is what `Settings → Delete all` is for.
 */
export interface ReactPurge {
  type: 'REACT_PURGE';
}

/** React facts about the page, recorded once when the agent first detects it. */
export interface ReactMeta {
  type: 'REACT_META';
  meta: Omit<FlowReact, 'components'>;
}

export interface AnnotateScreenshot {
  type: 'ANNOTATE_SCREENSHOT';
  screenshot: string;
  box: BoundingBox;
  dpr: number;
}

/**
 * Screenshot now and hold it for the click that is about to happen. Sent on
 * pointerdown for interactions that may navigate.
 */
export interface Precapture {
  type: 'PRECAPTURE';
}

export interface GetSteps {
  type: 'GET_STEPS';
}

export interface ClearSteps {
  type: 'CLEAR_STEPS';
}

/**
 * Hands an editor deep link (`vscode://…`) to the browser.
 *
 * The viewer cannot do this itself: navigating an extension page to a custom
 * scheme is blocked, and the launch has to happen in a tab the worker can then
 * dispose of.
 */
export interface OpenEditor {
  type: 'OPEN_EDITOR';
  url: string;
}

/**
 * End the recording, once everything already captured has been written.
 *
 * Stopping is a storage write like every other recording state change, but it
 * cannot be *only* that: a step spends a few hundred milliseconds in the
 * worker's capture queue between the click and the write, and `captureAndSave`
 * drops anything that finds the recording already over. Pressing Stop straight
 * after the thing you wanted to record therefore lost exactly that step — and
 * the MCP auto-export, which fires on the same storage change, shipped the flow
 * without it. The worker owns the order instead: drain, then flip.
 */
export interface FinishRecording {
  type: 'FINISH_RECORDING';
}

export type WorkerRequest =
  | CaptureAndSaveStep
  | StepDomDelta
  | FinishRecording
  | Precapture
  | AnnotateScreenshot
  | ReactMeta
  | ReactPurge
  | ReactScripts
  | ResolveComponents
  | GetSteps
  | ClearSteps
  | OpenEditor;

export interface AnnotateScreenshotResponse {
  screenshot: string | null;
}

export interface GetStepsResponse {
  steps: Step[];
}

export interface OkResponse {
  ok: boolean;
}

/** Carries the reason, because a launch that quietly did nothing is a bug report. */
export interface OpenEditorResponse {
  ok: boolean;
  error?: string;
}

export interface ResponseByType {
  /** Resolves once the capture is done, so the page can restore its indicator. */
  CAPTURE_AND_SAVE_STEP: OkResponse;
  STEP_DOM_DELTA: OkResponse;
  PRECAPTURE: OkResponse;
  ANNOTATE_SCREENSHOT: AnnotateScreenshotResponse;
  REACT_META: OkResponse;
  REACT_PURGE: OkResponse;
  REACT_SCRIPTS: OkResponse;
  RESOLVE_COMPONENTS: OkResponse;
  GET_STEPS: GetStepsResponse;
  CLEAR_STEPS: OkResponse;
  FINISH_RECORDING: OkResponse;
  OPEN_EDITOR: OpenEditorResponse;
}

// ── UI → content script ──────────────────────────────────────────────────────

export type ContentRequest =
  | { type: 'PING' }
  | { type: 'GET_SCROLL' }
  /**
   * Hand over whatever console and network activity has not been attached to a
   * step yet, and forget it.
   *
   * Console and network are attached to the *next* step, because a step is what
   * they are written onto — so anything a page produced after the last
   * interaction had nowhere to land and was dropped when recording stopped.
   * That is precisely the moment a bug report is made of: the user clicks the
   * thing, it breaks, and they stop recording. See `FLUSH_PENDING` in
   * `content/index.ts` and `finishRecording` in the worker.
   */
  | { type: 'FLUSH_PENDING' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'RESUME_RECORDING' }
  | { type: 'CLEAR_STEPS' };

// ── Injected agent → content script ──────────────────────────────────────────

export interface AgentLogMessage {
  __flowsnap_source__: string;
  kind: 'log';
  level: string;
  args: string[];
  timestamp: number;
}

export interface AgentNetworkMessage {
  __flowsnap_source__: string;
  kind: 'network';
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  durationMs: number;
  timestamp: number;
  /**
   * Truncation, carried beside the body rather than inside it.
   *
   * The agent caps bodies and used to append `[truncated — Nb total]` to the
   * string, which made a cut-off JSON body unparseable — so the export called a
   * JSON API "non-JSON", reported the kept length as the real one, and never ran
   * the schema inference that exists precisely for large bodies. The body is now
   * a clean prefix and these say what happened to it.
   */
  requestBodyTruncated?: boolean;
  requestBodyBytes?: number;
  responseBodyTruncated?: boolean;
  responseBodyBytes?: number;
}

/**
 * A component chain, keyed by the `timeStamp` of the event it describes.
 *
 * The key is what makes this safe. The agent and the recorder are two listeners
 * in two JS worlds watching the same event; `postMessage` is asynchronous, so
 * the chain can arrive after the step has been built. Buffering it and attaching
 * it to whatever comes next would silently put a chain on the *wrong step* — a
 * click on a `<select>` is dropped by the recorder entirely, and the `input`
 * handler fires 800 ms late. `event.timeStamp` is identical in both worlds for
 * one dispatch, needs nothing shared, and makes a mismatch impossible.
 */
export interface AgentReactMessage {
  __flowsnap_source__: string;
  kind: 'react';
  eventTime: number;
  chain: CapturedComponent[];
  truncated: boolean;
}

/**
 * Script URLs seen in the page, as a delta.
 *
 * react-source-locator asks DevTools for the page's resources. FlowSnap has no
 * DevTools page, so the page reports them itself — a `PerformanceObserver` with
 * `buffered: true`, which replays what loaded before recording started, plus
 * `document.scripts` for the tags the observer's buffer may have dropped.
 */
export interface AgentScriptsMessage {
  __flowsnap_source__: string;
  kind: 'scripts';
  urls: string[];
}

/** Sent once per document, the first time the agent works out what it is on. */
export interface AgentReactMetaMessage {
  __flowsnap_source__: string;
  kind: 'react-meta';
  detected: boolean;
  version?: string;
  build?: 'development' | 'production' | 'unknown';
}

export type AgentMessage =
  | AgentLogMessage
  | AgentNetworkMessage
  | AgentReactMessage
  | AgentReactMetaMessage
  | AgentScriptsMessage;

// ── Content script → injected agent ──────────────────────────────────────────

/**
 * Tells the agent whether to watch for interactions at all.
 *
 * The agent is a manifest content script, so it loads on every page whether or
 * not anything is recording. Without this it would walk fibers on every click a
 * user ever makes. A page can forge this message; the worst it achieves is
 * making the agent post chains the content script drops.
 */
export interface ControlMessage {
  __flowsnap_control__: string;
  recording: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Promise wrapper around `chrome.runtime.sendMessage` that resolves with
 * `undefined` when the receiving end is gone rather than rejecting, so callers
 * can treat "worker asleep" and "worker answered" the same way.
 */
export function sendToWorker<T extends WorkerRequest>(
  req: T,
): Promise<ResponseByType[T['type']] | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (resp: ResponseByType[T['type']] | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(resp);
    });
  });
}
