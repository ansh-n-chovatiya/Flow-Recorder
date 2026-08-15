# FlowSnap

A Chrome extension (MV3) that records what you do in a browser and exports it as
context an AI coding assistant can actually use: annotated screenshots, the
selectors for every element touched, and the network and console activity each
step produced.

Recording starts from the toolbar, on the tab being recorded. Steps are reviewed
in a full tab and exported as a ZIP, Markdown or JSON — or posted straight to a
local MCP server for Claude to read.

## Getting started

```sh
npm install
npm run build      # writes dist/
```

Then load `dist/` at `chrome://extensions` with Developer mode on. Chrome 116 or
newer.

```sh
npm run dev        # rebuild on change
npm run verify     # typecheck + lint + token guard + tests + all three builds
npm run package    # a release ZIP in releases/, version-synced from package.json
```

`npm run verify` is what CI runs. Run it before pushing.

## Layout

```
src/
  background/   MV3 service worker: capture queue, step persistence, badge
  content/      injected into the page: interaction listeners
  injected/     MAIN-world agent: network and console interception
  chrome/       the only place chrome.* is called; every call returns a Result
  core/         pure logic — selectors, describe, schema, export formats
  features/     recording preflight, flow store, export, MCP
  ui/           popup, settings, viewer, and the shared design system
  shared/       types, errors, constants, messages
public/         manifest, icons, fonts, content.css — copied verbatim
scripts/        icon and mark generation, token guard, version sync, packaging
mcp-server/     the local server flows are posted to
```

Three rules hold the structure together:

- **`chrome.*` is called only from `src/chrome/`.** Everything else receives a
  `Result<T>`, so a failed storage write or a blocked tab is a value to handle
  rather than an exception to miss.
- **`core/` is pure** — no Chrome, no DOM, no clock. That is why most of it is
  testable in Node.
- **Views are derived, then rendered.** `derivePopupView`, `deriveLibraryView`,
  `deriveReviewView` and `deriveExportView` decide what a screen shows; the
  controllers only bind the result to markup. Every state a screen can be in is
  a case in one of those functions, and is covered by a test.

## Storage

Flows live in `chrome.storage.local` on the machine that recorded them. The
manifest asks for `unlimitedStorage`, so the only ceiling is the disk — see
[`docs/design/README.md`](docs/design/README.md) for what that changed and why.

Nothing leaves the machine unless you export it or send it. Auto-send to the MCP
server is off by default and warns before you turn it on, because captured
request and response **bodies are not redacted** (headers are).

## Design

`src/ui/styles/tokens.css` is the only file allowed to name a colour, enforced by
`npm run lint:tokens`. The rationale, the deliberate departures from the original
frames, and the design decisions worth knowing before changing a screen are in
[`docs/design/README.md`](docs/design/README.md); the brief they came from is
[`docs/DESIGN-BRIEF.md`](docs/DESIGN-BRIEF.md).

## Architecture notes

[`AUDIT.md`](AUDIT.md) is the audit of the pre-TypeScript build and the migration
plan it produced. It is the reference for what each finding was and where it was
addressed.

## Releases

[`CHANGELOG.md`](CHANGELOG.md) records what changed. Tagging a commit `v2.0.1`
and pushing the tag builds the extension and attaches a loadable zip to a GitHub
release — the tag must match `package.json` and `public/manifest.json`, so bump
with `npm version` rather than by hand.

## Licence

[MIT](LICENSE). IBM Plex is vendored under the SIL Open Font Licence — see
`public/fonts/OFL.txt`.
