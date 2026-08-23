/**
 * MAIN-world agent, injected at `document_start`.
 *
 * Runs in the page's own JS context — the only place `console`, `fetch` and
 * `XMLHttpRequest` can be observed — and relays what it sees to the isolated
 * world with `postMessage`. `CustomEvent.detail` reads as null across the
 * MAIN/ISOLATED boundary, which is why this uses messages rather than events.
 */

import { AGENT_MESSAGE_SOURCE, BODY_CAP } from '../shared/constants.js';

const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key)$/i;

function emit(detail: Record<string, unknown>): void {
  window.postMessage({ __flowsnap_source__: AGENT_MESSAGE_SOURCE, ...detail }, '*');
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : value;
  }
  return out;
}

function capBody(body: string | null): string | null {
  if (typeof body !== 'string') return body;
  return body.length > BODY_CAP
    ? `${body.slice(0, BODY_CAP)}[truncated — ${body.length}b total]`
    : body;
}

function serializeArgs(args: unknown[]): string[] {
  return args.map((arg) => {
    try {
      return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
    } catch {
      return String(arg);
    }
  });
}

// ── console ──────────────────────────────────────────────────────────────────
// Patching console is this file's entire purpose, so the no-console rule has
// nothing useful to say about it.
/* eslint-disable no-console */

const LEVELS = ['log', 'warn', 'error', 'info', 'debug'] as const;

for (const level of LEVELS) {
  const original = console[level].bind(console) as (...args: unknown[]) => void;
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      emit({ kind: 'log', level, args: serializeArgs(args), timestamp: Date.now() });
    } catch {
      // Never let instrumentation break the page's own logging.
    }
  };
}

/* eslint-enable no-console */

// ── fetch ────────────────────────────────────────────────────────────────────

const originalFetch = window.fetch.bind(window);

window.fetch = async function patchedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);

  const headers = init?.headers
    ? redactHeaders(
        init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : Object.fromEntries(Object.entries(init.headers)),
      )
    : {};

  const requestBody = capBody(
    init?.body != null ? (typeof init.body === 'string' ? init.body : '[non-string body]') : null,
  );

  const startedAt = Date.now();

  let response: Response;
  try {
    response = await originalFetch(input, init);
  } catch (err) {
    emit({
      kind: 'network',
      method,
      url,
      requestHeaders: headers,
      requestBody,
      status: null,
      responseHeaders: {},
      responseBody: `[network error: ${(err as Error).message}]`,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    });
    throw err;
  }

  // Clone so the page's own read of the body stream is untouched.
  let responseBody = '[unreadable]';
  try {
    responseBody = capBody(await response.clone().text()) ?? '';
  } catch {
    // Streaming or already-consumed response — the page still gets its data.
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : value;
  });

  emit({
    kind: 'network',
    method,
    url,
    requestHeaders: headers,
    requestBody,
    status: response.status,
    responseHeaders,
    responseBody,
    durationMs: Date.now() - startedAt,
    timestamp: startedAt,
  });

  return response;
};

// ── XMLHttpRequest ───────────────────────────────────────────────────────────

const OriginalXHR = window.XMLHttpRequest;

function PatchedXHR(this: unknown): XMLHttpRequest {
  const xhr = new OriginalXHR();

  let method = 'GET';
  let url = '';
  let requestBody: string | null = null;
  let startedAt = 0;
  const requestHeaders: Record<string, string> = {};

  const originalOpen = xhr.open.bind(xhr);
  xhr.open = function open(m: string, u: string | URL, ...rest: unknown[]) {
    method = m || 'GET';
    url = String(u ?? '');
    return (originalOpen as (...args: unknown[]) => void)(m, u, ...rest);
  };

  const originalSetHeader = xhr.setRequestHeader.bind(xhr);
  xhr.setRequestHeader = function setRequestHeader(key: string, value: string) {
    requestHeaders[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : value;
    return originalSetHeader(key, value);
  };

  const originalSend = xhr.send.bind(xhr);
  xhr.send = function send(body?: Document | XMLHttpRequestBodyInit | null) {
    startedAt = Date.now();
    if (body != null) {
      requestBody = capBody(typeof body === 'string' ? body : '[non-string body]');
    }

    xhr.addEventListener('loadend', () => {
      try {
        const responseHeaders: Record<string, string> = {};
        for (const line of (xhr.getAllResponseHeaders() || '').split('\r\n')) {
          const idx = line.indexOf(': ');
          if (idx < 0) continue;
          const key = line.slice(0, idx);
          responseHeaders[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : line.slice(idx + 2);
        }

        emit({
          kind: 'network',
          method,
          url,
          requestHeaders,
          requestBody,
          status: xhr.status,
          responseHeaders,
          responseBody: capBody(xhr.responseText || ''),
          durationMs: Date.now() - startedAt,
          timestamp: startedAt,
        });
      } catch {
        // A cross-origin response makes responseText throw; the page is fine.
      }
    });

    return originalSend(body);
  };

  return xhr;
}

// Static members (UNSENT, DONE …) live on the constructor; instance methods live
// on the prototype. Both have to be preserved or feature detection breaks.
Object.setPrototypeOf(PatchedXHR, OriginalXHR);
PatchedXHR.prototype = OriginalXHR.prototype;
window.XMLHttpRequest = PatchedXHR as unknown as typeof XMLHttpRequest;

// ── React component capture ──────────────────────────────────────────────────
/*
 * Fibers are only reachable from here.
 *
 * React stores its fiber as an expando (`__reactFiber$…`) on the DOM node, and
 * expandos set by page scripts are invisible to an isolated-world content
 * script. So the walk has to happen in the page's own context — which is what
 * this file already is — and the result crosses to the recorder as a message,
 * like everything else in here.
 */

import {
  CONTROL_MESSAGE_SOURCE,
  REACT_PREWARM_TTL_MS,
  REACT_PROBE_ATTEMPTS,
} from '../shared/constants.js';
import type { CapturedComponent, ControlMessage } from '../shared/messages.js';
import {
  type ChainEntry,
  type ChainResult,
  type ComponentFn,
  collectChain,
  hasReactRoot,
  interactionTarget,
} from '../core/react/fiber.js';
import { componentId, nameOnlyId } from '../core/react/id.js';
import { buildNeedle } from '../core/react/needle.js';

/** Watching only while something is recording — see ControlMessage. */
let reactActive = false;
/** Set once React is known to be on the page at all. */
let reactFound = false;
/** Interactions that found no component while no React root was visible. */
let reactProbes = 0;
/** Nothing here is React; listeners are gone and never come back for this document. */
let reactGaveUp = false;
let reactMetaSent = false;
/** True once any fiber has been seen carrying development-only bookkeeping. */
let sawDevelopmentFiber = false;

/**
 * Component identity by function.
 *
 * This is what makes the feature affordable: a forty-step flow through a real
 * app touches perhaps eight distinct components, so `toString()` and the hash
 * run eight times rather than once per component per click.
 */
const componentCache = new WeakMap<ComponentFn, CapturedComponent>();

/**
 * The chain computed on `pointerdown`, reused by the `click` that follows.
 *
 * One slot rather than a map: it exists to bridge a single gesture, and a cache
 * that outlives that would start answering with a tree the page has since
 * re-rendered.
 */
let prewarm: { el: Element; result: ChainResult; at: number } | null = null;

function describeEntry(entry: ChainEntry): CapturedComponent {
  const debugSource = entry.debugSource
    ? {
        source: entry.debugSource.fileName ?? '',
        line: Math.max(1, entry.debugSource.lineNumber ?? 1),
        column: Math.max(1, entry.debugSource.columnNumber ?? 1),
      }
    : null;

  if (!entry.fn) {
    // An unsettled lazy component. Its name is all there is, and forcing it to
    // resolve would mean recording the page changed what the page loaded.
    return { id: nameOnlyId(entry.name), name: entry.name, debugSource };
  }

  const cached = componentCache.get(entry.fn);
  // The cache is keyed by function, but `_debugSource` is per JSX call site, so
  // it is filled in from whichever usage first carried one rather than cached.
  if (cached) return debugSource && !cached.debugSource ? { ...cached, debugSource } : cached;

  let source = '';
  try {
    source = entry.fn.toString();
  } catch {
    // Exotic proxies can throw here; the name still tells the reader something.
    const nameOnly: CapturedComponent = { id: nameOnlyId(entry.name), name: entry.name, debugSource };
    componentCache.set(entry.fn, nameOnly);
    return nameOnly;
  }

  const built = buildNeedle(source);
  const captured: CapturedComponent = built.ok
    ? { id: componentId(entry.name, source), name: entry.name, needle: built.needle, debugSource }
    : { id: nameOnlyId(entry.name), name: entry.name, needleRejection: built.reason, debugSource };

  componentCache.set(entry.fn, captured);
  return captured;
}

// ── Script inventory ─────────────────────────────────────────────────────────

/**
 * URLs already reported, so each is sent once per document.
 *
 * Survives a stop/start inside one page: the worker's inventory is keyed by
 * origin and never forgets, so re-sending would be pure noise.
 */
const reportedScripts = new Set<string>();

let scriptsObserver: PerformanceObserver | null = null;

function reportScripts(urls: string[]): void {
  const fresh: string[] = [];
  for (const url of urls) {
    if (!url || reportedScripts.has(url)) continue;
    reportedScripts.add(url);
    fresh.push(url);
  }
  if (fresh.length) emit({ kind: 'scripts', urls: fresh });
}

/**
 * Starts reporting what the page loads.
 *
 * `buffered: true` replays entries from before recording began, which is what
 * makes this work at all — the bundles that matter loaded during page load, long
 * before anyone pressed record. The resource buffer is finite, so the `<script>`
 * tags are also read straight from the DOM: those are the ones a long-lived page
 * is most likely to have evicted.
 */
function startScriptInventory(): void {
  if (scriptsObserver) return;

  try {
    scriptsObserver = new PerformanceObserver((list) => {
      const urls: string[] = [];
      for (const entry of list.getEntries()) {
        if ((entry as PerformanceResourceTiming).initiatorType === 'script') urls.push(entry.name);
      }
      if (urls.length) reportScripts(urls);
    });
    scriptsObserver.observe({ type: 'resource', buffered: true });
  } catch {
    // No PerformanceObserver, or no resource timing. The DOM scan below still
    // finds the bundles the HTML asked for, which is most of them.
    scriptsObserver = null;
  }

  const fromDom: string[] = [];
  for (const script of Array.from(document.querySelectorAll('script[src]'))) {
    const src = (script as HTMLScriptElement).src;
    if (src) fromDom.push(src);
  }
  reportScripts(fromDom);
}

function stopScriptInventory(): void {
  scriptsObserver?.disconnect();
  scriptsObserver = null;
}

/** React's version, but only when the DevTools hook happens to be installed. */
function reactVersion(): string | undefined {
  try {
    const hook = (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as
      | { renderers?: Map<number, { version?: string }> }
      | undefined;
    if (!hook?.renderers) return undefined;
    for (const renderer of hook.renderers.values()) {
      if (renderer?.version) return renderer.version;
    }
  } catch {
    // A hostile or unusual hook object — the version is a nicety, not a need.
  }
  return undefined;
}

function sendReactMeta(detected: boolean): void {
  if (reactMetaSent) return;
  reactMetaSent = true;
  emit({
    kind: 'react-meta',
    detected,
    version: reactVersion(),
    build: !detected ? undefined : sawDevelopmentFiber ? 'development' : 'production',
  });
}

function chainFor(el: Element): ChainResult {
  if (prewarm && prewarm.el === el && Date.now() - prewarm.at <= REACT_PREWARM_TTL_MS) {
    return prewarm.result;
  }
  const result = collectChain(el);
  prewarm = { el, result, at: Date.now() };
  return result;
}

/**
 * Gives up on this document.
 *
 * Only after several interactions have found nothing *and* no React root is
 * visible: a single-page app can mount React after the first click, and a click
 * can land outside the root on a page that is React everywhere else.
 */
function abandonReact(): void {
  reactGaveUp = true;
  prewarm = null;
  detachReactListeners();
  stopScriptInventory();
  sendReactMeta(false);
}

function onReactInteraction(event: Event): void {
  if (!reactActive || reactGaveUp) return;

  // The composed target, not `event.target`: anything inside a shadow root is
  // retargeted to its host by the time a document listener sees it, and React
  // mounted in there would be invisible.
  const target = interactionTarget(event);
  if (!target) return;

  const result = chainFor(target);

  if (result.entries.length === 0) {
    if (reactFound) return; // React is here, this click simply was not in it
    reactProbes++;
    if (hasReactRoot(document)) {
      reactFound = true;
      return;
    }
    if (reactProbes >= REACT_PROBE_ATTEMPTS) abandonReact();
    return;
  }

  reactFound = true;
  if (result.entries.some((entry) => entry.development)) sawDevelopmentFiber = true;
  sendReactMeta(true);
  // Only once there is something to resolve: on a page with no React, the
  // observer would report bundles nobody will ever search.
  startScriptInventory();

  emit({
    kind: 'react',
    // The recorder claims this by the same number: one dispatch, one timeStamp,
    // identical in both worlds. Nothing else correlates the two safely.
    eventTime: event.timeStamp,
    chain: result.entries.map(describeEntry),
    truncated: result.truncated,
  });
}

/** Warms the chain so the click that follows pays nothing for it. */
function onReactPointerDown(event: Event): void {
  if (!reactActive || reactGaveUp) return;
  // Warmed against the same element the click will ask for, or the cache misses.
  const target = interactionTarget(event);
  if (target) chainFor(target);
}

const REACT_EVENTS = ['click', 'input', 'change'] as const;

function attachReactListeners(): void {
  document.addEventListener('pointerdown', onReactPointerDown, true);
  for (const type of REACT_EVENTS) document.addEventListener(type, onReactInteraction, true);
}

function detachReactListeners(): void {
  document.removeEventListener('pointerdown', onReactPointerDown, true);
  for (const type of REACT_EVENTS) document.removeEventListener(type, onReactInteraction, true);
}

window.addEventListener('message', (event: MessageEvent<ControlMessage>) => {
  // Same window, same origin — the same check the recorder applies to us.
  if (event.source !== window || event.origin !== window.location.origin) return;

  const data = event.data;
  if (!data || data.__flowsnap_control__ !== CONTROL_MESSAGE_SOURCE) return;
  if (reactGaveUp) return;

  const wanted = Boolean(data.recording);
  if (wanted === reactActive) return;

  reactActive = wanted;
  if (wanted) {
    attachReactListeners();
    // A second recording in the same page already knows this is React.
    if (reactFound) startScriptInventory();
  } else {
    detachReactListeners();
    stopScriptInventory();
    prewarm = null;
  }
});
