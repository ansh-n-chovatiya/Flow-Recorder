# Changelog

Notable changes to FlowSnap. Format follows [Keep a Changelog][kac]; versions
follow [semantic versioning][semver].

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

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
