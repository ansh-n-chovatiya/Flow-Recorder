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
  /** The React components this element sits inside, when the page is React. */
  react?: ElementReactRef;
}

/**
 * Component *ids*, not paths.
 *
 * A path repeated across forty steps is pure token waste, and at the moment a
 * step is written the resolution that would produce it has not happened yet.
 * The ids index `FlowReact.components`, which is filled in asynchronously and
 * merged at export time.
 */
export interface ElementReactRef {
  /** Component ids, outermost first. */
  chain: string[];
  /** The walk hit its cap, so `chain[0]` is not the root component. */
  truncated?: boolean;
  /**
   * Which of the chain the flow attributes this step to.
   *
   * Decided once, when the flow is frozen for export, and written down so that
   * every reader of it — this extension, the MCP server, anything downstream —
   * names the same component. The rule that picks it is four preference tiers
   * deep (`core/react/owner.ts`); re-deriving it in each reader is how two
   * halves of one document end up disagreeing about which button was clicked.
   */
  owner?: string;
}

/** Why a component's source is not a resolved original file. */
export type ComponentStatus =
  | 'resolved'
  | 'compiled-only'
  | 'ambiguous'
  | 'not-found'
  | 'no-map'
  | 'map-error'
  | 'unfetchable'
  | 'skipped'
  | 'pending';

/**
 * Where one React component was written.
 *
 * Every outcome that is not `resolved` carries a `detail` sentence. A flow that
 * silently omits a path reads as "this component has no source"; one that says
 * *the component is in a lazy chunk that was never loaded* tells whoever reads
 * it what to do instead. Both this extension and its sibling hold that line.
 */
export interface ComponentSource {
  /** displayName at capture time — minified on a production build, which is fine. */
  name: string;
  status: ComponentStatus;
  via?: 'debug-source' | 'bundle-search';
  /** Normalised, repo-relative where possible: `src/components/Cart.tsx`. */
  source?: string;
  /** 1-based, for humans and editors — source maps are 0-based, converted once. */
  line?: number;
  column?: number;
  /** Kept verbatim when the source map recorded an absolute local path. */
  absolutePath?: string;
  /** The resolved path is inside node_modules, so this is not the user's code. */
  dependency?: boolean;
  /** Position in the served bundle. Present whenever a bundle match was made. */
  compiled?: { url: string; line: number; column: number };
  /** Distinct places the needle matched. Above 1 the path may be the wrong one. */
  matchCount?: number;
  /** One sentence, whenever `status` is not `resolved`. */
  detail?: string;
}

/** React facts about the page a flow was recorded on. */
export interface FlowReact {
  detected: boolean;
  version?: string;
  build?: 'development' | 'production' | 'unknown';
  /** Keyed by component id, as referenced by `ElementReactRef.chain`. */
  components: Record<string, ComponentSource>;
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
  /**
   * Set when the user supplied this image themselves instead of the recorder
   * capturing it — a modal that was gone by the time the shutter fired, a
   * moment the settle delay missed.
   *
   * It exists because everything downstream reads a screenshot as evidence of
   * what the page looked like at that instant. For an imported image that is a
   * claim nobody checked, and the exports and the card say so rather than
   * letting it pass as a capture. Absent means captured, so older flows load
   * unchanged.
   */
  screenshotImported?: boolean;
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

/**
 * Metadata for one archived flow, listed without loading its steps.
 *
 * Everything below `stepCount` is optional and derived at save time. The library
 * needs a host, a size and a sense of what is in a flow to be worth looking at,
 * and loading every flow's steps to find out would defeat the point of an index —
 * a 10-flow library would decode a hundred screenshots to draw a list. Optional
 * because flows saved by an earlier build do not have them, and a list that
 * refuses to render an old flow is worse than one that shows it plainly.
 */
export interface FlowMeta {
  id: string;
  name: string;
  createdAt: number;
  stepCount: number;
  /** Host of the first URL in the flow. */
  host?: string;
  /** Approximate bytes the flow occupies in storage. */
  bytes?: number;
  /** A small JPEG of the first screenshot, for the list row. */
  thumbnail?: string | null;
  /** How many steps of each type, for the list row's chips. */
  counts?: Partial<Record<StepType, number>>;
  /** Steps carrying a console error or a 4xx/5xx response. */
  errorCount?: number;
}

/**
 * The payload POSTed to the MCP server.
 *
 * A wire contract, not an internal shape: the server is published to npm on its
 * own and updated by `npx`, so a user can be running any server version against
 * any extension version. `schemaVersion` is what lets the receiving end tell
 * which one it is looking at.
 */
export interface FlowPayload {
  schemaVersion: number;
  id: string;
  name: string;
  timestamp: number;
  startUrl?: string;
  steps: Step[];
  /**
   * Absent entirely when the page was not React. Additive, so this is not a
   * `schemaVersion` bump — a server that predates it ignores what it does not
   * know, which is exactly what the version field exists to allow.
   */
  react?: FlowReact;
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
  /**
   * When the live recording began, for the popup's elapsed timer. `null` when
   * nothing is recording — and possibly absent on a flow recorded by an older
   * build, which the timer treats as "unknown" rather than "zero".
   */
  recordingStartedAt: number | null;
  recordedSteps: Step[];
  exportOptions: ExportOptions;
  /**
   * Which parts of a flow the "Send to Claude" dialog hands over. Kept apart
   * from `exportOptions` because the two answers differ: a ZIP on disk costs
   * nothing to over-pack, and a flow in a model's context costs tokens.
   */
  sendOptions: ExportOptions;
  savedFlowsMeta: FlowMeta[];
  lastMcpFlowId: string;
  /**
   * Resolved (or pending) component sources for the live recording.
   *
   * Its own key rather than a field on the steps, because `recordedSteps` is
   * rewritten wholesale by every capture while this is written by the resolver:
   * one key with two writers loses updates. Merged into the flow at export time
   * and pruned to the ids the surviving steps still reference.
   */
  reactComponents: Record<string, ComponentSource>;
  /** React facts about the page, minus the component table. */
  reactMeta: Omit<FlowReact, 'components'> | null;
  /**
   * Search needles for components still awaiting resolution.
   *
   * Deliberately a separate key from `reactComponents`: a needle is 200
   * characters of the site's own compiled source and is an input to resolution,
   * never part of a flow. Keeping it in a key that is never merged into a
   * payload is what makes "needles never ship" structural rather than a rule
   * somebody has to remember.
   */
  reactNeedles: Record<string, ComponentNeedle>;
  /**
   * Script URLs seen on each page of the recording, keyed by document URL.
   *
   * Persisted rather than held in the worker, because the worker is killed
   * whenever Chrome feels like it and a needle captured on page A must still be
   * searched against page A's bundles afterwards. A flow that crosses pages has
   * a different set per page, so this is not one flat list.
   */
  reactScripts: Record<string, string[]>;
  /** The most recent failure, so the UI can show what went wrong. */
  lastError: StoredError | null;
}

/**
 * What the resolver needs to find one component in the page's bundles, captured
 * at click time because the page may be gone by the time it is searched.
 */
export interface ComponentNeedle {
  head: string;
  body?: string;
  bodyOffset?: number;
  /** The page the component was seen on — its bundles are the ones to search. */
  pageUrl: string;
  /**
   * How many of that page's scripts this component has already been searched
   * against, when a search came back empty.
   *
   * A lazy chunk can load minutes after the click that wanted it, so "not found"
   * is worth revisiting — but only once there is somewhere new to look. Without
   * this, every resolver pass would rescan every bundle for every component it
   * has already failed to find.
   */
  searched?: number;
}

/** A FlowError plus when it happened, as persisted for the UI to read. */
export interface StoredError {
  code: string;
  message: string;
  detail?: string;
  at: number;
}

/** Archived flows are stored one key per flow, keyed by this. */
export function savedFlowKey(id: string): `savedFlow_${string}` {
  return `savedFlow_${id}`;
}

/**
 * An archived flow's React components, one key per flow.
 *
 * Separate from the steps because it is written by a different thing at a
 * different time — and because a flow archived before this existed simply has
 * no such key, which reads as "no components" rather than as a broken record.
 */
export function savedFlowReactKey(id: string): `savedFlowReact_${string}` {
  return `savedFlowReact_${id}`;
}

/**
 * Which palette to render. `system` is the default and stamps nothing on the
 * document, so `prefers-color-scheme` decides — see src/ui/styles/tokens.css.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Everything the extension persists in `chrome.storage.sync`. */
export interface SyncStorageShape {
  theme: ThemePreference;
  mcpServerUrl: string;
  /**
   * Whether stopping a recording uploads it automatically. Off by default: it
   * sends screenshots and captured request bodies to whatever address is
   * configured, which should be a decision, not a surprise.
   */
  mcpAutoSend: boolean;
  /**
   * Whether a step records the React component it happened in.
   *
   * The master switch for the whole feature: off means the agent never attaches
   * its listeners, so a page that is not being attributed costs nothing at all.
   */
  reactCapture: boolean;
  /**
   * Whether captured components are looked up in the page's own bundles and
   * source maps to find the file they were written in.
   *
   * Separate from capture because the two have different costs: naming a
   * component is free, while finding its file reads the page's scripts. With
   * this off a step still names its component, and every entry says why it has
   * no path rather than looking as though it has no source.
   */
  reactResolve: boolean;
  /**
   * Absolute local path the recorded source paths sit under, so the viewer can
   * offer to open one in an editor. Empty means no link is offered.
   */
  projectRoot: string;
  /** A key into `EDITORS` in core/react/editor.ts, or `custom`. */
  editor: string;
  /** Used when `editor` is `custom`. Supports {path} {line} {col} {line1} {col1}. */
  customEditorTemplate: string;
}
