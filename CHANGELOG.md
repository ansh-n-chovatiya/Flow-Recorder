# Changelog

Notable changes to FlowSnap. Format follows [Keep a Changelog][kac]; versions
follow [semantic versioning][semver].

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [2.6.0] — 2026-08-25

Two costs nobody was paying attention to: what a recorded flow weighs in the
context window of the assistant reading it, and what it weighs in the browser
while it is still being recorded.

### Changed

- **A flow sent to Claude is about a tenth of the size it was.** A 15-step
  recording with three API calls a step measured 90,220 tokens through
  `get_flow` and now measures 9,194. The compaction that has always run on the
  ZIP export — a large response body replaced by its inferred schema — never ran
  on the path the assistant actually reads, so the tool that exists to be read by
  a model was the one export that shipped four hundred rows of JSON verbatim.
  Past a client's MCP output cap that was not merely expensive: the document was
  cut mid-JSON with nothing to say so, and the assistant reasoned over half a
  recording believing it had all of it.
- **A failed call keeps its body.** Compaction everywhere else answers "what does
  this endpoint return"; on a 500 the question is "why did this one break", and a
  schema answers it with every word of the error replaced by the observation that
  it had words. Failed calls keep up to 4 KB verbatim — enough for a stack trace —
  and say so when they are cut. `get_flow_errors` was cutting at 2 KB and now
  matches.
- **Headers no longer travel with every call.** They are redacted at capture,
  they repeat per call, and no question worth asking of a successful request is
  answered by its `date` or `vary`. Five survive on a call that failed —
  `content-type`, `www-authenticate`, `access-control-allow-origin`, `retry-after`
  and `location` — because each of those is, in some flow, itself the bug. The
  viewer still shows every header.
- **`get_flow` returns a long recording one page at a time.** Every MCP client
  caps tool output and applies the cap by truncating the string, so a response
  that outgrew it arrived as a document cut mid-JSON with nothing anywhere saying
  so — and the model then answered questions about a recording it had half of.
  The server now does the cutting, on a step boundary, and states it: the page
  says which steps it holds, of how many, and names the `from` that continues it.
  `get_flow_errors` is bounded the same way. `FLOWSNAP_MAX_TOKENS` sets the
  budget, default 20,000.
- **A step that exceeds the budget on its own is shrunk rather than skipped or
  emitted whole.** Network calls are dropped from the end and the step carries a
  count of what went, so a recording of one page making six hundred requests
  still advances a page at a time instead of returning something no client will
  deliver intact.
- **The MCP server renders its walkthrough with the extension's own renderer.**
  It kept a second, smaller copy — 65 lines that had to agree with 375 and did
  not. The careful one rendered the Markdown a human downloads; the weak one
  rendered what the model read. The weak one printed the full URL and the
  absolute screenshot path on every step, printed brittle full-path CSS
  selectors, showed network calls as a status line with no body, and escaped
  nothing — so a response body containing `## Step 99 — Clicked "Delete"` forged
  a step nobody performed. `src/core/` is now bundled into the server package by
  `npm run build:mcp`, which is what `core/` being pure has always been for. The
  walkthrough gained request and response bodies and console errors it did not
  have, at roughly the same size, and `📍` marks a page change instead of every
  step repeating its URL.
- **A component's source is formatted one way rather than two.** The server had
  its own copy that printed a compiled position with the whole bundle URL where
  the extension printed just the path, so one flow could describe the same
  component two ways depending on which half of the response you read.
- **Steps no longer carry replay-only fields into a context window.** `xpath` and
  `boundingBox` exist so a future playback feature has something to drive from,
  and `dpr` and `highlightBox` are the annotator's coordinate bookkeeping; none
  of them answers a question about what went wrong, and all of them are on every
  step. They stay in `flow.json`. `get_flow_step` keeps the element ones, since
  someone looking that closely is often looking at the selector.
- **Timestamps are offsets rather than absolute epoch milliseconds.** "The 500
  came 4.2 seconds after the click" is the readable form and a fraction of the
  characters; the flow's own timestamp stays absolute so the offsets have
  something to be offsets from.
- **`get_flow_screenshots` returns three images per call, not eight.** A
  screenshot is on the order of 1,500 tokens of vision budget, so the old
  ceiling made one call worth more than the rest of the recording put together.
- **The server compacts bodies it was handed uncompacted.** The extension does
  it before sending, so this is a no-op for a current flow — but a recording made
  before that existed, or a POST from anything that is not the extension, was cut
  with a slice, and a 4 KB slice of a four-hundred-row JSON array ends mid-object
  and reads as a complete answer with nine rows in it. `get_flow_errors` was
  slicing too. Both now run the same schema inference the exports run.
- **`log`, `info` and `debug` are no longer in the step data.** The markdown has
  always filtered console output to errors and warnings; the JSON never did, so
  the two halves of one response disagreed about what was worth reading and a
  page that prints a render timing every frame filled the step data with it. The
  count of what was dropped is stated on the step. `get_flow_step` still returns
  everything — a debug line can be the thing that explains the step you are
  looking at.
- **A flow recorded by a newer build is refused on read, with the reason.** The
  receiver already refused a POST it was too old to understand, which covers the
  flow arriving and nothing about the flow already on disk — and `~/.flowsnap`
  outlives any one server, since `npx` resolves to whatever npm cached and a
  downgrade is one install away. An older server read a newer flow, found the
  fields it knew, and answered questions about it confidently. It is also no
  longer reported as "not found": it is sitting in `list_flows` in front of the
  reader, and sending them to look for it is the wrong instruction.
- **`get_flow` returns the walkthrough, and the step data only when asked.** The
  two blocks overlapped almost entirely — every step's url, action, selector,
  component and screenshot path appeared in both, and the reader paid twice. What
  the JSON had that the walkthrough did not is replay material: xpath, bounding
  boxes, full unstable selectors. `raw: true` returns it. The walkthrough is
  bounded per step by the renderer, so a 400-step recording now arrives in one
  response where the record of the same flow pages four times over.
- **`failureCount` beside `errorCount`.** `errorCount` counts *steps*, so one
  step with six 500s and one with a single warning both read as 1 — the
  difference between a page failing constantly and a page that hiccupped.
  Renaming it would break every `meta.json` on disk, so the honest count is added
  beside it.
- **The step JSON is no longer pretty-printed**, and `flow.md` is no longer read
  back off disk to answer a tool call — the walkthrough is rendered from the JSON
  at the moment it is asked for, because it may be a window onto the recording
  rather than all of it. The file is still written, for whoever opens the flow's
  directory.

### Added

- **Uncaught exceptions and unhandled promise rejections are recorded.** Chrome
  prints both itself rather than routing them through `console.error`, so the
  interception that is the whole of FlowSnap's console capture never saw either
  — and a recording made *because* the app threw came back with an empty console
  and a step that read as fine. They arrive as console errors marked
  `[uncaught]` or `[unhandled rejection]`, with up to twelve stack frames. A
  failed image or script does not count as a crash; it is already a failed
  network call.
- **The failure after the last click is kept.** Console and network activity is
  attached to the *next* step, so anything the page produced after the final
  interaction had nowhere to land and was dropped on Stop — which is exactly the
  wrong thing to drop, since the usual shape of a bug report is *click the
  thing, watch it break, stop recording*. Every recorded tab is now asked for
  what it is still holding, and it becomes a final `After the last step` note,
  in the order it happened rather than the order the tabs answered. That step
  carries no screenshot: nobody performed it.
- **`compare_flows(working, broken)`** — two recordings of the same journey
  lined up: where they stop doing the same thing, which endpoints answered
  differently, what only the broken run calls, which errors only it logs, and the
  component the first failure happened in. A working/broken pair is the strongest
  evidence a bug report can carry, and the only way to use one was to read both
  recordings in full. Measured at 98 tokens against several thousand.
- **What an interaction visibly did.** A step now records the text of the region
  around the element before it and shortly after — *the button said "Place order"
  and then "Something went wrong"* — which is the same fact the screenshot
  carries, in the form a reader can act on without opening a JPEG. About fifty
  tokens against roughly fifteen hundred, and it works for a reader that cannot
  see images at all. Only when the text actually changed, which is not most
  steps.
- **`get_flow_step`** — one step in detail, with bodies kept four times longer
  than any other tool keeps them. The choice used to be an error summary or the
  entire recording, so seeing one step in full meant paying for all of them.
- **A one-line summary of what broke**, on `list_flows`, at the top of
  `get_flow_errors` and in the flow header: *"3 of 30 steps failed, all POST
  /v1/orders → 500, first at step 10, in BuyButton (src/components/Buy.tsx:34)."*
  `errorCount` says three steps broke; it does not say they all broke the same
  way, which is the difference between three bugs and one.

### Fixed

- **Long recordings no longer slow down as they get longer.** Every capture
  rewrote the whole `recordedSteps` key, and the screenshots were inside it, so
  the cost of recording step N was the cost of rewriting steps 1…N: 136 ms per
  capture at step 200, with 128 MB live in the service worker — and a 500-step
  recording that could not be measured at all, against a `MAX_STEPS` of 500. The
  images now live in a storage key each, so the array stays proportional to the
  number of steps rather than their weight. The same capture is 0.4 ms against
  60 KB, and step 500 is 0.8 ms. Deleting a step, discarding a recording or
  starting a new one takes the images with it.

## [2.5.0] — 2026-08-24

An audit of the recorder, the MCP server, the exporter, the viewer, flow storage
and React attribution. Almost everything here is one recurring shape: data that
was silently wrong, missing, duplicated, or attributed to the wrong thing. A step
is evidence, and presenting the wrong evidence confidently is worse than
presenting none, because somebody acts on it.

### Added

- **Route changes in single-page apps are recorded as navigation steps.** A
  `pushState` loads no document, starts no content script and fires no
  `popstate`, so a React flow — which is most of what FlowSnap records — came out
  as a run of clicks with nothing to say the page had changed underneath them.
- **Credentials in URLs are masked at capture.** An OAuth callback kept its
  `?code=`, and an implicit-flow app its `#access_token=`, all the way into the
  export and the MCP server. Only the value is replaced, never the parameter or
  the path, so a step still reads as a record of where the user was. `state` and
  `nonce` are left alone — CSRF machinery, and usually the thing being debugged.
- **The MCP server keeps the newest 200 flows, up to 2 GB**, oldest evicted
  first and each one named rather than dropped quietly. Nothing had ever deleted
  anything. `FLOWSNAP_MAX_FLOWS` and `FLOWSNAP_MAX_BYTES` override both.
- **Deleting a flow in the extension deletes it on the server too.** It used to
  clear `chrome.storage` and stop there, so a recording deleted *because* it had
  captured a session token was still handed to Claude by the next `list_flows`.

### Fixed

- **Pressing Start wrote one "Navigated to …" step per open tab**, in the same
  millisecond, each carrying a screenshot of whichever tab was on screen. Every
  tab runs the content script and extension storage is shared by all of them, so
  the listener that starts a recording fired in every one at once. Tabs now log
  themselves when the user actually arrives, which is what the feature meant.
- **The last step before Stop was discarded.** A step is written a few hundred
  milliseconds after the click, and stopping flipped the flag out from under the
  queue — losing exactly the thing a bug report is made of, and shipping the flow
  to MCP without it.
- **A step from a background tab carried a picture of a different page.**
  `captureVisibleTab` photographs the window's visible tab, whichever tab asked.
- **A recorded page could read any file the MCP server could.** A step's
  `screenshotFile` is the server's own field, but a POSTed one survived into
  `flow.json`, and `path.join` resolves `..` — so a page the user visited could
  name a file for `get_flow` to hand over. The receiver also had no origin check,
  no body cap and no overwrite guard.
- **`get_flow_errors` reported "no step failed" for flows sent with the default
  options**, which leave out network and console — the worst possible answer to
  the question that tool exists to answer.
- **Form values became element names**, defeating the masking applied everywhere
  else: `Typed "•••••••" into S3cret!`, and an autofilled card number as
  `Clicked "4111 1111 1111 1111"`. An `Authorization` header given as an array of
  pairs never matched the redaction regex either.
- **Re-annotating a step undid its redaction.** The editor reopened the pristine
  capture, so saving an arrow discarded what was drawn before it and shipped the
  readable image.
- **The patched `fetch` never resolved for a streaming response.** It awaited the
  whole body before returning, so SSE, token streams and long polls hung — on
  every page, whether or not a recording was running. Reused `XMLHttpRequest`
  objects reported duplicates, and `responseType = 'json'` dropped the entry.
- **A response body containing its own code fence swallowed the rest of the
  export** — every later step and the components table. Console output and
  page-derived labels could forge step headings the same way.
- **Escape on a confirmation dialog read as "yes"** and deleted the flow: the
  dialogs are shared elements and `returnValue` is only written by a button.
- **Undo could destroy an unrelated step**, Delete under a filter removed one
  that was not on screen, and an edit returning a field to its previous value was
  silently dropped.
- A React chain could be attributed to the wrong source file, from a shared
  `Anonymous` id minted for every host DOM node and from a bundle search that
  walked back into the previous module; an exhausted time budget was reported as
  a confident "not found" and never retried.
- Flows saved by both auto-send and Send appeared twice with contradictory error
  counts; `flow.json` could be left truncated where a complete one had been.

### Developer

- 561 → 695 tests.

## [2.4.0] — 2026-08-23

React attribution becomes recording data you can decline, like console logs and
network calls — and gets more accurate about which component it names.

### Added

- **React components & source is now a checkbox in the export and send
  dialogs**, beside Screenshots, Network calls and Console logs. On by default;
  switching it off drops the component ids from the steps and the source table
  with them, priced in the same size estimate as every other part. The switches
  in Settings still decide whether the data is *captured* at all — this decides
  whether what was captured leaves the machine, which is the split screenshots
  have always had.
- **A step whose component is a shared UI primitive now names the feature
  component that rendered it.** Clicking Continue lands in
  `src/components/ui/Button.tsx`, correctly and uselessly; the step reads
  `⚛ Button · in CheckoutButton` and both files are in the table. Only when the
  owner is a primitive: `· in App` on every step of every flow would be true and
  worth reading none of the time.
- `get_flow_errors` now carries each failing step's component **source file and
  line**, not just its name. It is the call an assistant makes first when
  something broke, and sending it to `get_flow` to find out *where* undid the
  point of it being the cheap one.

### Fixed

- **Interactions inside a shadow root are attributed.** A document listener only
  ever sees `event.target` retargeted to the shadow host, so React mounted inside
  a web component was invisible; and the upward walk stopped at the boundary
  rather than crossing to the component that rendered the host. Both directions
  now work.
- **Switching React capture off discards what the recording already collected.**
  It stopped new attribution and left the component ids, the pending needles and
  the resolved table from the first ten steps in place — a half-attributed flow,
  which is the one outcome nobody asked for. Archived flows are untouched;
  deleting from those is what Settings → Delete all is for.

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
- `npm run core:drift` for the six files shared by copy with that extension. Extracting them into a package was designed and dropped —
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
