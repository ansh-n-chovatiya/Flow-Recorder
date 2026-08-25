# Making FlowSnap configurable

A plan, not an implementation. Nothing here is built yet.

The goal: every decision FlowSnap currently makes on the user's behalf becomes a
decision the user can make, without turning Settings into a wall of numbers
nobody understands and without letting someone quietly break their own
recordings.

Today there are eight settings and sixty-one hardcoded constants. Some of those
constants are genuine preferences that were never asked about. Some are load
bearing and must never move. Most of the work in this document is telling those
two groups apart, and building one mechanism that carries the first group from a
form field to a service worker, a content script, a page-world agent and a
separate Node process — none of which can read the others' storage.

---

## 1. Where the state is now

**Already user-controlled** (`SyncStorageShape`, eight fields): `theme`,
`mcpServerUrl`, `mcpAutoSend`, `reactCapture`, `reactResolve`, `projectRoot`,
`editor`, `customEditorTemplate`.

**Half-controlled**: `exportOptions` and `sendOptions` in local storage —
images / network / logs / react. The user picks these per export in a dialog;
they are remembered but never editable as defaults.

**Not controlled at all**: everything in `src/shared/constants.ts` (45 values),
the module-local constants in `core/export/markdown.ts`, `core/schema/index.ts`,
`core/describe/index.ts`, `injected/agent.ts`, `features/flows/thumbnail.ts`,
and 16 more in `mcp-server/server.js` — of which only five are reachable, and
only through environment variables a user of a Chrome extension will never set.

---

## 2. The three tiers

The interesting question is not "what could be a setting" but "what *should*
be". Three tiers, and the boundary between them is the substance of this plan.

### Tier 1 — Preferences (ship in Settings, plainly)

Each of these is a judgement call that FlowSnap currently makes for the user, and
that a reasonable person could want made differently. Every one gets a labelled
control, its default shown inline, and a sentence saying what changing it costs.

| Setting | Now | Why someone would change it |
| --- | --- | --- |
| Stop recording after N steps | `MAX_STEPS` 500 | A long QA pass legitimately exceeds it; someone else wants a hard 50 |
| Warn at N steps | `WARN_STEPS` 150 | Follows the above |
| Capture screenshots | always on | A page with sensitive content on every screen; a much lighter flow |
| Screenshot quality | `SCREENSHOT_QUALITY` 60 | Text-heavy UIs need 80; storage-constrained users want 35 |
| Wait before screenshotting | `SETTLE_DELAY_MS` 150 | A slow app paints its response after 400ms and every screenshot is early |
| Typing debounce | `INPUT_DEBOUNCE_MS` 800 | Fast typists lose steps; slow forms want longer |
| Capture request/response bodies | always | The single biggest privacy and size lever, and it has no switch |
| Body capture limit | `BODY_CAP` 51,200 | Enough for most; far too much for an app that streams |
| Summarise bodies larger than | `SCHEMA_THRESHOLD` 1,024 | The schema/verbatim tradeoff is genuinely per-app |
| Summarise bodies at all | always on | Someone debugging a serialisation bug needs the bytes |
| Console levels captured | all five | Most users want error+warn only, at capture rather than at export |
| Capture uncaught errors | always on | No good reason to turn off, but it is new behaviour and should be visible |
| Record what changed on screen | `DOM_DELTA_MS` 700, on | The delay is app-specific; the feature is worth a switch |
| Region text kept | `CONTAINER_TEXT_CAP` 240 | Dense UIs want more |
| Collect the trailing step on Stop | on | New behaviour; should be visible and refusable |
| Annotation colour | `ANNOTATION_STROKE` | Red is invisible on a red error banner |
| Export defaults | per-dialog only | Should have a default the dialog starts from |
| Send defaults | per-dialog only | Same |
| MCP response budget | `MAX_TOKENS` 20,000 | Depends entirely on the client's own cap |
| Include step data by default | `raw` false | A user who always wants the record should not pass a flag every time |
| Screenshots per MCP call | `MAX_IMAGES` 3 | Vision-heavy workflows want more |
| Body length in tool output | `BODY_LIMIT` 4,096 | Follows the budget |
| Walkthrough body/console caps | `MAX_RESPONSE_BODY` 800, `MAX_CONSOLE_ENTRIES` 5 | The narrative's density is a real preference |
| Keep at most N flows / N GB | `MAX_FLOWS` 200, `MAX_FLOW_BYTES` 2GB | Currently env-only, so effectively unreachable |
| Component budget per flow | `MAX_COMPONENTS_PER_FLOW` 128 | Large apps exceed it |
| Source-resolution time budget | `MAX_RESOLVE_MS_PER_FLOW` 30,000 | Big bundles need longer; impatient users want less |
| MCP server port | `FLOWSNAP_PORT` 7734 | Already contested on some machines, and must match on both sides |

### Tier 2 — Advanced (behind a disclosure, with a warning)

Real settings, but changing them degrades recordings in ways that look like bugs.
They belong behind an **Advanced** disclosure that is collapsed by default and
carries one sentence at the top: *these change how recording behaves, and a bad
value looks like FlowSnap being broken.*

`CAPTURE_MIN_INTERVAL_MS` (below Chrome's ~2/sec limit, screenshots are silently
rejected), `PRECAPTURE_TTL_MS`, `PAINT_TIMEOUT_MS`, `SPA_SETTLE_MS`,
`RELOAD_TIMEOUT_MS`, `RESOLVE_CONCURRENCY`, `RESOLVE_DEBOUNCE_MS`,
`BUNDLE_CACHE_ENTRIES` / `BUNDLE_CACHE_BYTES`, `MAX_RESOURCE_BYTES`,
`MAX_MAP_BYTES`, `MAX_SCRIPTS_PER_ORIGIN`, `MAX_COMPONENT_CHAIN`,
`MAX_FIBER_WALK`, `REACT_CHAIN_TIMEOUT_MS`, `REACT_BUFFER_SIZE` / `_TTL_MS`,
`LOG_ARG_CAP`, `STACK_FRAMES`, the three send/health/remote `TIMEOUT_MS`,
thumbnail `WIDTH`/`HEIGHT`/`QUALITY`, `ERROR_TTL_MS`.

### Tier 3 — Never (and the reason has to be written down)

Making these configurable would not give the user control, it would give them a
way to corrupt data that still looks fine.

| Constant | Why not |
| --- | --- |
| `FLOW_SCHEMA_VERSION`, `SUPPORTED_SCHEMA` | A wire contract between two things that ship separately. A user-set version is a user-set lie. |
| `SCREENSHOT_FILE` regex | The path-traversal guard on a loopback port any visited page can reach. |
| `MAX_BODY_BYTES` (receiver) | The only thing bounding an unauthenticated POST. |
| `AGENT_MESSAGE_SOURCE`, `CONTROL_MESSAGE_SOURCE`, `INDICATOR_ID` | Protocol and DOM identifiers, not preferences. |
| VLQ masks, `FNV_PRIME`, `SEED_A/B`, `HASH_SOURCE_LEN` | Component identity. Change them and every stored id stops matching — silently. |
| The source-map line base | `docs/SHARED-CORE.md` already says it: get it wrong and every file opens one line off and nothing fails. |
| `ORPHAN_GRACE_MS` | Deletion safety. |
| `MAX_MATCHES_TRACKED`, `MIN_NEEDLE_LEN`, `NEEDLE_*_LEN` | Resolution correctness; the failure mode is a confident wrong file path. |

Tier 3 stays in `constants.ts` and gets a comment saying it is deliberately not
configurable. That comment is the deliverable — the next person to be asked
"why can't I change this" should find the answer in the file.

---

## 3. The hard part: one value, four processes

A setting is easy to store and hard to deliver. FlowSnap has four consumers and
no two of them can read the same thing.

| Consumer | Can read `chrome.storage`? | How it gets constants today |
| --- | --- | --- |
| Service worker | yes, async | module import |
| Content script (isolated world) | yes, async | module import |
| Injected agent (MAIN world) | **no** — no `chrome.*` at all | module import, bundled separately |
| MCP server (separate Node process) | **no** — different machine boundary | env vars |

Module imports are baked at build time, so today "configurable" would mean
"rebuild the extension".

### The proposed mechanism

**Defaults stay where they are.** `constants.ts` keeps every current value and
becomes the source of the `DEFAULTS` object. Nothing is duplicated, and the
existing rationale comments — which are the best documentation in the repo —
stay attached to the numbers they explain.

**Storage holds overrides only, never the resolved object.** Sparse. If a future
version improves a default, users who never touched that setting get the
improvement. Storing the full resolved settings freezes today's defaults into
every installation forever, and that mistake is invisible until the day you try
to change one.

```ts
// src/features/settings/index.ts
export const DEFAULTS: Settings = { maxSteps: MAX_STEPS, screenshotQuality: SCREENSHOT_QUALITY, … };
export function resolve(overrides: Partial<Settings>): Settings   // pure, clamped, testable
export async function load(): Promise<Settings>                    // storage + resolve
export function subscribe(fn: (s: Settings) => void): () => void   // storage.onChanged
```

**Clamping lives in `resolve`, not in the UI.** The form validates for a good
message; `resolve` validates because storage can hold anything — a synced value
from a newer version, a hand-edited profile, a corrupted write. Every field
declares `{ min, max, default }` in one table, which drives the clamp, the input
attributes and the "reset" affordance from the same place.

**Delivery, per consumer:**

- *Worker*: `load()` at startup, `subscribe()` for changes. It already owns the
  capture path, so most Tier 1/2 values are read here.
- *Content script*: `load()` on `START_RECORDING`. Settings are frozen for the
  duration of a recording — see §5.
- *Injected agent*: cannot read storage, so the content script **pushes** the
  agent-relevant subset down the existing `CONTROL_MESSAGE_SOURCE` channel at
  start. The agent keeps a mutable config object with the compiled-in defaults as
  its initial value, so it behaves correctly for the window between injection and
  the first message. Everything the agent reads per-call (`BODY_CAP`,
  `LOG_ARG_CAP`, `STACK_FRAMES`, console levels) works with this; anything read
  at import time would not, and there is currently nothing in that category —
  a rule worth keeping and worth a test.
- *MCP server*: two channels, because two kinds of setting.
  - **Per-flow rendering** (token budget, body limits, `raw` default, images per
    call, walkthrough caps) travels **inside the flow**, added to `FlowPayload`
    and persisted in `flow.json`. A recording then carries the preferences it was
    made under, which is the same reasoning that put `omitted` there.
  - **Machine-wide** (retention, port) goes to a new `POST /config` that the
    server persists to `~/.flowsnap/config.json`.
  - Precedence: **environment variable > `config.json` > per-flow > default.**
    Env stays the last word so CI and headless runs are not steered by whatever a
    browser once synced.

---

## 4. What Settings looks like

Seven groups. The current page is one flat column and will not hold sixty
controls.

1. **Recording** — step limit, warning threshold, screenshots on/off, quality,
   settle delay, typing debounce
2. **What gets captured** — network bodies on/off, body cap, summarisation and
   its threshold, console levels, uncaught errors, on-screen changes, React
   (the two existing switches live here)
3. **Privacy** — redaction rules, whether bodies are stored at all, auto-send
   (existing, with its existing warning), and a plain statement of what leaves
   the machine
4. **Handing over** — export defaults, send defaults, MCP URL and port, response
   budget, `raw` by default, screenshots per call
5. **Storage** — usage (existing), retention limits, delete-all (existing)
6. **Appearance** — theme (existing), annotation colour, project root and editor
   (existing)
7. **Advanced** — collapsed, warned, Tier 2

Every control shows its default and offers a one-click reset. A group with any
non-default value shows a marker, so "what have I changed" is answerable without
reading every field. One global **Reset all to defaults**.

**Import/export settings as JSON.** A team debugging the same app wants the same
capture configuration, and "send me your settings file" is how that happens.

---

## 5. Decisions worth making now

**Settings are frozen for the duration of a recording.** Changing the body cap
halfway through would produce a flow whose first ten steps followed one rule and
whose last ten followed another, with nothing recording that. `START_RECORDING`
snapshots; changes apply to the next recording. The Settings page says so when a
recording is active. This is the same reasoning that already makes switching
React capture off mid-recording purge what it had collected, rather than leave a
flow attributed for half its length.

**A flow records the settings it was made under.** Add `settings` to
`FlowPayload` and show the non-default ones in the walkthrough header. Without
it, a flow recorded at quality 20 with bodies off is indistinguishable from a
flow where capture failed — and the reader will conclude the latter. This is the
single most important item in this plan: it is what keeps configurability from
turning every recording into an unanswerable question about how it was made.

**Dangerous settings state their consequence inline**, in the pattern auto-send
already uses. "Below ~550ms Chrome rejects screenshots and steps will silently
have no image" belongs next to the input, not in a tooltip and not in this file.

**Nothing in Tier 1 may make a recording silently worse.** Where a setting can
degrade a flow, the flow says so — a step with no image because quality was set
to zero should carry the same kind of note a failed capture does.

---

## 6. Phasing

Ordered so each phase is shippable and the risky part comes first, while it is
cheap to change.

- **Phase 0 — the mechanism, no new UI.** `Settings` type, `DEFAULTS`, `resolve`
  with clamps, `load`, `subscribe`, and the agent push channel. Migrate the eight
  existing settings onto it. Nothing changes for the user; everything after this
  is a table entry and a form control.
- **Phase 1 — Recording and Capture.** The highest-value Tier 1 settings, the
  ones that are really about privacy and flow size. Plus the per-flow `settings`
  stamp from §5, which must land with the first setting that can change what a
  recording contains.
- **Phase 2 — Handing over.** Export/send defaults, MCP budget, `raw` default,
  images per call, walkthrough caps. Per-flow delivery to the server.
- **Phase 3 — Storage and the server config channel.** Retention, port,
  `POST /config`, `~/.flowsnap/config.json`, precedence.
- **Phase 4 — Advanced, import/export, reset.** Tier 2 behind its disclosure.

---

## 7. How this gets tested

- **Every default equals today's constant.** One table-driven test. It is what
  makes this refactor safe, and it fails loudly if a default drifts by accident.
- **Every setting clamps.** Out-of-range, wrong type, `null`, and a value from a
  hypothetical newer version all resolve to something usable.
- **Sparse storage stays sparse.** A saved override of one field must not
  materialise the other sixty, or the freeze-the-defaults bug ships silently.
- **The agent receives what it is sent.** The push channel is the only path to
  the MAIN world and the one most likely to rot.
- **Nothing reads a setting at module scope.** A lint rule or a structural test,
  in the spirit of `react-server-guard.test.ts` — the failure it prevents is a
  setting that appears to work and silently uses the compiled-in default.
- **A recording is frozen.** Change a setting mid-recording; the flow is
  internally consistent and the stamp reflects what was actually used.

---

## 8. State of the review items at the time of writing

The AI-facing review that preceded this is fully implemented — payload
compaction, header stripping, response budgeting and pagination, the single
shared markdown renderer, `get_flow_step`, `compare_flows`, uncaught-error
capture, the trailing step, on-screen change deltas, the failure summary,
`failureCount`, and the storage rewrite that made long recordings possible.
Nothing from it is outstanding.

Two things that plan deliberately left alone, and that this one should pick up:

- **`errorCount` still counts steps rather than failures.** `failureCount` was
  added beside it because renaming would break every `meta.json` on disk. If a
  schema version bump happens for another reason, fold it in then.
- **`BODY_CAP` bounds each body but not their number.** A step making six hundred
  requests is bounded only by the response budget, which shrinks it after the
  fact rather than capturing less. A per-step network cap belongs in Tier 1 and
  does not exist yet as a constant.
