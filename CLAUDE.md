# FlowSnap

A Chrome MV3 extension that records browser flows — clicks, inputs, network,
console, screenshots — and hands them to an AI coding assistant as usable
context. Shipped alongside it is `mcp-server/`, a separate npm package
(`flowsnap-mcp`) that serves those recordings to Claude Code over MCP.

## Start with the knowledge graph

This repo carries a graphify knowledge graph: every symbol, file and
cross-module relationship, extracted from the AST rather than guessed.

**Before grepping or opening source files, read `graphify-out/GRAPH_REPORT.md`.**
It is the map — god nodes, communities, and the concepts worth knowing about.

`graphify-out/` is generated and git-ignored, so a fresh clone has no graph
until it is built — about a second, no API key, offline:

```sh
npm run graphify:setup     # first time: also installs git hooks + agent config
npm run graphify:update    # afterwards: refresh the graph
```

The PreToolUse hook says which of three states this checkout is in before any
search: graph current, graph **stale**, or no graph at all. Take a stale graph
at face value at your peril — it names symbols by the location they had at the
commit it was built from. `graphify update .` costs a second and fixes it.

For questions that cross module boundaries, ask the graph instead of scanning
files — it traverses real edges, and costs a fraction of the tokens:

```sh
graphify query "how does a recorded step reach the MCP server?"
graphify path "recordStep()" "get_flow_errors"
graphify explain "FlowStep"
```

Grep is still the right tool for a literal string, a TODO, or a specific
identifier you already know the name of. The graph is for *structure*.

The graph rebuilds automatically after every commit and on branch switch, via
the git hooks `npm run graphify:setup` installs. After a large refactor that
deletes code, `graphify update . --force` overrides the shrink guard.

`npm run lint:graphify` checks that this wiring is committed rather than merely
present — it is part of `npm run verify`, and it exists because the config once
ran untracked for weeks while working perfectly on the machine that wrote it.

## Commands

```sh
npm install        # both packages — root postinstall installs mcp-server/ too
npm run build      # writes dist/ (load unpacked in chrome://extensions)
npm run dev        # rebuild on change
npm test           # vitest; pretest builds mcp-server/core.js first
npm run typecheck
npm run lint
npm run verify     # typecheck + lint + token guard + settings-ui guard + tests + builds
npm run package    # release ZIP in releases/
npm run core:drift # drift in files shared with react-source-locator
```

`npm run verify` is exactly what CI runs. Run it before pushing.

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Pure logic: flow model, schema, export, redaction, selectors, React attribution. |
| `src/features/` | Extension features composed from `core/` — recording, flows, export, screenshots, settings, MCP transport. |
| `src/background/` | MV3 service worker: the recorder's control plane. |
| `src/content/`, `src/injected/` | Page-side capture. `injected/agent.ts` runs in the page's own world. |
| `src/chrome/` | Thin wrappers over `chrome.*` APIs. |
| `src/ui/` | Popup, viewer, settings pages, and `styles/tokens.css`. |
| `src/shared/` | Types, messages, constants, `Result`. |
| `mcp-server/` | The published MCP server — own `package.json`, own lockfile. |
| `scripts/` | Build and guard scripts run from npm scripts. |
| `tests/` | Vitest suites; some spawn the real MCP server. |

## Rules this codebase enforces

These are checked by CI, so breaking one fails the build rather than review.

- **`src/core/` is pure.** No `chrome.*`, no module-level state, no DOM
  assumptions beyond what is passed in. `npm run build:mcp` bundles it into
  `mcp-server/core.js` for a Node process that has no `chrome` object at all.
  Anything touching extension APIs belongs in `src/features/` or `src/chrome/`.
- **`src/ui/styles/tokens.css` is the only file allowed to name a colour.**
  Enforced by `npm run lint:tokens`. The palette's reasoning is in
  `docs/design/README.md`.
- **The version lives in two files.** `package.json` and
  `public/manifest.json` must agree — `npm run sync-version` fixes drift, and
  CI fails on it.
- **`mcp-server/` is not a workspace, deliberately.** It publishes to npm on
  its own. `mcp-server/core.js` is generated, git-ignored, and required on disk
  before tests run.
- **No committed `.mcp.json`.** A previous one applied to everyone who cloned
  the repo and silently shadowed their real FlowSnap installation. To point
  Claude at your clone's server, register it for that directory only:
  `claude mcp add flowsnap -s local -- node ./mcp-server/server.js`.

## Working here

- Recorded flows land in `~/.flowsnap/flows` (`FLOWSNAP_DIR` moves them) and may
  contain real page data — treat exports as potentially sensitive.
- `dist/`, `releases/`, `.render/`, `graphify-out/` and `mcp-server/core.js` are
  all generated. Don't commit them, and don't hand-edit them.
- The comments in this repo explain *why*, not what. Match that when adding
  code: a comment that restates the line above it is noise here.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
