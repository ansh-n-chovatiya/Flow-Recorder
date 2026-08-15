/**
 * The recorded-flow data model.
 *
 * These shapes are persisted in `chrome.storage.local` and written to disk by the
 * MCP server, so they are a compatibility surface: existing recordings must keep
 * loading. Fields are optional here where the pre-TypeScript code left them
 * optional in practice, not because the model is loose.
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What was interacted with, described every way we know how to describe it. */
export interface ElementRef {
  tag: string;
  /** Visible text, capped at 80 chars. */
  text?: string | null;
  /** Best human label: `<label>`, placeholder, aria-label, or falling back to text. */
  label?: string | null;
  role?: string | null;
  type?: string | null;
  /** Stable-first selector: id > data-testid > aria-label > CSS path. */
  cssSelector: string;
  xpath: string;
  boundingBox: BoundingBox | null;
  ariaLabel?: string | null;
}

export interface NetworkCall {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  /** `null` when the request failed before a response. */
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  durationMs: number;
  timestamp: number;
}

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export interface ConsoleEntry {
  level: ConsoleLevel;
  args: string[];
  timestamp: number;
}

export type StepType = 'click' | 'input' | 'navigate' | 'note';

/**
 * Fields every step carries. `element` and `value` sit here rather than on the
 * variants because the viewer renders steps generically; the variants below
 * still require whichever of them they cannot exist without.
 */
interface StepBase {
  url: string;
  timestamp: number;
  /** Human-readable sentence: `Clicked "Save"`, `Typed "ada@" into Email`. */
  action: string;
  /** Assigned at capture time. Stale after a deletion — see `renumber()`. */
  stepNumber?: number;
  /** Annotated JPEG data URL, or null when capture failed or was skipped. */
  screenshot?: string | null;
  /** Un-annotated original, kept so the image editor has a clean base. */
  screenshotOriginal?: string | null;
  highlightBox?: BoundingBox | null;
  dpr?: number;
  title?: string;
  notes?: string;
  value?: string;
  element?: ElementRef;
  consoleLogs?: ConsoleEntry[];
  networkCalls?: NetworkCall[];
}

export interface ClickStep extends StepBase {
  type: 'click';
  element: ElementRef;
}

export interface InputStep extends StepBase {
  type: 'input';
  element: ElementRef;
  value: string;
}

export interface NavigateStep extends StepBase {
  type: 'navigate';
  title: string;
}

/** Synthesised by the recorder, e.g. when the step limit is reached. */
export interface NoteStep extends StepBase {
  type: 'note';
  value: string;
}

export type Step = ClickStep | InputStep | NavigateStep | NoteStep;

/** A step being built by the content script, before the worker attaches an image. */
export type DraftStep = Omit<Step, 'stepNumber' | 'screenshot' | 'screenshotOriginal'>;

/** Metadata for one archived flow, listed without loading its steps. */
export interface FlowMeta {
  id: string;
  name: string;
  createdAt: number;
  stepCount: number;
}

/** The payload POSTed to the MCP server. */
export interface FlowPayload {
  id: string;
  name: string;
  timestamp: number;
  startUrl?: string;
  steps: Step[];
}

/** Which parts of a flow an export includes. */
export interface ExportOptions {
  images: boolean;
  network: boolean;
  logs: boolean;
}

export type RecordingState = 'idle' | 'recording' | 'paused';

/** Everything the extension persists in `chrome.storage.local`. */
export interface LocalStorageShape {
  recordingActive: boolean;
  recordingPaused: boolean;
  recordedSteps: Step[];
  exportOptions: ExportOptions;
  savedFlowsMeta: FlowMeta[];
  lastMcpFlowId: string;
}

/** Archived flows are stored one key per flow, keyed by this. */
export function savedFlowKey(id: string): `savedFlow_${string}` {
  return `savedFlow_${id}`;
}

/** Everything the extension persists in `chrome.storage.sync`. */
export interface SyncStorageShape {
  mcpServerUrl: string;
}
