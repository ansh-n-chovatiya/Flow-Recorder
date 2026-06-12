# FlowSnap — AI Flow Recorder

Browser extension (MV3, Chrome) that records user interactions as structured flow reports for feeding into AI coding assistants.

---

## Current State

### What It Does

Records clicks, inputs, and navigations as discrete "steps." Each step captures a screenshot with a red highlight box annotated over the clicked element, plus element metadata (selector, label, URL, action type). The output is exported as a ZIP (recommended), Markdown, or JSON file.

### Architecture

```
manifest.json
background.js            — MV3 service worker; screenshot capture queue; step storage
content.js               — Injected into pages; monitors clicks/inputs/navigations
lib/
  selector.js            — CSS selector + XPath generation (id > data-testid > aria-label > path)
  exporter.js            — Markdown/JSON export formatters
  annotator.js           — Draws red box on screenshot (OffscreenCanvas, service-worker-safe)
  zip.js                 — Zero-dependency store-only ZIP builder
popup/
  popup.html / popup.js  — Extension popup (Start/Stop/View/Clear)
viewer/
  viewer.html / viewer.js — Full-page review and export UI
styles/overlay.css       — Recording indicator (red pulse, bottom-right)
icons/
```

### Key Technical Facts

- **MV3 service worker** — background.js can't use DOM or FileReader; annotator.js uses OffscreenCanvas + btoa
- **Content script isolated world** — content.js shares the DOM but NOT the page's JS execution context (no access to page's `window`, `console`, `fetch`)
- **Screenshot capture** — `chrome.tabs.captureVisibleTab()` → JPEG → annotated via OffscreenCanvas → stored as base64 in `chrome.storage.session`
- **Annotation is destructive** — `annotator.js` bakes the red box directly into the JPEG in the service worker; original screenshot is not retained separately
- **Step limit** — 30 hard cap, 25 warning
- **Exports** — ZIP: `images/` folder + `flow.md` + `flow.json`; standalone Markdown (inline base64); standalone JSON

### Current Step Data Shape

```json
{
  "id": "step_1718000000000",
  "index": 0,
  "type": "click | input | navigation",
  "action": "Clicked Submit button",
  "url": "https://app.example.com/dashboard",
  "elementInfo": {
    "tag": "button",
    "label": "Submit",
    "selector": "#submit-btn",
    "xpath": "/html/body/main/form/button",
    "boundingBox": { "x": 120, "y": 340, "width": 80, "height": 36 }
  },
  "screenshot": "data:image/jpeg;base64,..."
}
```

---

## Planned Features (v2)

### F1 — Console Logs & Network Capture Per Step

**Goal:** Each step should include the console output and network requests/responses that occurred since the previous step, so the AI has full runtime context.

**The core problem:** content.js runs in an isolated world. Simply overriding `console.log` or `window.fetch` inside content.js does NOT capture the page's own calls — only the extension's internal calls.

**Two options; pick one:**

| Option | Mechanism | Pros | Cons |
|--------|-----------|------|------|
| **A — MAIN-world injection** (recommended for logs; partial for network) | Add a second content script entry in manifest with `"world": "MAIN"` (Chrome 111+). This script overrides `console.*` and `window.fetch` / `XMLHttpRequest` on the real page window. Patches must be installed before page code runs (`"run_at": "document_start"`). | No extra permission; no debugger banner; lightweight | Can miss requests fired before injection; `fetch` response body interception requires cloning the stream; WebSocket/beacon/preload not captured; `run_at: document_start` required or early requests are missed |
| **B — chrome.debugger + CDP Network domain** | `background.js` calls `chrome.debugger.attach()` then enables `Network` domain. Receives `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`; calls `Network.getResponseBody` for response bodies. | Complete — all request types including WS, beacon, service worker; response bodies retrieved cleanly | Requires `"debugger"` permission; shows Chrome's yellow "DevTools is debugging" banner to the user the entire time recording is active; `getResponseBody` only works while debugger is attached |

**Recommendation:** Use **Option A (MAIN-world injection)** for console logs (reliable) and for fetch/XHR (sufficient for most web apps). Add a note in the UI that WebSocket/beacon traffic is not captured. If the user's app uses those, document Option B as the upgrade path.

**Implementation spec:**

1. Add `lib/page-injector.js` with `"world": "MAIN"`, `"run_at": "document_start"` in manifest content_scripts.
2. `page-injector.js` patches `console.log/warn/error/info/debug` and `window.fetch` / `XMLHttpRequest.prototype.open+send` on the real page window.
3. Captured events posted to `content.js` via `window.dispatchEvent(new CustomEvent('__flowsnap__', { detail: ... }))`. content.js listens and buffers them in a per-step queue.
4. On each `CAPTURE_AND_SAVE_STEP` message, background.js includes the buffered logs and network calls from that step's window, then clears the buffer.

**Data shape additions:**

```json
{
  "consoleLogs": [
    { "level": "error", "args": ["Uncaught TypeError: ..."], "timestamp": 1718000001234 }
  ],
  "networkCalls": [
    {
      "method": "POST",
      "url": "https://api.example.com/submit",
      "requestHeaders": { "Content-Type": "application/json" },
      "requestBody": "{\"name\":\"Alice\"}",
      "status": 200,
      "responseHeaders": { "Content-Type": "application/json" },
      "responseBody": "{\"id\":42}",
      "durationMs": 134,
      "timestamp": 1718000001100
    }
  ]
}
```

**Required guardrails (implement these, not optional):**

- **Response body cap:** Truncate `responseBody` and `requestBody` at **50 KB** with a `"[truncated — Xb total]"` suffix. Unbounded bodies will blow storage and make the AI report useless.
- **Auth header redaction:** Strip/mask `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` headers (consistent with existing password masking in content.js).
- **Step bucketing:** Logs and network calls accumulated since the previous capture are attached to the current step. On `CLEAR_STEPS`, flush all buffers. On recording stop, flush remaining buffer into a synthetic "session end" entry or discard.

---

### F2 — Step Editing (Highlight Area, Title, Image, Info)

**Goal:** User can edit any step in the viewer before exporting.

**Architecture change required for highlight editing:**

Today `annotator.js` bakes the red box directly into the JPEG (destructive — original is gone). To make the highlight box editable, the original screenshot must be stored separately from the annotated version, and the box must be stored as coordinates — not pixels.

**Required data change:**

```json
{
  "screenshot": "data:image/jpeg;base64,...",         // annotated (current — keep for display)
  "screenshotOriginal": "data:image/jpeg;base64,...", // NEW: raw unannotated screenshot
  "highlightBox": { "x": 120, "y": 340, "width": 80, "height": 36 }  // NEW: stored separately
}
```

background.js must save both before annotation. This increases storage ~2× per step — acceptable at the 30-step cap.

**Highlight box editor (in viewer.js):**

- Render step image in a `<canvas>` or as `<img>` with a draggable `<div>` overlay positioned via the stored `highlightBox` coords.
- User can drag + resize the overlay div.
- On save: call `annotateScreenshot(screenshotOriginal, newBox)` to re-bake, update both `screenshot` and `highlightBox` in storage, re-render.
- UX: "Edit Highlight" button on step card → opens in-place editor → "Save" / "Cancel".

**Title editor:**

- Step card title is an `<h3>` or similar. On click → convert to `<input type="text">`, prefilled with current action string. On Enter/blur → persist to storage.

**Info editor:**

- Same pattern for the step description/metadata text block. Click to edit freeform text, which overrides the auto-generated description in exports.

**Image editor (replace screenshot):**

- "Replace Image" button → `<input type="file" accept="image/*">` → reads file as data URL → updates `screenshot` in storage (and clears `screenshotOriginal` / `highlightBox` since the box is no longer meaningful). Or allow user to keep the old highlight by re-positioning it on the new image.

---

### F3 — Export Filters (Images / Network Calls / Console Logs)

**Goal:** User controls what gets included in the exported file.

**UI:** Three checkboxes in the viewer toolbar (persistent across session via `chrome.storage.local`):
```
[x] Include screenshots
[x] Include network calls
[x] Include console logs
```

**Must thread through all three export paths:**

| Export path | File | What changes |
|-------------|------|-------------|
| `exportZip()` | viewer.js | Skip `images/` folder + image refs in flow.md if screenshots off; omit network/log blocks in flow.md and flow.json |
| `exportMarkdown()` | viewer.js → exporter.js | Skip base64 image block; skip network/log sections |
| `exportJSON()` | viewer.js → exporter.js | Set `screenshot: null`; omit `networkCalls` / `consoleLogs` keys |

The toggles filter at export time — stored step data is never mutated by these toggles.

**Markdown format for network/logs (when included):**

````markdown
### Step 2 — Clicked Submit

**Action:** Clicked Submit button
**URL:** https://app.example.com/form

![Step 2](images/step-02.jpg)

<details>
<summary>Network calls (1)</summary>

**POST** `https://api.example.com/submit` — 200 OK — 134ms
Request body:
```json
{"name":"Alice"}
```
Response body:
```json
{"id":42}
```
</details>

<details>
<summary>Console logs (2)</summary>

`[error]` Uncaught TypeError: Cannot read property 'x' of undefined
`[log]` Form submitted successfully
</details>
````

JSON format: include `networkCalls` and `consoleLogs` arrays directly on each step object (already shown in F1 shape).

---

### F4 — .gitignore in Downloaded ZIP Output

**Goal:** When user extracts the ZIP into a coding project directory, the folder should be immediately git-ignored.

**Implementation:** In `lib/zip.js` → `createZip()`, add a `.gitignore` entry as the first file:

```js
files.unshift({ name: '.gitignore', data: '*\n' });
```

Content: exactly `*` followed by a newline. This ignores all files inside the extracted folder.

**Scope:** ZIP export only. Single-file Markdown/JSON downloads can't bundle a sibling file — no change needed for those.

---

### F5 — Editable Download Filename

**Goal:** User can set the filename before each export.

**UI:** Before triggering download, show an inline filename input pre-filled with the auto-generated name. User edits and confirms.

- Default name pattern: `flowsnap-flow-YYYY-MM-DD` (current format)
- Input appears in a small modal or inline in the toolbar on clicking any export button
- "Download" button in the modal triggers the actual export with the user-supplied name

**Apply to all three export types** (ZIP, Markdown, JSON). The extension suffix (`.zip`, `.md`, `.json`) is always appended by the exporter — user edits only the base name.

**Sanitization (required):** Strip characters not safe for filenames: `/ \ : * ? " < > |` and leading/trailing spaces and dots. If sanitized result is empty, fall back to the default name.

```js
function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '').trim().replace(/^\.+|\.+$/g, '') || 'flowsnap-flow';
}
```

---

## Full Implementation Prompt for AI

> Use this section as a self-contained prompt to give to an AI assistant for implementing all v2 features.

---

**PROMPT START**

You are implementing new features for FlowSnap, a Chrome MV3 browser extension that records user interactions for AI context. Below is the complete current codebase architecture, followed by the feature specifications. Implement all features as described.

### Current Codebase

**manifest.json** — MV3 manifest. Permissions: `activeTab, tabs, storage, downloads, scripting`. Background: `background.js`. Content scripts: `lib/selector.js` + `content.js` injected at `document_idle` into all URLs. Web-accessible: `viewer/*`.

**background.js** — Service worker. Handles `CAPTURE_AND_SAVE_STEP` (captures screenshot with `chrome.tabs.captureVisibleTab`, annotates via `annotateScreenshot()`, stores step in `chrome.storage.session`). Also handles `GET_STEPS`, `CLEAR_STEPS`, `START_RECORDING`, `STOP_RECORDING`.

**content.js** — Monitors click, input, navigation events. Assembles step payload (type, action string, elementInfo with tag/label/selector/xpath/boundingBox). Sends `CAPTURE_AND_SAVE_STEP` to background.

**lib/selector.js** — `generateSelector()` (id > data-testid > aria-label > CSS path), `generateXPath()`.

**lib/exporter.js** — `exportToMarkdown()`, `exportToJSON()`, `exportToMarkdownWithRefs()` (for ZIP).

**lib/annotator.js** — `annotateScreenshot(screenshotDataUrl, boundingBox)` using OffscreenCanvas. Bakes red box into JPEG. Returns annotated base64.

**lib/zip.js** — `createZip(files)` where files is array of `{ name, data }`. `dataUrlToBytes()` converts data URLs.

**viewer/viewer.js** — `buildStepCard()`, `render()`, `deleteStep()`, `exportZip()`, `exportMarkdown()`, `exportJSON()`, `loadSteps()`.

**Current step data shape:**
```json
{
  "id": "step_1718000000000",
  "index": 0,
  "type": "click",
  "action": "Clicked Submit button",
  "url": "https://app.example.com",
  "elementInfo": { "tag": "button", "label": "Submit", "selector": "#submit-btn", "xpath": "...", "boundingBox": { "x": 120, "y": 340, "width": 80, "height": 36 } },
  "screenshot": "data:image/jpeg;base64,..."
}
```

---

### Feature 1: Console Logs & Network Capture Per Step

Add `lib/page-injector.js` as a new MAIN-world content script injected at `document_start`. Register it in manifest.json:

```json
{
  "js": ["lib/page-injector.js"],
  "run_at": "document_start",
  "world": "MAIN",
  "matches": ["<all_urls>"]
}
```

`page-injector.js` must:
- Override `console.log/warn/error/info/debug` to capture args (serialize to strings) with level and timestamp
- Override `window.fetch` to capture method, url, request headers (redact Authorization/Cookie/X-Api-Key), request body, response status, response headers, response body (clone response before consuming; truncate at 50 KB)
- Override `XMLHttpRequest` open/send similarly
- Post each captured event to content.js via `window.dispatchEvent(new CustomEvent('__flowsnap_capture__', { detail: payload }))`

`content.js` must:
- Listen for `__flowsnap_capture__` events
- Buffer captured logs and network calls in memory arrays `pendingLogs[]` and `pendingNetworkCalls[]`
- When sending `CAPTURE_AND_SAVE_STEP`, include `consoleLogs: pendingLogs` and `networkCalls: pendingNetworkCalls`, then clear both arrays

`background.js` must:
- Accept and store `consoleLogs` and `networkCalls` on each step object

Apply these guardrails:
- Truncate requestBody/responseBody at 50 KB: `body.length > 51200 ? body.slice(0, 51200) + '[truncated]' : body`
- Redact sensitive headers: replace value with `"[redacted]"` for keys matching `/^(authorization|cookie|set-cookie|x-api-key)$/i`

---

### Feature 2: Step Editing

**Data change in background.js:** When saving a step, store both the raw screenshot and the annotated one:
```js
step.screenshotOriginal = rawScreenshot; // before annotation
step.screenshot = annotated;             // after annotation (existing field)
step.highlightBox = payload.elementInfo.boundingBox; // store separately
```

**viewer.js changes:**

For each step card, add three edit controls:

1. **Edit Highlight** button: Opens an overlay editor on the step image. Render the original screenshot (`screenshotOriginal`) in a `<canvas>`. Draw the current `highlightBox` as a draggable/resizable div overlay. On save: call `chrome.runtime.sendMessage({ type: 'ANNOTATE_SCREENSHOT', screenshot: step.screenshotOriginal, box: newBox })` → background re-annotates → update step in storage.

2. **Edit Title** (click-to-edit on the action text): Convert `<p class="action">` to `<input>` on click, persist on blur/Enter.

3. **Edit Info** (click-to-edit on the metadata block): Same pattern.

4. **Replace Image** button: File input → load as dataURL → update `step.screenshot`, clear `step.screenshotOriginal` and `step.highlightBox`.

Persist all edits to `chrome.storage.session` immediately on each change. Re-render the step card after any edit.

---

### Feature 3: Export Filters

Add a filter bar to viewer.html above the steps list:
```html
<label><input type="checkbox" id="opt-images" checked> Include screenshots</label>
<label><input type="checkbox" id="opt-network" checked> Include network calls</label>
<label><input type="checkbox" id="opt-logs" checked> Include console logs</label>
```

Persist checkbox state to `chrome.storage.local` (key: `exportOptions`). Load on viewer init.

In `viewer.js`, read filter state before each export:
```js
const opts = { images: true, network: true, logs: true }; // load from checkboxes
```

Pass `opts` to all export functions. Each function must:
- Skip screenshot data when `opts.images === false`
- Omit `networkCalls` block when `opts.network === false`
- Omit `consoleLogs` block when `opts.logs === false`

In Markdown output, wrap network and log sections in `<details>` tags (collapsible). Use fenced code blocks with `json` syntax for request/response bodies.

---

### Feature 4: .gitignore in ZIP

In `lib/zip.js`, modify `createZip()` to always prepend a `.gitignore` file:

```js
function createZip(files) {
  const allFiles = [{ name: '.gitignore', data: '*\n' }, ...files];
  // rest of existing logic using allFiles
}
```

No other changes needed. This applies only to ZIP exports.

---

### Feature 5: Editable Download Filename

Add a filename modal to viewer.html:
```html
<div id="filename-modal" style="display:none">
  <div class="modal-backdrop"></div>
  <div class="modal-box">
    <label>File name</label>
    <input type="text" id="filename-input" />
    <span class="ext-label" id="filename-ext">.zip</span>
    <button id="filename-confirm">Download</button>
    <button id="filename-cancel">Cancel</button>
  </div>
</div>
```

In `viewer.js`:
- Replace direct export calls with a `promptAndExport(type)` function
- `type` is one of `'zip' | 'md' | 'json'`
- Set `#filename-input` value to the default name (current auto-generated), set `#filename-ext` to the suffix
- On confirm: sanitize input, call the appropriate export function with the sanitized name

Sanitization function:
```js
function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '').trim().replace(/^\.+|\.+$/g, '') || 'flowsnap-flow';
}
```

Apply `sanitizeFilename` to the user input before passing to the download trigger. Always append the correct extension in the exporter, never let the user control the extension.

---

### Acceptance Criteria

- [ ] Console logs captured from page context (MAIN world) and attached per step
- [ ] Network calls (fetch + XHR) captured with request/response bodies, 50 KB cap, header redaction
- [ ] Highlight box is a draggable/resizable overlay in the viewer (not baked-in only)
- [ ] Step title and info text are inline-editable and persisted
- [ ] Replace image button works
- [ ] Export checkboxes filter all three export formats consistently
- [ ] Every ZIP contains `.gitignore` with content `*`
- [ ] Filename modal appears before every download with correct default and sanitization
- [ ] No regressions in existing record → capture → annotate → export flow

**PROMPT END**

---

## File Structure After v2

```
manifest.json                  (add page-injector.js content script entry)
background.js                  (store screenshotOriginal + highlightBox; accept consoleLogs/networkCalls)
content.js                     (buffer logs/network from page-injector; clear per step)
lib/
  selector.js                  (unchanged)
  exporter.js                  (add opts filtering; add network/log Markdown sections)
  annotator.js                 (unchanged — re-used for re-annotation on highlight edit)
  zip.js                       (prepend .gitignore entry)
  page-injector.js             (NEW — MAIN world; patches console + fetch + XHR)
popup/
  popup.html / popup.js        (unchanged)
viewer/
  viewer.html                  (add filter checkboxes; add filename modal)
  viewer.js                    (editStep functions; promptAndExport; pass opts to exporters)
styles/overlay.css             (unchanged)
```
