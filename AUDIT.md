# FlowSnap — Architecture Audit & Migration Plan

**Phases 1–3: audit, comparison, proposed architecture.**

| | |
|---|---|
| Audited | 15 August 2026 |
| Subject | Chrome Flow Recorder Extension @ `8c3f9a7` |
| Reference | `react-source-locator` v2.1.0 |
| Source read | 2,916 lines across 13 files |
| Files changed | none at audit time; migration step 1 has since landed on `refactor/architecture` |

---

## Contents

1. [Verdict](#verdict)
2. [How it actually works today](#1--how-it-actually-works-today)
3. [File inventory](#2--file-inventory)
4. [Findings](#3--findings)
5. [The reference gap](#4--the-reference-gap)
6. [Principles worth carrying over](#5--principles-worth-carrying-over)
7. [Proposed structure](#6--proposed-structure)
8. [Migration map](#7--migration-map)
9. [Migration order](#8--migration-order)
10. [Feature triage](#9--feature-triage)
11. [CI and release](#10--ci-and-release)
12. [UI states to design](#11--ui-states-to-design)
13. [Open decisions](#12--open-decisions)

---

## Verdict

**The product is better than the repository.** FlowSnap does something React Source Locator does not: it captures a real, annotated, network-and-console-aware record of a user journey and hands it to an AI. The capture logic is thoughtful — the queue serialisation, the storage budget guard, the schema compaction for token-lean exports, the MAIN-world injector. These are the parts someone clearly reasoned about, and they get preserved.

What is missing is everything around it. There is no `package.json`, no build, no types, no lint, no tests, no CI, no release, and no module system: three of the five `lib/` files carry a comment forbidding you from wrapping them in a module, because the code depends on `<script>` tag order and shared global scope. The 1,311-line `viewer.js` holds the entire flow-management product — save, load, delete, edit, annotate, export, transmit — in one file with no seam between UI and Chrome APIs.

**Seven correctness defects** are visible in the source without running the extension, and four of them fail silently: recording stops working when you switch tabs, screenshots can come from the wrong tab, storage writes are never checked for failure, and starting a recording on a page with no content script reports success. These are the things to fix under the redesign, not after it.

---

## 1 — How it actually works today

Reconstructed from source, not from the README — which documents a v2 plan rather than the shipped behaviour, and is wrong about the storage area.

```
page-injector.js  MAIN world, document_start. Monkey-patches console, fetch,
                  XMLHttpRequest. Relays via postMessage.
       ↓
content.js        Isolated world. Buffers logs/network, listens for
                  click/input/change, describes the target, builds a step.
       ↓
background.js     Serialised queue → 150 ms settle → captureVisibleTab →
                  annotateScreenshot → storage.local → badge.
       ↓
viewer.html       Reads recordedSteps, renders cards, edits, saves named
                  flows, exports ZIP/MD/JSON, POSTs to MCP.
       ↓
mcp-server        Node HTTP receiver on :7734 + stdio MCP. Writes
                  flows/<id>/ and re-derives its own Markdown.
```

### State, in full

All extension state is four keys in `chrome.storage.local` — `recordingActive`, `recordingPaused`, `recordedSteps`, `exportOptions` — plus `savedFlowsMeta` and one `savedFlow_<id>` key per archived flow, and `mcpServerUrl` in `chrome.storage.sync`.

There is no state machine; recording state is derived independently in four places from the same two booleans. The README's claim that screenshots live in `chrome.storage.session` is incorrect — they are in `local`, which is why the 8 MB budget guard exists.

### What genuinely works and must be preserved

- **Semantic action descriptions** — `resolveTarget` walking up to four hops to the real interactive ancestor, Lucide icon-name mapping, toggle state, accessible-name resolution. This is the quality difference versus a naive recorder.
- **Screenshot annotation in the service worker** via `OffscreenCanvas` + manual base64 — genuinely non-obvious MV3 work.
- **Schema inference in `compactBody`**, including sibling-based enum detection. This is what keeps AI exports token-lean.
- **The dependency-free ZIP writer** with optional `deflate-raw` and image pass-through.
- **The canvas image editor** — pen, rect, ellipse, arrow, highlight, pixelate-blur, text — with the blur tool being a real PII control.
- **Header redaction** in the injector, and password masking on input capture.

---

## 2 — File inventory

| File | Lines | Verdict | Reasoning |
|---|---:|---|---|
| `viewer/viewer.js` | 1311 | **Split** | Six unrelated products in one file: rendering, step editing, canvas editor, export, saved-flow store, MCP transport. |
| `viewer/viewer.html` | 1026 | **Split** | ~950 lines of embedded CSS, 89 rule blocks, plus inline styles on the save-flow modal. No tokens. |
| `content.js` | 413 | **Keep, split** | The domain logic is good. Separate event capture, target description and transport. |
| `lib/exporter.js` | 275 | **Keep, split** | Schema inference and Markdown rendering are two different concerns sharing a file. |
| `background.js` | 206 | **Keep, split** | Capture pipeline, storage guard, badge and MCP transport in one worker. |
| `lib/page-injector.js` | 194 | **Keep** | Needs an origin check and a build step; logic stands. |
| `popup/popup.js` | 157 | **Rewrite** | Duplicated state derivation, polling timer, no error surface. Small enough to rebuild against the new state model. |
| `lib/zip.js` | 148 | **Keep** | Correct and self-contained. Port to TS as-is. |
| `popup/popup.html` | 136 | **Rewrite** | Embedded CSS, ID-driven show/hide, settings hidden in a `<details>`. |
| `lib/selector.js` | 99 | **Keep** | Pure functions. First thing to put under test. |
| `lib/annotator.js` | 49 | **Keep** | Move to the worker's own module tree; drop `importScripts`. |
| `styles/overlay.css` | 41 | **Keep** | Retheme against tokens. |
| `mcp-server/server.js` | 329 | **Extract** | A Node service living inside a browser-extension repo, with its own lockfile, Dockerfile and fly.toml. See decision 3. |
| `package-lock.json` | 6 | **Delete** | A lockfile with no `package.json` and no packages. |
| `.mcp.json` | 9 | **Fix** | Hardcodes `/Users/user2/Desktop/Chrome Flow Recorder Extension` — the wrong path. The server cannot start from a clone. |
| `README.md` | 462 | **Replace** | It is an implementation prompt for features that already shipped, not documentation. |
| `mcp-server/flows/` | 125 dirs | **Purge** | Gitignored but present in the working tree — recorded flows of real sessions, i.e. potential PII on disk. |

---

## 3 — Findings

Seven correctness defects, ten fragilities, four duplications, six repository gaps. Every one is cited to a line.

### Correctness — these produce wrong or missing data

#### C1 · Recording silently stops when you switch tabs

The content script reads `recordingActive` once, at injection time, and otherwise only learns about state through runtime messages. The popup sends those messages to the active tab only. A tab that was already open when recording started never becomes a recorder — clicks in it produce nothing, with no indicator and no error. This also means a flow spanning two tabs is impossible.

> `content.js:66` (load-time read) · `content.js:37` (message-only updates) · `popup.js:57` (`tabs.query({active:true})`)

#### C2 · Screenshots can be captured from the wrong tab

`captureVisibleTab(null, …)` captures the active tab of the *current* window, which for a service worker is whichever window last had focus — not the tab the step came from. The `sender` object carrying the true `tabId`/`windowId` is received and discarded.

> `background.js:36` · `background.js:169` (`sender` unused)

#### C3 · Screenshot quota is exceeded under normal clicking

Chrome rate-limits `captureVisibleTab` to roughly two calls per second. The queue delays each capture by 150 ms, allowing up to ~6/s. Excess calls reject, the error is caught, and the step is saved with `screenshot: null` — the user sees steps missing images and is told nothing.

> `background.js:7` (`SETTLE_DELAY_MS = 150`) · `background.js:34–41` (error swallowed)

#### C4 · A click that navigates screenshots the next page

The capture happens 150 ms after the click, by which time a link or submit may have painted a new document. The step's text describes the element clicked; the image shows the destination; the highlight box is drawn at coordinates from the old layout. The most common flow — clicking through pages — is the one that misfires.

> `content.js:122` → `background.js:45`

#### C5 · Start reports success on pages that cannot record

`sendToTab` catches the "no receiving end" failure and warns to a console nobody reads. The popup then flips to "Recording in progress" regardless. This happens on `chrome://` pages, the PDF viewer, the Web Store, and every tab opened before the extension was installed or reloaded.

> `popup.js:57–65` · `popup.js:82–86`

#### C6 · Any page can forge console and network entries

The `message` listener accepts anything carrying `__flowsnap_source__: 'page-injector'` without checking `event.source === window` or the origin. A cross-origin iframe, or the page's own script, can inject fabricated network calls and log lines into the recording — which then flow into an AI's context as if observed.

> `content.js:14–17` · `page-injector.js:11` (`postMessage(…, '*')`)

#### C7 · Storage failure is invisible

`chrome.runtime.lastError` is checked exactly once in the entire codebase, and not on any write. `storage.local` has a 10 MB quota and no `unlimitedStorage` permission, so at the limit every `set()` fails quietly: steps stop being appended, saved flows are not written, and the UI carries on as if they were.

> One `lastError` check, at `viewer.js:1183` · writes at `background.js:24`, `viewer.js:493/1116/1156`, `popup.js:83`

### Fragility — works today, breaks under change

#### F1 · One global input debounce timer drops fields

A single module-level `inputDebounceTimer` is shared by every input on the page. Tab from email to password inside 800 ms and the email step is discarded — the timer is reset and only the last field is recorded. Filling a form fast loses steps.

> `content.js:129–141`

#### F2 · Every step stores two copies of its screenshot

`screenshot` and `screenshotOriginal` are both persisted so the image editor can start from an unannotated base — halving effective capacity for a feature most steps never use. The 30-step cap and the 8 MB budget are both consequences of this.

> `background.js:94–97` · `exporter.js:224` (stripped again on export)

#### F3 · Saved flows starve live recording

The budget guard measures `getBytesInUse(null)` — the whole area, including every archived flow. Archive three recordings and new steps stop getting screenshots, with only a `console.warn` to explain it.

> `background.js:78–92` · `viewer.js:1155`

#### F4 · Worker termination drops queued captures

`captureQueue` is a module global in an MV3 worker that Chrome kills after ~30 s idle. Anything mid-flight at that moment is lost, and the queue restarts empty.

> `background.js:13`

#### F5 · Three files forbid being modules

`selector.js`, `exporter.js` and `zip.js` each carry a comment instructing you not to wrap them in a module, because their consumers rely on shared global scope and `<script>` ordering. Reordering two tags in `viewer.html` breaks the app at runtime with no build-time signal.

> `selector.js:2–5` · `exporter.js:2–5` · `zip.js:1–3`

#### F6 · Step numbers go stale after deletion

`stepNumber` is baked in at capture time. Deleting a step in the viewer renumbers nothing, so exports carry gaps and the JSON disagrees with the Markdown.

> `background.js:98` · `viewer.js:487`

#### F7 · Edits to a saved flow are silently discarded

In viewing mode, delete, rename, note and image edits all skip persistence by design, and "Clear All" quietly means "leave viewing mode". Nothing in the UI says the flow is read-only.

> `viewer.js:492, 515, 525, 1297–1304`

#### F8 · Stopping a recording auto-uploads it

Every stop POSTs the entire flow — screenshots, request and response bodies — to `mcpServerUrl`, with no confirmation and no visible result. The URL is user-settable and host permissions are `<all_urls>`, so a mistyped or remote value ships the session off-machine. Headers are redacted; bodies are not.

> `background.js:118–139, 151–161` · `page-injector.js:19` (headers only)

#### F9 · The 30-step cap is invisible until it fires

The limit is hardcoded, and reaching it terminates the recording and appends a synthetic `note` step. The warning at 25 goes to the console. Nothing in the popup counts down.

> `background.js:5–6, 54–67`

#### F10 · The popup polls once a second and also subscribes

Both a 1 s `setInterval` and a `storage.onChanged` listener refresh the same UI, each re-deriving state with duplicated logic.

> `popup.js:79` and `popup.js:126–136`

### Duplication

#### D1 · Two Markdown generators that disagree

The extension renders one dialect (compact, 📍 page markers, schema-compacted bodies, console filtered to errors and warnings); the MCP server independently renders another (verbose headings, first three network calls, no console). The same flow reads differently depending on the route.

> `exporter.js:178–275` vs `mcp-server/server.js:30–63`

#### D2 · MCP endpoint defined in three places

`DEFAULT_MCP_HTTP` and its `storage.sync` getter are copied in the worker and the viewer; the popup hardcodes the same literal a third time.

> `background.js:110–116` · `viewer.js:1197–1203` · `popup.js:146`

#### D3 · State derivation written four times

The `recordingActive ? (recordingPaused ? 'paused' : 'recording') : 'idle'` ternary appears twice in the popup alone, and the step-count read is repeated in all four button handlers.

> `popup.js:71, 92, 100, 108, 132`

#### D4 · Near-identical export functions

`exportToMarkdown` and `exportToMarkdownWithRefs` differ only in how an image is referenced. `pad2` is defined in both the viewer and the server. `escapeHtml` is defined and never used.

> `exporter.js:178` vs `249` · `viewer.js:924`, `server.js:28` · `viewer.js:12` (dead)

### Repository and process

| # | Gap | Consequence |
|---|---|---|
| P1 | No `package.json`, build, TypeScript, lint, tests or CI | `npm install && npm run dev` — the workflow you asked for — does not exist. Every defect above is only findable by reading. |
| P2 | `.mcp.json` points at a path that does not exist | The MCP server never starts for anyone who clones, including you on a new machine. |
| P3 | Version lives only in `manifest.json`; no tags, no `CHANGELOG`, no `LICENSE`, no `.github/` | Nothing to release and nothing to release it from. |
| P4 | 125 recorded flow directories in the working tree | Real session data — screenshots, URLs, response bodies — sitting in the repo folder, one `git add -f` from being published. |
| P5 | README is a v2 build prompt with a factual error about storage | No install path, no development instructions, and it misleads the next reader. |
| P6 | Four names for one product | Directory "Chrome Flow Recorder Extension", manifest "FlowSnap", remote "Flow-Recorder", MCP id "flowsnap". Pick one before the README is written. |

---

## 4 — The reference gap

React Source Locator is a comparable-scope extension — 4,045 lines of TypeScript against FlowSnap's 2,916 of JavaScript. The difference is not size.

| Dimension | React Source Locator | Chrome Flow Recorder |
|---|---|---|
| Language | TypeScript, `strict` + `noUnusedLocals` + `verbatimModuleSyntax` | JavaScript, no checking of any kind |
| Build | Vite, two configs (ESM bundle + IIFE agent), `chrome116` target | None — source files are the artifact |
| Modules | ES modules with explicit imports throughout | Global scope by script-tag order, explicitly enforced by comment |
| Shared contracts | `src/shared/`: `types.ts`, `messages.ts`, `constants.ts` | String literals repeated at each site; no message types |
| Message passing | Typed `sendMessage<T>` with a `ResponseByType` map, `lastError` handled once | Untyped `sendMessage`; response shapes implicit; `lastError` checked once in total |
| UI structure | Named views (`idle`/`picking`/`locating`/`result`/`error`) with one `show()` | Ad-hoc `classList.add('hidden')` across six buttons; no error view exists |
| Styling | Token file + one stylesheet per view, both themes | ~1,000 lines embedded in two HTML files, plus inline styles; light only |
| Tests | Vitest over the six pure modules | None |
| CI | Typecheck, lint, test, build, version-drift check, icon-drift check, artifact upload | None |
| Release | Tag-gated, version verified against tag before publishing, zip attached to a GitHub Release | None |
| Docs | README with install/quick-start/architecture/troubleshooting, `CHANGELOG`, `LICENSE` | README is an unexecuted build prompt |

---

## 5 — Principles worth carrying over

Extracted from the reference, not copied from it. FlowSnap is a bigger product than RSL — it has persistence, list management and an editor — so it needs one layer RSL does not.

1. **A shared contract module that both sides import.** RSL's `ResponseByType` map makes a wrong response shape a compile error. FlowSnap's messages are richer — they carry steps, screenshots and boxes — so the payoff is larger.
2. **One wrapper for each Chrome API surface, and no direct calls outside it.** RSL wraps `sendMessage` once and handles `lastError` there. That single habit fixes C7 across the whole codebase.
3. **Named views with one switch.** The popup and viewer both need this, and it is what makes error, loading and empty states cheap to add rather than retrofitted.
4. **Pure core, effectful edges.** RSL's tests cover exactly the modules with no `chrome.*` in them. FlowSnap has more such modules than RSL does — selectors, schema inference, Markdown, ZIP, action description — and none are tested.
5. **Tunables in one constants file with a comment explaining each.** `MAX_STEPS`, `SETTLE_DELAY_MS`, `STORAGE_BUDGET`, `SCHEMA_THRESHOLD`, `BODY_CAP` are currently scattered across four files.
6. **Tokens before styles, one stylesheet per view.** This is what makes the Stitch redesign implementable state-by-state instead of as one rewrite.
7. **CI verifies what humans forget:** version agreement across files, generated assets being current, the build actually producing a loadable directory.

### Where FlowSnap must diverge

RSL is stateless between picks — it has nothing to persist. FlowSnap owns durable user data, which means it needs a genuine storage layer with a schema version and a migration path, something the reference offers no pattern for. That layer is the one addition to RSL's shape, and it is also what protects the 125 flows already on disk.

---

## 6 — Proposed structure

Four layers, enforced by directory: shared contracts, pure core, Chrome integration, UI. Imports run inward only.

```
flow-recorder/
├── public/
│   ├── manifest.json              — static; version synced by script
│   └── icons/
├── src/
│   ├── shared/                    — imported by every layer, imports nothing
│   │   ├── types/
│   │   │   ├── flow.ts            — Flow, FlowMeta, StoredFlow
│   │   │   ├── step.ts            — Step union: click | input | navigate | note
│   │   │   ├── capture.ts         — NetworkCall, ConsoleEntry, ElementRef
│   │   │   ├── session.ts         — RecordingSession state machine
│   │   │   └── index.ts
│   │   ├── messages.ts            — request union + ResponseByType + typed send
│   │   ├── constants.ts           — every tunable, each with a why
│   │   ├── result.ts              — Result<T, FlowError>; no throwing across layers
│   │   └── errors.ts              — FlowError codes → user-facing copy
│   │
│   ├── core/                      — pure. no chrome.*, no DOM. this is the test target
│   │   ├── selector/              — css path, xpath, stability scoring
│   │   ├── describe/              — resolveTarget, accessibleName, icon names
│   │   ├── schema/                — inferType, compactBody
│   │   ├── export/                — markdown.ts, json.ts, zip.ts, filename.ts
│   │   └── flow/                  — renumber, validate, migrate, duplicate
│   │
│   ├── chrome/                    — the only place chrome.* is typed and called
│   │   ├── storage.ts             — typed get/set, lastError, quota errors → Result
│   │   ├── tabs.ts                — capture, query, injection checks
│   │   ├── scripting.ts           — inject into tabs open before install (fixes C5)
│   │   ├── downloads.ts
│   │   └── runtime.ts             — port + message helpers
│   │
│   ├── features/                  — orchestration; composes core + chrome
│   │   ├── recording/             — session machine, capture queue, step limit
│   │   ├── flows/                 — repository: list, save, rename, delete, duplicate
│   │   ├── export/                — option resolution, artifact assembly
│   │   └── integrations/mcp/      — transport, health check, explicit consent
│   │
│   ├── background/                — worker entry; wires features to events
│   │   ├── index.ts
│   │   ├── capture-queue.ts
│   │   └── annotator.ts
│   │
│   ├── content/                   — isolated world
│   │   ├── index.ts
│   │   ├── listeners/             — click, input (per-element debounce), change, nav
│   │   ├── indicator.ts
│   │   └── bridge.ts              — origin-checked postMessage intake (fixes C6)
│   │
│   ├── injected/                  — MAIN world, built as IIFE
│   │   └── agent.ts               — console / fetch / xhr patches
│   │
│   └── ui/
│       ├── popup/                 — main.ts + views/{idle,recording,paused,blocked,error}
│       ├── viewer/                — main.ts + views/ + components/
│       ├── components/            — shared: modal, toast, chip, empty, spinner
│       └── styles/                — tokens.css + one file per view
│
├── tests/                         — mirrors src/core/
├── scripts/                       — sync-version.mjs, generate-icons.mjs, package.mjs
├── docs/                          — ARCHITECTURE, DATA-MODEL, RELEASING, DESIGN
└── .github/workflows/             — ci.yml, release.yml
```

### Responsibilities, and the rule that keeps them

| Layer | Owns | May import |
|---|---|---|
| `shared/` | Types, message contracts, constants, error codes | Nothing |
| `core/` | Pure transformations: selectors, descriptions, schema, export, flow ops | `shared/` |
| `chrome/` | Every `chrome.*` call, each returning `Result` rather than throwing | `shared/` |
| `features/` | Orchestration and business rules — "stop recording" as a use case | `shared/`, `core/`, `chrome/` |
| `background/` `content/` `injected/` | Entry points; event wiring only | All of the above |
| `ui/` | Rendering, view switching, input handling | `shared/`, `core/`, `features/` — **never `chrome/`** |

One lint rule enforces the whole thing: `ui/` may not reference `chrome.` or import from `src/chrome/`. That is the constraint you actually asked for — no Chrome API calls scattered through components — expressed as something CI can fail on rather than a convention that erodes.

---

## 7 — Migration map

Where every existing line goes. Nothing is deleted without a destination or a reason.

| From | To | Change |
|---|---|---|
| `lib/selector.js` | `core/selector/{css,xpath,stability}.ts` | Port to TS. `isStableSelector` moves here from the exporter — it is a selector concern. |
| `content.js:206–371` | `core/describe/` | Extract as pure functions taking an `Element`. Immediately testable. |
| `content.js:87–204` | `content/listeners/` | One file per event. Input debounce becomes a `WeakMap<Element, timer>` (fixes F1). |
| `content.js:14–33` | `content/bridge.ts` | Add `event.source === window` and origin checks (fixes C6). |
| `content.js:64–73` | `content/index.ts` | Add a `storage.onChanged` subscription so any tab picks up state (fixes C1). |
| `lib/page-injector.js` | `injected/agent.ts` | Port to TS, built as IIFE by a second Vite config — RSL's exact pattern. |
| `background.js:34–106` | `features/recording/` + `background/capture-queue.ts` | Take `windowId` from `sender` (C2); token-bucket the capture rate (C3); capture on `mousedown` before navigation (C4). |
| `lib/annotator.js` | `background/annotator.ts` | Straight port; `importScripts` replaced by an import, worker becomes `type: "module"`. |
| `background.js:108–162` | `features/integrations/mcp/` | Auto-export becomes opt-in with a visible result (F8). |
| `lib/exporter.js:1–83` | `core/schema/` | Schema inference is not an export concern; the viewer uses it for display too. |
| `lib/exporter.js:85–275` | `core/export/markdown.ts`, `json.ts` | The two Markdown functions merge into one with an image-reference strategy parameter (D4). |
| `lib/zip.js` | `core/export/zip.ts` | Straight port. |
| `popup/*` | `ui/popup/` | Rebuilt against the session state machine, with `blocked` and `error` views that do not exist today (C5). |
| `viewer.js:207–451` | `ui/viewer/components/step-card/` | Split by concern: header, meta, screenshot, network, console, notes. |
| `viewer.js:568–901` | `ui/viewer/components/image-editor/` | Tools separated from canvas plumbing; the op renderer is pure and testable. |
| `viewer.js:1048–1177` | `features/flows/repository.ts` | Becomes the flow store, with quota handling, rename, duplicate, and writes that actually persist in viewing mode (F7). |
| `viewer.js:903–1046` | `features/export/` + `ui/viewer/views/export/` | Option resolution splits from the download mechanism. |
| `viewer.html` CSS | `ui/styles/` | Replaced wholesale by the Stitch design system; this is where phases 4–6 land. |
| `styles/overlay.css` | `content/indicator.css` | Retheme against tokens. |
| `mcp-server/server.js:30–63` | *(deleted)* | The server consumes `flow.md` produced by `core/export`; one dialect, not two (D1). |
| `package-lock.json`, `README.md` | *(deleted / rewritten)* | See inventory. |

### Backward compatibility

The stored step shape is preserved exactly, and `core/flow/migrate.ts` stamps `schemaVersion: 1` onto existing unversioned data on first read. The 125 flows in `mcp-server/flows/` and every `savedFlow_*` key keep working.

The two field changes worth making — dropping `screenshotOriginal` in favour of a single image plus a replayable annotation op-list (F2), and deriving `stepNumber` instead of storing it (F6) — are both handled by the migration, not by a break.

---

## 8 — Migration order

Each step leaves a loadable extension. No step mixes a move with a behaviour change.

| Step | Work | Proof it worked |
|---:|---|---|
| 1 | Toolchain only: `package.json`, Vite (two configs), `tsconfig`, ESLint, Vitest, `.gitignore`. Existing files copied into `src/` and renamed `.ts` with checking relaxed. | `npm run build` produces a `dist/` that loads and behaves identically. |
| 2 | Extract `shared/` — types, message union, constants — and adopt them at every call site. No logic moves. | Typecheck passes at `strict`. Every message literal is gone. |
| 3 | Extract `core/`: selector, describe, schema, export, zip. Pure, no `chrome.*`. | First test suite — selectors, schema inference, Markdown snapshots, ZIP round-trip. |
| 4 | Introduce `chrome/` wrappers. Every direct call routed through them. | Lint rule passes; `lastError` handled in exactly one place (C7 closed). |
| 5 | Build `features/recording` and `features/flows`. Fix C1–C5 here, with the old UI still attached. | Manual matrix: two tabs, navigation-on-click, rapid clicking, `chrome://` page, extension reload mid-recording. |
| 6 | Design-system pass: `tokens.css` and the shared component set from the Stitch output. | Both themes render; no colour declared outside a token. |
| 7 | Popup rebuilt, state by state, against the new session machine. | Each state screenshot-matched to its Stitch design, including `blocked` and `error`. |
| 8 | Viewer rebuilt, view by view: list → detail → editor → export. | Same, plus loading and empty states that do not exist today. |
| 9 | CI, release workflow, version sync, README, CHANGELOG, LICENSE. | A pushed tag produces a downloadable zip that loads unpacked. |
| 10 | Highest-value new features from the triage below. | — |

---

## 9 — Feature triage

Judged on whether they solve a problem the audit actually surfaced. Six qualify now; the rest wait or are declined.

| Feature | Problem it solves | Cost | Verdict |
|---|---|---|---|
| Flow naming at start, not at save | Every flow is "Flow &lt;timestamp&gt;" until archived; you cannot tell two apart in the viewer | S | **Now** |
| Step reordering + insert manual step | C4 and quota misses leave gaps that currently cannot be repaired | M | **Now** |
| Import a flow JSON | Export exists with no inverse; blocks sharing and blocks testing against fixtures | S | **Now** |
| Settings view | Step cap, capture quality, redaction, MCP URL and auto-send are all hidden or hardcoded (F8, F9) | M | **Now** |
| Storage meter + quota warning | Makes F3 and C7 visible instead of silent | S | **Now** |
| Recording preflight | Tells you before you start that this tab cannot record, and offers to inject (C5) | M | **Now** |
| Body redaction rules | Headers are redacted, bodies are not; tokens and PII reach the AI export | M | Next |
| Keyboard shortcut to start/stop | Opening the popup to start recording loses focus on the page being recorded | S | Next |
| Flow duplication | Real but narrow — mostly wanted for editing a variant | S | Next |
| Onboarding | Worth doing once the redesigned empty states exist, not before | M | Next |
| **Playback / replay** | The selectors and XPaths are already captured for it, and the README implies it | L | Evaluate |
| Cross-tab flows | Falls out of the C1 fix; ship the fix, then decide if it is a feature | M | Evaluate |
| Flow history / versioning | No evidence of need; adds a second persistence model | L | Decline |
| Cloud sync | Conflicts directly with the local-first, PII-sensitive nature of the data | L | Decline |

### On playback

The data is already there — `cssSelector`, `xpath`, `value`, ordered steps — and the architecture above makes it a clean feature: a `features/playback` module driving `chrome/scripting`, with per-step status rendered by the existing step card.

But playback is a different product with its own failure surface (element gone, timing, dynamic content, auth), and it is the single largest item on this list. My recommendation is to defer it until the migration and redesign have landed, then scope it as its own phase rather than folding it into this one.

---

## 10 — CI and release

One clarification is needed here, because the requirement as written and the reference implementation disagree.

You asked for a fresh zip on *every commit*, following React Source Locator's approach. **RSL does not do that:** `ci.yml` runs on every push and uploads `dist/` as a 90-day Actions artifact, while `release.yml` runs **only on a `v*` tag**, verifies the tag matches both `package.json` and `manifest.json`, and attaches the zip to a GitHub Release.

That split is deliberate and worth keeping: a Release per commit produces dozens of indistinguishable versions all reporting the same manifest version, which is exactly the "inconsistent versions across files" problem you want to avoid. The reconciliation that satisfies both:

| Trigger | Runs | Produces |
|---|---|---|
| every push / PR | typecheck → lint → test → build → version-agreement → zip | `flow-recorder-<version>-<sha7>.zip` as an Actions artifact — downloadable from any commit, which is the "zip on every commit" you want |
| tag `v*` | the same, plus tag/version verification | `flow-recorder-v<version>.zip` attached to a GitHub Release with generated notes |
| local | `npm run package` | The identical zip, from the identical script the workflow calls — so CI and your machine cannot drift |

Version stays single-sourced in `package.json`; `scripts/sync-version.mjs` writes it into `public/manifest.json` on `npm version`, and CI fails if they ever disagree. The zip contains only `dist/` — manifest, built JS, HTML, CSS, icons — with no source, no config and no lockfile.

---

## 11 — UI states to design

The inventory the Stitch phase will work through. Screenshots have not been provided yet — this is what I will need them for.

Fifteen states exist or are implied. **Six of them have no UI at all today**, which is the more important half of the redesign: they are where C5, C7, F3 and F8 become visible to the user instead of silent.

| Surface | State | Today |
|---|---|---|
| Popup | Idle, no steps | Exists |
| Popup | Idle, steps captured | Exists |
| Popup | Recording | Exists |
| Popup | Paused | Exists |
| Popup | Blocked — this tab cannot record | **Missing** |
| Popup | Error / storage full | **Missing** |
| Viewer | Empty — nothing recorded | One line of text |
| Viewer | Loading steps | **Missing** |
| Viewer | Step list — live recording | Exists |
| Viewer | Saved flows list | Exists |
| Viewer | Viewing a saved flow (read-only today, unlabelled) | Ambiguous |
| Viewer | Image editor open | Exists |
| Viewer | Export in progress / complete | **Missing** |
| Modals | Filename, save-flow | Exists |
| Modals | Destructive confirmation (Clear All has none) | **Missing** |

Two structural notes before any Stitch prompt is written:

1. The viewer is doing three jobs — flow library, step review, and export console — in a single scrolling column with a seven-button toolbar. Separating library from review is the largest available UX win.
2. The popup's action set changes shape between states (six buttons, shown and hidden), which is why the primary action is never in a stable position.

---

## 12 — Open decisions

Five answers change the plan materially. Everything else I will decide as I go and flag.

### 1. In place, or a clean repository?

The current repo has ten commits, a remote at `ansh-n-chovatiya/Flow-Recorder`, and 125 flow directories in the working tree.

**Recommended:** migrate in place on a `refactor/architecture` branch, one commit per migration step. History is preserved, each step is revertible, and the working tree gets cleaned as step 1.

### 2. What is it called? — **decided: FlowSnap**

Four names were live: directory "Chrome Flow Recorder Extension", manifest "FlowSnap", remote "Flow-Recorder", MCP server id "flowsnap".

**FlowSnap** is the product name, the npm package name, and the release artifact name (`flowsnap-<version>.zip`). The git remote stays `Flow-Recorder`; renaming it is a GitHub-side change and breaks existing clones, so it is not worth doing for consistency alone.

### 3. Does the MCP server stay in this repo?

It is a Node service with its own lockfile, Dockerfile and fly.toml, sharing a repo with a browser extension. It also owns the second Markdown dialect (D1).

**Recommended:** keep it here as a documented workspace (`mcp-server/`, its own `package.json`, excluded from the extension build and zip). Splitting repos costs you the shared flow types for no real gain at this size. Either way the duplicate Markdown generator goes.

### 4. Fix the seven correctness defects during the migration, or after?

They are the difference between a tidier codebase and a working one, but fixing while moving makes a regression harder to attribute.

**Recommended:** as scheduled above — steps 1–4 move code with zero behaviour change, step 5 fixes C1–C5 against the old UI so any regression is unambiguous, and C6/C7 are closed structurally by the bridge and the storage wrapper.

### 5. Framework, or none? — **decided: vanilla TypeScript**

The brief mentioned React components and hooks; there were none, and the reference has none either.

FlowSnap follows react-source-locator's shape exactly: vanilla DOM, TypeScript, Vite, ES modules, no UI framework. The viewer's step list is the only genuinely stateful surface, and the reference proves a 1,000-line panel is maintainable this way.

---

*Audit of Chrome Flow Recorder Extension @ `8c3f9a7` against react-source-locator v2.1.0 · 15 August 2026 · No files modified.*
