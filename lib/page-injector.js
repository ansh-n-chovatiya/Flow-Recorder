// page-injector.js — MAIN world content script (injected at document_start).
// Runs in the real page JS context, so it can patch console/fetch/XHR.
// Uses window.postMessage to relay events to the isolated-world content.js —
// CustomEvent.detail is null when read across the MAIN/ISOLATED world boundary.

(function () {
  const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key)$/i;
  const BODY_CAP = 51200; // 50 KB

  function emit(detail) {
    window.postMessage({ __flowsnap_source__: 'page-injector', ...detail }, '*');
  }

  function redactHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = SENSITIVE_HEADERS.test(k) ? '[redacted]' : v;
    }
    return out;
  }

  function capBody(body) {
    if (typeof body !== 'string') return body;
    if (body.length > BODY_CAP) {
      return body.slice(0, BODY_CAP) + '[truncated — ' + body.length + 'b total]';
    }
    return body;
  }

  // Serialize arbitrary console args to strings.
  function serializeArgs(args) {
    return Array.from(args).map((a) => {
      try {
        return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
      } catch (_) {
        return String(a);
      }
    });
  }

  // --- console patch -----------------------------------------------------------

  const LEVELS = ['log', 'warn', 'error', 'info', 'debug'];
  LEVELS.forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      orig(...args);
      try {
        emit({ kind: 'log', level, args: serializeArgs(args), timestamp: Date.now() });
      } catch (_) {}
    };
  });

  // --- fetch patch -------------------------------------------------------------

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const reqHeaders = redactHeaders(
      init && init.headers
        ? Object.fromEntries(
            init.headers instanceof Headers
              ? [...init.headers.entries()]
              : Object.entries(init.headers)
          )
        : {}
    );
    const reqBody = capBody(
      (init && init.body != null)
        ? typeof init.body === 'string'
          ? init.body
          : '[non-string body]'
        : null
    );
    const t0 = Date.now();

    let response;
    try {
      response = await origFetch(input, init);
    } catch (err) {
      emit({
        kind: 'network',
        method,
        url,
        requestHeaders: reqHeaders,
        requestBody: reqBody,
        status: null,
        responseHeaders: {},
        responseBody: '[network error: ' + err.message + ']',
        durationMs: Date.now() - t0,
        timestamp: t0,
      });
      throw err;
    }

    // Clone so the original response stream is untouched.
    const clone = response.clone();
    let resBody = '[unreadable]';
    try {
      const text = await clone.text();
      resBody = capBody(text);
    } catch (_) {}

    const resHeaders = {};
    response.headers.forEach((v, k) => {
      resHeaders[k] = SENSITIVE_HEADERS.test(k) ? '[redacted]' : v;
    });

    emit({
      kind: 'network',
      method,
      url,
      requestHeaders: reqHeaders,
      requestBody: reqBody,
      status: response.status,
      responseHeaders: resHeaders,
      responseBody: resBody,
      durationMs: Date.now() - t0,
      timestamp: t0,
    });

    return response;
  };

  // --- XMLHttpRequest patch ----------------------------------------------------

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let method = 'GET';
    let url = '';
    let reqBody = null;
    const t0Ref = { v: 0 };

    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u, ...rest) {
      method = m || 'GET';
      url = u || '';
      return origOpen(m, u, ...rest);
    };

    // Mirror setRequestHeader so headers are captured for emit.
    const capturedReqHeaders = {};
    const origSetHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (k, v) {
      capturedReqHeaders[k] = SENSITIVE_HEADERS.test(k) ? '[redacted]' : v;
      return origSetHeader(k, v);
    };

    const origSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
      t0Ref.v = Date.now();
      if (body != null) {
        reqBody = capBody(typeof body === 'string' ? body : '[non-string body]');
      }

      xhr.addEventListener('loadend', function () {
        try {
          const resHeaders = {};
          const rawHeaders = xhr.getAllResponseHeaders() || '';
          rawHeaders.split('\r\n').forEach((line) => {
            const idx = line.indexOf(': ');
            if (idx < 0) return;
            const k = line.slice(0, idx);
            const v = line.slice(idx + 2);
            resHeaders[k] = SENSITIVE_HEADERS.test(k) ? '[redacted]' : v;
          });

          emit({
            kind: 'network',
            method,
            url,
            requestHeaders: capturedReqHeaders,
            requestBody: reqBody,
            status: xhr.status,
            responseHeaders: resHeaders,
            responseBody: capBody(xhr.responseText || ''),
            durationMs: Date.now() - t0Ref.v,
            timestamp: t0Ref.v,
          });
        } catch (_) {}
      });

      return origSend(body);
    };

    return xhr;
  };
  // Preserve static properties (open/send etc live on prototype).
  Object.setPrototypeOf(window.XMLHttpRequest, OrigXHR);
  window.XMLHttpRequest.prototype = OrigXHR.prototype;
})();
