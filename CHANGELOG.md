# Changelog

Notable changes to FlowSnap. Format follows [Keep a Changelog][kac]; versions
follow [semantic versioning][semver].

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [2.3.0] — 2026-08-23

A step no longer just says *a button was clicked*. It says which React component
that button was in, and which file that component was written in.

### Added

- **Every step names the React component it happened in.** The nearest component
  is rarely the one anybody means — clicking a MUI button lands on `ButtonBase`,
  clicking a Radix item lands on `Primitive.div` — so the step is attributed to
  the nearest component you own, with the surrounding chain kept beside it as the
  evidence for that choice.
- **And the file that component was written in, on a minified production
  build.** FlowSnap fingerprints the component function as the page has it, finds
  that fingerprint in a script the page already loaded, and reads that script's
  source map back to `src/components/Cart.tsx:34`. It happens while you record,
  when the page is still open and its bundles are still warm in the cache —
  waiting for Stop would mean fetching from a tab that may be closed and a
  session that may have expired.
- **The answer reaches every reader.** The component is on the step card and in
  the detail panel, in the Markdown, the JSON, the ZIP and the payload sent to
  Claude — with the table of source paths written once per flow rather than
  repeated on all twenty steps. `get_flow` and `get_flow_errors` now say the
  paths are there, which is what turns "open `src/components/Cart.tsx`" into
  something an assistant does instead of searching the repository for it.
- **A component with no path says why it has none.** Its chunk never loaded, the
  site ships no source maps, the fingerprint matched two places, the flow ended
  first — each is a sentence on the step. A blank where a path should be reads as
  *this component has no source file*, which is a different and untrue claim.
- **Open in editor.** Set a project root in Settings and each recorded path
  becomes a link that opens that file at that line. VS Code, Cursor, Windsurf,
  Zed, Sublime, JetBrains, or a link template of your own.
- **Settings for both halves.** Recording components and looking their files up
  are separate switches, both on by default: naming a component costs nothing on
  a page that is not React, and the lookup reads scripts the page already
  fetched and uploads nothing. With the lookup off, steps still name their
  components and say that is why they stop there.

### Developer

- `src/core/react/` — the resolution engine, ported from the sibling extension
  `react-source-locator` with its provenance and divergences recorded in each
  file's header. The largest divergence is a **streaming** source-map decode:
  against a real 9.3 MB map, decoding the whole thing costs 54 MB of heap, while
  streaming to the one line that matters costs none — and an MV3 worker that
  overruns is killed with no warning and nothing to report.
- Component capture is gated three times over: not recording, not React, or
  switched off, and no listener is ever attached. Measured against the real
  modules, a 12-deep chain costs 0.029 ms cold and 0.003 ms warm.
- The resolver writes only its own two storage keys. `recordedSteps` is rewritten
  wholesale by the capture queue, and two writers on one key lose each other.
- Three fixes found while building this were back-ported to `react-source-locator`
  and released there as 2.2.0: the streaming decode, the `[native code]` needle
  guard, and cutting bundler namespaces out of a normalised source path.
- `docs/SHARED-CORE.md` and `npm run core:drift` for the six files shared by copy
  with that extension. Extracting them into a package was designed and dropped —
  four of the differences between the copies are deliberate, and the line base in
  particular fails silently when confused. Neither affects the built extension.
- 530 tests, 41 files.

## [2.2.0] — 2026-08-22

Two things the viewer decided for you, and the screenshot you needed but the
recorder missed.

### Added

- **Send to Claude asks what to hand over.** It used to POST the whole
  recording the moment it was pressed — the same choice-made-for-you the export
  buttons were before they grew a dialog. The same three switches now appear,
  priced the way this destination charges: an upload in bytes and a context cost
  in tokens. Screenshots default on and network bodies and console logs off, the
  opposite of the export defaults, because the server writes images to disk and
  Claude pays only for the ones it opens, while bodies and logs are read back
  with every step and are most of the context on a chatty API. Parts you switch
  off are dropped before the request, not by the server afterwards.
- **A step can take a screenshot you supply.** The recorder captures on a timer
  and a timer misses things: a menu that closes on blur, a toast that lasted
  800ms, a modal already gone when the shutter fired. Drop an image on the card,
  paste one, or pick a file. A step whose capture failed now offers this instead
  of showing nothing, and replacing a screenshot is undoable from the toast.
- **Imported screenshots are marked as imported**, on the card and in the
  Markdown alt text. A screenshot is read everywhere as evidence of what the
  page looked like; for one supplied by hand that is a claim nobody checked.

### Changed

- **A screenshot shows the whole capture** rather than 320px cropped from the
  top. The crop landed mid-content often enough that the one thing a step was
  recorded to show could be the part below the cut, and a cropped shot is
  indistinguishable from a short page. Length is the price, and the rail jumps
  between steps, so it is paid by scrolling nobody has to do.
- **The step rail is a sidebar the height of the viewport**, with the filters on
  its floor. It was sized to its content, so a five-step flow drew a short box
  floating in an empty column and put the filters wherever the last row ended.
- **The rail is wider — 280px, from 208px.** At the old width rows truncated
  inside the quoted label, which is the part that says which step a row is.
- **Imported images are re-encoded** to a viewport-sized JPEG rather than kept
  as they arrived, so one step's picture cannot cost more than the other thirty
  together. SVG is refused: it is a document that can script and fetch.

### Fixed

- **Filtering the step list slid the layout sideways.** Narrowing to one step
  made the page short enough to lose its scrollbar, moving the chip you had just
  pressed out from under the pointer. The gutter is now always reserved.
- **Two console warnings per chunk on every viewer load.** Vite emits
  `modulePreload` tags with `crossorigin`, which Chrome discards on a
  `chrome-extension://` page. The hints bought nothing — the files are already
  on disk beside the page — so they are no longer emitted.

## [2.1.0] — 2026-08-15

Connecting FlowSnap to Claude Code no longer means installing FlowSnap.

### Added

- **The MCP server ships to npm as `flowsnap-mcp`.** One command connects it —
  `claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp` — with no clone,
  no build and no path to configure, in the CLI and the VS Code extension alike.
  It is published from the release tag at the same version as the extension.
- **`get_flow_errors`** returns only the steps that failed: console errors,
  failed and 4xx/5xx requests with their bodies, the element involved and the
  screenshot path. It is the tool to call first when something broke, and it is
  a fraction of the size of the whole recording.
- **`schemaVersion` on the POST payload.** The server updates itself through
  `npx` while the extension is installed by hand, so the two are no longer
  guaranteed to be the same pair and the wire format needs to say which it is.
- **`FLOWSNAP_DIR` and `FLOWSNAP_PORT`** override where flows are written and
  which port receives them.

### Changed

- **Flows are stored in `~/.flowsnap/flows`, not inside the package.** Under
  `npx` the package directory is a cache that is cleared without warning, which
  would have taken every recording with it. Existing flows under
  `mcp-server/flows/` stay where they are; move them across to keep them.
- **Screenshots are handed over as absolute paths rather than base64.**
  `get_flow` previously offered every image inline, which at the current
  500-step limit is tens of megabytes of context for data the caller may not
  need. Claude Code reads the files itself, one at a time.
  `get_flow_screenshots` still returns images for callers with no filesystem,
  capped at eight per call and requiring the steps to be named.
- **The annotated screenshot is the one written to disk**, not the clean
  original. The highlight is what says which element was clicked.
- **Failing to send now says the server is not running and that the flow is
  saved** — it was a retry being reported as a loss, and it referred to a
  `npm start` that no longer applies.

### Fixed

- **A second Claude session killed the first one's server.** Every session runs
  its own copy, all of them bound the same port, and the loser died on an
  unhandled `EADDRINUSE` — which surfaced exactly when the server became
  installable across every project. Losing the race is now survivable: one
  process receives, all of them read the same directory.
- **Screenshot writes were not awaited**, so `POST /flows` could answer before
  the images existed and a tool call immediately after would miss them.
- **`get_flow_screenshots` numbered steps by file index**, mislabelling every
  image after a step whose capture failed.
- **Flow ids were concatenated into a path unchecked**, so `../` in an id
  escaped the flows directory.

## [2.0.0] — 2026-08-15

The extension was rebuilt. Same idea — record a browser session, hand it to an
AI — with a different architecture, a different interface, and eight defects
closed that made recordings silently wrong.

### Fixed

Each of these produced missing or incorrect data with no error shown.

- **Recording stopped when you switched tabs.** State lived in one tab's
  content script; it now lives in storage, which every tab watches, so a
  recording follows you.
- **Screenshots could come from the wrong tab.** Captures took whatever window
  had focus rather than the window being recorded.
- **A click that navigated screenshotted the destination**, while the step text
  described the element clicked on the page you left. Those interactions now
  capture on pointerdown and the click claims that frame.
- **Start reported success on pages that cannot be recorded.** `chrome://`
  pages, the Web Store and tabs opened before the extension was installed all
  reported a recording in progress and captured nothing. The popup now checks
  before you press it and says which case it is.
- **Storage failures were invisible.** `chrome.runtime.lastError` was checked
  once in the whole codebase and never on a write, so at the quota every save
  failed quietly while the UI carried on.
- **The recording indicator was baked into every screenshot.** It is removed
  and the removal painted before each capture.
- **Any page could forge console and network entries** into your flow.
- **Typing in two fields could drop one**, because a single global debounce
  timer was shared across every input.

### Changed

- **Storage is no longer capped at 10 MB.** The manifest asks for
  `unlimitedStorage`; the only ceiling is your disk. The storage meters became
  plain figures, because a bar needs a denominator.
- **Recordings are no longer capped at 30 steps.** `MAX_STEPS` is now a runaway
  guard at 500 rather than a product limit, chosen by measuring what a capture
  costs at that length. The popup mentions export weight at 150 instead of
  counting down to a cap.
- **Screenshots are never dropped to save space.** The worker used to discard
  images past an 8 MB budget, so long recordings quietly degraded into steps
  with no pictures.
- **The viewer is two screens, not one scrolling document** — a library you
  choose from and a review you inspect in, with a step rail, filters, and
  collapsed network and console detail.
- **Settings moved to their own page**, out of a disclosure triangle beneath
  the recording controls.
- **Every surface was redesigned** on a token-based system with light and dark
  themes, vendored fonts, and generated icons. One red no longer means
  "record", "delete" and "failed" at once.
- **Exports collapse into one dialog** with a live size estimate and an
  editable filename, replacing three separate format buttons.
- **Flows sent to the MCP server are opt-in.** Stopping a recording used to
  upload it automatically. Captured request and response bodies are still not
  redacted — headers are — which the setting now says before you enable it.
- **Edits to a saved flow persist.** Renames, notes and step deletions were
  previously discarded.

### Added

- Flow library with search, sorting, thumbnails and per-flow error counts.
- Annotation editor with arrow, box, blur and redact tools; redact rewrites
  pixels rather than covering them.
- Undo for deletions.
- Keyboard navigation through steps, and a shortcut sheet.
- A theme preference that applies before first paint.

### Removed

- The `New recording` button in the library. The viewer is an extension page,
  so a recording started there always targeted a tab Chrome blocks. Recording
  begins from the toolbar, on the tab being recorded.

### Developer

- TypeScript throughout, `strict`, built with Vite. 257 tests.
- `chrome.*` is called only from `src/chrome/`; everything else receives a
  `Result<T>`.
- `npm run verify` — typecheck, lint, token guard, tests and all three builds.
  CI runs the same command.
- Tagging `v*` builds and attaches a loadable zip to a GitHub release.

## [1.0.0]

Initial JavaScript build.

[2.0.0]: https://github.com/ansh-n-chovatiya/Flow-Recorder/releases/tag/v2.0.0
