# FlowSnap

A Chrome extension (MV3) that records what you do in a browser and exports it as
context an AI coding assistant can actually use: annotated screenshots, the
selectors for every element touched, and the network and console activity each
step produced.

Recording starts from the toolbar, on the tab being recorded. Steps are reviewed
in a full tab and exported as a ZIP, Markdown or JSON — or sent straight to
Claude Code, which is the point of the whole thing.

## Using it with Claude Code

```sh
claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp
```

One command, no clone, no build. `--scope user` registers it for every project
you open, in both the CLI and the VS Code extension. Record a flow, press
**Send**, and Claude can read the steps, the console errors, the failed requests
and their bodies, and a screenshot of each step — from inside the project you're
trying to fix.

The server is published from this repo as
[`flowsnap-mcp`](https://www.npmjs.com/package/flowsnap-mcp); its own
[README](mcp-server/README.md) covers the tools, where flows are stored, and what
happens with several Claude sessions open at once.

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
mcp-server/     published to npm as flowsnap-mcp; not part of the extension build
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
and pushing the tag builds the extension, attaches a loadable zip to a GitHub
release, and publishes `flowsnap-mcp` to npm at the same version.

```sh
npm version patch          # bumps package.json, manifest.json and mcp-server/
git push origin main --follow-tags
```

The tag must match all three version files or the workflow refuses to build — a
server that disagrees with the extension it shipped beside makes "which one do I
have" unanswerable. `npm version` keeps them in step; editing by hand does not.

### Publishing rights

The release workflow authenticates to npm either way, so switching between them
is a change on npmjs.com rather than a change to the workflow:

- **`NPM_TOKEN` repository secret.** Required for the first publish — trusted
  publishing is configured *on* a package, so it cannot create one. A classic
  Automation token, or a granular token with all-packages write; afterwards,
  narrow it to `flowsnap-mcp` alone.
- **Trusted publishing.** Register this repo and `release.yml` as a trusted
  publisher on the package, then delete the secret. The workflow authenticates
  with the `id-token` permission it already has, and no long-lived credential
  exists to leak or rotate.

Either way the tarball carries provenance, which needs the repo and the package
to both stay public.

## Licence

[MIT](LICENSE). IBM Plex is vendored under the SIL Open Font Licence — see
`public/fonts/OFL.txt`.
