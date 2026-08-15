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
