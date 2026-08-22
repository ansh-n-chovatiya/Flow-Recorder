# FlowSnap — UI/UX Redesign Brief & Stitch Prompts

**Phase 4. Design only — nothing here is implemented yet.**

Read order: the screenshot audit tells you *why* the design changes; the design
system is the single source of truth every screen obeys; the prompts are what
you paste into Stitch, one screen at a time.

| | |
|---|---|
| Input | 4 screenshots of the shipped UI, 15 Aug 2026 |
| Screens to design | 11 |
| Status | Awaiting Stitch output + your review |

---

## Contents

1. [What each screenshot shows, and what is wrong with it](#1--screenshot-audit)
2. [Structural decisions](#2--structural-decisions)
3. [The design system](#3--the-design-system)
4. [Stitch prompts](#4--stitch-prompts)
5. [How to run and review this](#5--how-to-run-and-review-this)

---

## 1 — Screenshot audit

### Screenshot 1 — Popup, idle with steps captured

**State:** `idle`, three steps already recorded. The one surface every session
starts from.

| # | Problem | Why it matters |
|---|---|---|
| 1 | Three full-width buttons of identical weight | Nothing is the primary action. The eye has to read all three every time. |
| 2 | **Colour semantics are inverted.** Start Recording is red (reads "danger"); Clear Steps — the only destructive action — is the quietest grey | The most dangerous control looks the safest. |
| 3 | Red means both "record" and "danger" | The one colour a recorder must own unambiguously is doing two jobs. |
| 4 | "3 steps captured" is dead text | You cannot tell what those steps are, when they were taken, or from which site. You must open the viewer to find out. |
| 5 | **MCP Server URL sits in the primary surface**, in a `<details>` | Developer configuration set once, occupying the surface used many times a day. |
| 6 | No indication of which tab will be recorded | And no warning when the tab *cannot* be recorded — the C5 defect is invisible here. |
| 7 | Stark white popup against a dark Chrome | No dark theme at all. |
| 8 | `⚡` emoji as the product mark | Renders as a different glyph per platform; not a brand. |
| 9 | Clear Steps deletes without confirmation | Irreversible, one click, no undo. |

### Screenshot 2 — Viewer, flow review (live recording)

**State:** step list with one navigate step visible.

| # | Problem | Why it matters |
|---|---|---|
| 1 | **Seven top-level actions**, six in a row plus an orphaned red *Clear All* | Three of them (ZIP / Markdown / JSON) are the same action with different formats. |
| 2 | *Clear All* floats alone, right-aligned, red, no confirmation | Destructive action given its own prominent row. |
| 3 | Export option checkboxes are permanently on screen | They only matter at export time; they belong in the export dialog. |
| 4 | Keyboard hints take a permanent row | Reference material occupying primary layout. |
| 5 | **"Saved Flows 0" is a counter that toggles an inline panel** | The flow library is hidden inside the flow reviewer. Two different jobs, one scroll. |
| 6 | Screenshots render full-width | A 30-step flow is several screens of scrolling with no overview, no jump-to-step, no sense of position. |
| 7 | Two stacked headers before any content | Title + subtitle re-read on every visit. |
| 8 | No search, filter, or step-type view | You cannot answer "where did the 500 happen" without scrolling. |
| 9 | Delete `×` in the card corner, undo only via a keyboard hint | No visible undo after a destructive click. |

### Screenshot 3 — Image editor open

**State:** annotation editor on a step's screenshot.

| # | Problem | Why it matters |
|---|---|---|
| 1 | **The captured screenshot contains FlowSnap's own "● Recording" pill** (bottom right) | See the bug note below. This is in every screenshot the tool has ever taken. |
| 2 | Seven text-label tool buttons in a row | Wide, noisy; "Hi-lite" is an invented abbreviation. Icons with tooltips do this in a third of the width. |
| 3 | Toolbar wraps, putting Undo/Save/Cancel on a detached second row | The commit action is separated from the work. |
| 4 | **Blur is the 6th text button** | It is the PII-redaction tool — the highest-stakes control in the product — and it is the least prominent. |
| 5 | Raw iOS system colours, unrelated to any theme; white swatch invisible on white | Not a palette, a default. |
| 6 | No zoom, no fit-to-width | You annotate at whatever scale the layout happens to give you. |
| 7 | Undo exists, redo does not; `Ctrl+Z` is globally bound to *step deletion* | Pressing undo-by-keyboard while drawing deletes a step instead. |
| 8 | Editor is inline, pushing the page around | A modal canvas is the right shape for focused work. |

> ### Bug C8 — the recording indicator is baked into every screenshot
>
> `showRecordingIndicator()` adds a fixed-position pill to the page and nothing
> removes it before `captureVisibleTab`. Every screenshot therefore contains
> FlowSnap's own UI, which then ships to Claude as if it were part of the
> recorded application.
>
> Fix (migration step 5): hide the indicator for the duration of the capture, or
> render it in a way `captureVisibleTab` does not see. This is a functional bug,
> not a design one, but it changes what the redesigned screenshot component has
> to display.
>
> *Cited: `src/content/index.ts:252` · `src/background/index.ts:66`*

### Screenshot 4 — Step card, input step

**State:** an expanded `input` step with full element metadata.

| # | Problem | Why it matters |
|---|---|---|
| 1 | **The XPath dominates the card** — 20 levels, wrapping three lines | Nobody reads `/div[1]/div[1]/div[1]…`. It is replay data, not review data, and it is the single largest element on the card. |
| 2 | CSS selector shown escaped: `input[aria-label="Go\ to\ file"]` | Unreadable, and not obviously copyable. |
| 3 | Tag / Label / CSS / XPath are a flat list at equal weight | No hierarchy between "what a human recognises" and "what a machine replays". |
| 4 | The `+2.7s` timing chip is clipped by the card edge | Layout overflow in the shipped build. |
| 5 | Value is shown twice — in the title *and* as its own row | `Typed "ffdfdfdff" into Go to file` already says it. |
| 6 | No way to collapse a step | Every step is fully expanded, forever. |

---

## 2 — Structural decisions

These are the changes that are not styling. Each one is why a screen exists in
the prompt list below.

**A. The viewer splits into two views: Library and Review.**
Today the flow library is an inline panel toggled by a counter button inside the
reviewer. They are different jobs — *choose a flow* vs *inspect a flow* — and
conflating them is why the toolbar has seven buttons. Library becomes the
viewer's landing view; Review is what you enter by opening a flow.

**B. One Export action, not three.**
`Download ZIP` / `Export Markdown` / `Export JSON`, the three include-checkboxes
and the filename modal collapse into a single Export dialog: format, contents,
filename, size estimate.

**C. The step list gets a navigation rail.**
A sticky index down the left: step number, type icon, elapsed time, and a red tick
for any step carrying a console error or a 4xx/5xx. A 30-step flow becomes
navigable, and "where did it break" is answerable at a glance.

**D. Replay data collapses.**
The card leads with the human-readable action; CSS selector and XPath move into a
collapsed *Selectors* row with copy buttons. Screenshots get a max height and
click-to-zoom instead of full-bleed.

**E. Settings leave the popup.**
MCP server URL, step cap, capture quality and redaction move to an options page.
The popup keeps one job: start, stop, and see what you have.

**F. Record red becomes exclusive.**
`--record` is used for the recording state and nothing else. Destructive actions
get a separate crimson, errors get amber-red with an icon. Today one red does all
three jobs.

**G. The six missing states get designed.**
Blocked tab, storage full, loading, export progress, destructive confirmation,
and a real empty state — none of which exist in the current build.

---

## 3 — The design system

Every prompt below repeats the essentials, because Stitch does not reliably carry
context between generations. This section is the canonical version; if a prompt
and this section disagree, this section wins.

### Identity

A precision instrument for developers. Dark-first, because the tool lives beside
DevTools and the user's Chrome is dark. Graphite surfaces, one teal accent for
actions, and red reserved exclusively for recording. Nothing decorative: every
colour on screen means something.

### Colour — dark theme (primary)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0E1213` | App background |
| `--surface` | `#161B1D` | Cards, popup body |
| `--surface-raised` | `#1D2426` | Hovered card, toolbar, input |
| `--surface-sunk` | `#0A0E0F` | Code blocks, screenshot mat |
| `--border` | `#28312F` | Hairlines |
| `--border-strong` | `#3A4644` | Focused input, active tab |
| `--fg` | `#E4EBE9` | Primary text |
| `--fg-muted` | `#9AA8A5` | Secondary text, labels |
| `--fg-faint` | `#6B7A77` | Timestamps, hints |
| `--accent` | `#2BB3A3` | Primary buttons, links, focus ring |
| `--accent-hover` | `#38C9B8` | Hover |
| `--accent-soft` | `#0F2B29` | Accent-tinted backgrounds |
| `--on-accent` | `#04211E` | Text on accent fill |
| `--record` | `#E5484D` | **Recording only** — dot, badge, stop button |
| `--record-soft` | `#2A1113` | Recording banner background |
| `--danger` | `#C24A4A` | Destructive confirm buttons |
| `--warn` | `#D9A441` | Warnings, storage pressure |
| `--warn-soft` | `#2A2213` | Warning banner |
| `--success` | `#3FB984` | Success toast, 2xx |
| `--success-soft` | `#0F2A1F` | Success banner |

### Colour — light theme

| Token | Hex |
|---|---|
| `--bg` | `#F4F7F6` |
| `--surface` | `#FFFFFF` |
| `--surface-raised` | `#EDF2F1` |
| `--surface-sunk` | `#E4EBE9` |
| `--border` | `#DCE4E2` |
| `--border-strong` | `#B4C1BE` |
| `--fg` | `#0E1213` |
| `--fg-muted` | `#4E5C59` |
| `--fg-faint` | `#75837F` |
| `--accent` | `#0E7C70` |
| `--accent-hover` | `#0B655C` |
| `--accent-soft` | `#DFF1EE` |
| `--on-accent` | `#FFFFFF` |
| `--record` | `#D02B31` |
| `--record-soft` | `#FCE9E9` |
| `--danger` | `#B23B3B` |
| `--warn` | `#8A6212` |
| `--success` | `#12784F` |

### Semantic colour for data

HTTP methods and console levels are data, not decoration — they use a fixed map,
not the accent:

`GET` slate · `POST` green · `PUT` amber · `PATCH` violet · `DELETE` red
Status `2xx` green · `3xx` blue · `4xx` amber · `5xx` red
Console `error` red · `warn` amber · `info` blue · `log` slate

Step types: `navigate` blue · `click` teal · `input` violet · `note` slate.

### Typography

**IBM Plex Sans** for the interface, **IBM Plex Mono** for anything a machine
produced — selectors, URLs, JSON, timestamps, step numbers, flow ids. One family
in two voices; the mono is doing real work, not decoration.

| Role | Size / weight / tracking |
|---|---|
| Popup title | 15px / 600 / -0.01em |
| Page title | 20px / 600 / -0.015em |
| Section heading | 13px / 600 |
| Step action title | 15px / 550 / -0.005em |
| Body | 13px / 400 / 1.55 |
| Label (mono, uppercase) | 10px / 500 / 0.09em |
| Metadata | 12px / 400 |
| Code / selector (mono) | 12px / 400 |
| Button | 13px / 550 |

### Space, shape, motion

- 4px base unit. Card padding 16px, popup padding 14px, gap between cards 10px.
- Radius: 6px controls and inputs, 10px cards and dialogs, 999px pills and chips.
- Borders 1px. One shadow only, on overlays: `0 12px 32px rgb(0 0 0 / 45%)`.
- Transitions 120ms ease-out on colour and transform. Nothing else animates.
- The recording dot pulses at 2s; everything honours `prefers-reduced-motion`.

### Icons

Lucide, 16px, 1.5px stroke, `currentColor`. Never emoji. The product mark is a
geometric lightning-bolt-in-rounded-square in `--accent`, not `⚡`.

### Components

- **Button** — 32px tall (28px compact), 6px radius, 12px horizontal padding.
  Variants: primary (accent fill), secondary (surface-raised + border), ghost
  (transparent, border on hover), danger (danger fill, confirm dialogs only),
  record (record fill).
- **Chip** — 20px, 999px radius, mono 10px uppercase. Used for step type, HTTP
  method, status, console level.
- **Card** — surface, 1px border, 10px radius, 16px padding.
- **Input** — 32px, surface-raised, 1px border, 6px radius; focus is a 2px accent
  ring, never a removed outline.
- **Toast** — bottom-centre in the viewer, 10px radius, icon + message + optional
  Undo, auto-dismiss 6s, dismissible.
- **Empty state** — icon, one-line title, one-sentence explanation, one primary
  action. Never a bare sentence.
- **Focus** — 2px `--accent` ring at 2px offset on every interactive element.

### Constraints

- Popup: **360px wide**, height driven by content, hard max 600px. (The current
  260px is why the buttons stack and the settings hide.)
- Viewer: full browser tab, content column max 1100px, centred, 24px gutters.
- Both themes must be designed. Dark is primary.
- Every screen must survive a 4× step count without a new scroll pattern.

---

## 4 — Stitch prompts

Run them in order — later screens reference earlier ones. Paste one at a time.

---

### Prompt 0 — Design system seed

> Create a design system for **FlowSnap**, a Chrome extension for developers that
> records browser sessions — clicks, typing, navigation, network calls and console
> output — and exports them as context for an AI assistant. It is a precision
> developer instrument, not a consumer app: dense, calm, and legible. Think
> Linear or Vercel dashboard, not a marketing site.
>
> **Dark theme is primary.** Backgrounds: `#0E1213` page, `#161B1D` cards,
> `#1D2426` raised controls, `#0A0E0F` code blocks. Borders `#28312F`. Text
> `#E4EBE9` primary, `#9AA8A5` secondary, `#6B7A77` faint.
>
> **One accent: teal `#2BB3A3`** for primary buttons, links and focus rings.
> **Red `#E5484D` is reserved exclusively for the recording state** — the pulsing
> dot, the recording badge, and the stop button. It is never used for a generic
> button or a generic error. Destructive confirmations use crimson `#C24A4A`,
> warnings amber `#D9A441`, success green `#3FB984`.
>
> Also produce a **light theme** with the same structure: `#F4F7F6` page,
> `#FFFFFF` cards, `#EDF2F1` raised, `#DCE4E2` borders, `#0E1213` text, teal
> accent `#0E7C70`, record red `#D02B31`.
>
> **Typography: IBM Plex Sans** for interface text, **IBM Plex Mono** for anything
> machine-generated — CSS selectors, URLs, JSON, timestamps, step numbers.
> Interface sizes 10 / 12 / 13 / 15 / 20px. Uppercase mono labels at 10px with
> 0.09em letter-spacing.
>
> **Shape and space:** 4px base unit; 6px radius on buttons and inputs, 10px on
> cards and dialogs, 999px on pills; 1px borders; exactly one shadow, used only on
> overlays.
>
> Show a component sheet containing: primary / secondary / ghost / danger /
> record buttons in default, hover, active, focused and disabled states; text
> input in default, focused, error states; a chip set (step type, HTTP method,
> HTTP status, console level); a card; a toast with an Undo action; a segmented
> control; a checkbox; a progress bar; and an empty-state block. Include a 16px
> Lucide icon set: circle-dot, square, pause, play, trash-2, download, settings,
> copy, chevron-right, alert-triangle, check-circle, image, pen-tool, search,
> arrow-left. No emoji anywhere.

---

### Prompt 1 — Popup, idle

> Design the **popup** for FlowSnap, a Chrome extension that records browser
> sessions for AI analysis. Use the FlowSnap design system: dark theme primary,
> `#0E1213` page, `#161B1D` cards, teal `#2BB3A3` accent, record red `#E5484D`
> used only for recording, IBM Plex Sans + IBM Plex Mono, 6px/10px/999px radii.
>
> **Exactly 360px wide**, height driven by content, never taller than 600px. This
> is a browser-extension popup, so it has no browser chrome of its own.
>
> **User goal in this state:** start recording the current tab, or open the flow
> they already captured.
>
> **Problems in the version being replaced:** three full-width stacked buttons of
> identical visual weight so nothing reads as primary; the Start button was red
> while the destructive Clear button was pale grey, inverting the colour
> semantics; "3 steps captured" was plain text conveying nothing about what was
> captured; and a developer setting (a server URL field) sat in a disclosure at
> the bottom of the primary surface.
>
> **Layout, top to bottom:**
> 1. **Header row**, 44px: a 20px rounded-square teal product mark with a
>    lightning glyph, the wordmark "FlowSnap" at 15px/600, and on the right a 28px
>    ghost icon button (Lucide `settings`) that opens the options page. Hairline
>    border beneath.
> 2. **Target row**: the mono uppercase label `RECORDING TARGET`, and beneath it
>    the current tab's favicon plus its hostname in mono 12px, truncated with an
>    ellipsis — e.g. `github.com`. This tells the user exactly what will be
>    recorded.
> 3. **Primary action**: a full-width 40px button, teal fill, containing a Lucide
>    `circle-dot` icon and the label **Start recording**. This is the only filled
>    button on the screen.
> 4. **Current flow card** — a bordered card with 12px padding showing: the mono
>    uppercase label `CURRENT FLOW`; the step count as a large 20px number with the
>    word "steps" beside it; the time of the last step as relative text
>    ("2 minutes ago") in faint 12px; a row of three small 40×26px rounded
>    screenshot thumbnails with a `+2` counter chip if there are more; and a footer
>    row with two ghost buttons, **Open flow** (with `chevron-right`) and a
>    24px icon-only `trash-2` button whose tooltip reads "Discard flow".
> 5. **Footer**, 28px, separated by a hairline: on the left a mono 10px storage
>    reading `1.2 MB / 10 MB` next to a 3px-tall progress bar; on the right a mono
>    10px ghost link **Library** with an `arrow-up-right` icon.
>
> **Also produce a second variant: the empty state.** Identical header, target row
> and primary button, but replace the current-flow card with an empty block —
> a 32px `circle-dot` icon at 30% opacity, the line "No flow recorded yet" at
> 13px, and the sentence "Press Start recording, then use the page as you normally
> would." at 12px in muted text, centred, 24px vertical padding. No footer storage
> reading in this variant.
>
> **Interaction states to show:** the primary button in default, hover (lighter
> teal), and keyboard-focused (2px teal ring at 2px offset); the current-flow card
> in default and hover (background lifts to `#1D2426`).
>
> Deliver both dark and light themes for both variants.

---

### Prompt 2 — Popup, recording and paused

> Design two more states of the same 360px-wide **FlowSnap** browser-extension
> popup, matching the previously designed idle popup exactly in header, spacing,
> type and colour. Design system: dark primary `#0E1213` / `#161B1D`, teal
> `#2BB3A3` accent, record red `#E5484D` reserved for recording, IBM Plex Sans +
> Mono, 6px/10px/999px radii.
>
> **State A — Recording.** The user goal is to see that capture is live, watch it
> count up, and stop or pause without hunting.
>
> - Same 44px header, but the product mark is joined by an 8px pulsing red dot.
> - Replace the target row with a **recording banner**: full-width, `#2A1113`
>   background, 1px `#E5484D` border at 40% opacity, 10px radius, 12px padding.
>   Inside: a pulsing red dot, the word **Recording** at 13px/600 in red, and on
>   the right an elapsed timer in mono 13px (`00:47`) using tabular figures.
> - Beneath it, a **live step counter**: the count as a 28px mono number, the word
>   "steps captured" at 12px muted, and — because a 30-step cap exists — a thin
>   progress bar with the mono caption `12 / 30`. When the count reaches 25 the bar
>   turns amber `#D9A441` and the caption reads `12 / 30 · approaching limit`;
>   show this as a sub-variant.
> - A **last step** line in mono 12px, truncated: `Clicked "Save changes"`, with a
>   faint `2s ago`. It proves capture is actually working.
> - **Two buttons side by side**, equal width, 40px tall: **Pause** (secondary,
>   `pause` icon) and **Stop** (red fill `#E5484D`, `square` icon). Stop is the
>   only red control.
> - Footer as designed for the idle popup.
>
> **State B — Paused.** Identical structure, but: the banner background becomes
> amber-tinted `#2A2213` with an amber border, the dot stops pulsing and becomes a
> static amber `pause` icon, and the label reads **Paused** with the timer frozen
> and dimmed. The last-step line reads "Nothing is being captured while paused"
> in muted text. The two buttons become **Resume** (teal fill, `play` icon) and
> **Stop** (red fill). The step counter stays visible but dims to 70% opacity.
>
> Both states in dark and light themes. Show the Stop button's hover and focus
> states.

---

### Prompt 3 — Popup, blocked and error

> Design two failure states of the same 360px-wide **FlowSnap** browser-extension
> popup, matching the previously designed idle and recording popups exactly.
> Design system: dark primary `#0E1213` / `#161B1D`, teal `#2BB3A3`, record red
> `#E5484D`, amber `#D9A441`, IBM Plex Sans + Mono.
>
> These two states do not exist in the product yet. Both are cases where the
> extension currently claims success and silently does nothing.
>
> **State A — This tab cannot be recorded.** The user pressed the extension icon
> on a page FlowSnap has no access to: a `chrome://` page, the Chrome Web Store,
> the PDF viewer, or a tab that was already open when the extension was installed.
>
> - Same 44px header with settings button.
> - Where the target row sits, show the blocked target: the page's title and its
>   URL in mono 12px, with a 14px amber `alert-triangle` icon before it.
> - A **notice block**: `#2A2213` background, 1px amber border at 40% opacity,
>   10px radius, 12px padding. Heading "FlowSnap can't record this tab" at
>   13px/600. Body at 12px muted: "Chrome blocks extensions on internal pages like
>   chrome:// and the Web Store. Open a normal web page and try again."
> - The primary button is **disabled**: full width, 40px, `#1D2426` fill, muted
>   text, `circle-dot` icon at 40% opacity, label "Start recording", `not-allowed`
>   cursor. Show its disabled state clearly.
> - Below it, a ghost text button **Why is this blocked?** in 12px that would open
>   a documentation page.
> - Produce a **sub-variant** for the recoverable case — a tab opened before the
>   extension was installed — where the notice instead reads "FlowSnap needs to
>   reload this tab before it can record" with body text "This tab was open before
>   FlowSnap was installed.", and the primary button is **enabled** and teal,
>   labelled **Reload tab and start** with a `refresh-cw` icon.
>
> **State B — Storage is full.** Chrome gives the extension 10 MB and the user has
> reached it; new steps and screenshots are silently failing to save.
>
> - A **notice block** using the red-tinted `#2A1113` background and a red border:
>   heading "Storage is full" at 13px/600, body at 12px muted: "FlowSnap has used
>   all 10 MB Chrome allows. New steps won't be saved until you free some space."
> - A **storage breakdown**: a segmented horizontal bar at 8px tall showing three
>   proportional segments in teal, violet and slate, with a legend beneath in mono
>   11px — `Current flow 4.1 MB`, `Saved flows 5.2 MB`, `Other 0.7 MB`.
> - Two stacked full-width buttons: **Manage saved flows** (teal fill, primary)
>   and **Discard current flow** (ghost with a crimson `#C24A4A` label).
> - The Start recording button is disabled as in state A.
>
> Both states in dark and light themes.

---

### Prompt 4 — Viewer, flow library

> Design the **flow library** for FlowSnap, a Chrome extension that records
> browser sessions for AI analysis. This is a full browser tab, not a popup. Use
> the FlowSnap design system: dark theme primary `#0E1213` page / `#161B1D` cards
> / `#1D2426` raised / `#28312F` borders, teal `#2BB3A3` accent, record red
> `#E5484D` for recording only, IBM Plex Sans + IBM Plex Mono, 6px/10px/999px
> radii, 1px borders.
>
> **This screen is new.** Previously the flow library was an inline panel toggled
> by a button labelled "Saved Flows 0" inside the flow reviewer — choosing a flow
> and inspecting a flow were the same scrolling page. This screen separates them.
>
> **User goal:** find a recorded flow and open it, or manage what is stored.
>
> **Layout:** content column max 1100px, centred, 24px gutters.
>
> 1. **App bar**, 52px, sticky, hairline bottom border: teal rounded-square
>    product mark and the wordmark "FlowSnap" at 15px/600 on the left; on the
>    right a `settings` ghost icon button and a compact teal **New recording**
>    button with a `circle-dot` icon.
> 2. **Title row**: "Flows" at 20px/600, with a muted 13px count "7 flows ·
>    12.4 MB" beside it. On the right, a 32px search input with a `search` icon
>    and the placeholder "Search flows and steps", plus a segmented control with
>    the options **All / Recent / Largest**.
> 3. **Current flow card** — visually distinct, first in the list, with a teal
>    left edge 2px wide and a `#0F2B29` tint. Mono uppercase label `IN PROGRESS`
>    or `UNSAVED`. It shows a name, "12 steps · github.com · 4 minutes ago", a row
>    of 4 thumbnails, and two buttons: **Open** (teal fill) and **Save to library**
>    (secondary).
> 4. **Flow list** — one card per flow, 10px gap. Each card is a horizontal
>    layout: a 64×40px rounded screenshot thumbnail of the first step on the left;
>    then the flow name at 15px/550, and beneath it a mono 12px muted metadata
>    line `18 steps · app.example.com · 14 Aug, 09:32`; then a row of small chips
>    counting step types (`9 click`, `5 input`, `4 navigate`) and, when the flow
>    contains failures, a red chip `2 errors`; on the right, on hover, three ghost
>    icon buttons — `download`, `copy` (duplicate), `trash-2` — plus a persistent
>    `chevron-right`. The whole card is clickable and lifts to `#1D2426` on hover.
> 5. **Empty state variant** — when there are no flows at all: a centred block
>    with a 40px `folder-open` icon at 30% opacity, "No flows yet" at 15px/600,
>    the sentence "Record a browser session and it will appear here. Flows are
>    stored on this device only." at 13px muted, and a teal **Start a recording**
>    button.
> 6. **Loading state variant** — three skeleton cards using shimmering
>    `#1D2426` blocks in the same geometry as a real card.
>
> Show the hover state of a flow card with its action buttons revealed, and the
> keyboard-focused state with a 2px teal ring. Deliver dark and light themes.

---

### Prompt 5 — Viewer, flow review

> Design the **flow review** screen for FlowSnap, a Chrome extension that records
> browser sessions — clicks, typing, navigation, network calls, console output —
> and exports them as context for an AI assistant. Full browser tab. Use the
> FlowSnap design system: dark primary `#0E1213` page / `#161B1D` cards /
> `#1D2426` raised / `#28312F` borders, teal `#2BB3A3` accent, record red
> `#E5484D` for recording only, crimson `#C24A4A` for destructive actions, amber
> `#D9A441`, IBM Plex Sans + IBM Plex Mono, 6px/10px/999px radii.
>
> **This is the most important screen in the product.**
>
> **User goal:** read back what was recorded, remove or annotate steps, and hand
> the result to an AI.
>
> **Problems in the version being replaced:** seven top-level buttons in a row
> with no hierarchy, three of which were the same export in different file
> formats; a red "Clear All" button given its own prominent row; three
> export-option checkboxes permanently on screen although they only matter at
> export time; a permanent row of keyboard hints; screenshots rendered full-width
> so a 30-step flow was several screens of scrolling with no overview and no way
> to jump to a step; and two stacked headers before any content.
>
> **Layout — a two-column workspace, max 1240px, centred:**
>
> **App bar**, 52px, sticky: a ghost `arrow-left` **Back to flows** button; the
> flow name as an inline-editable 15px/600 field showing a pencil icon on hover;
> a mono 12px muted metadata line `18 steps · github.com · 14 Aug, 09:32`. On the
> right, in strict priority order: a teal filled **Send to Claude** button with a
> `sparkles` icon; a secondary **Export** button with a `download` icon and a
> `chevron-down`; and a ghost `more-horizontal` icon button whose menu contains
> Save to library, Duplicate, Import steps, and — separated by a divider and
> tinted crimson — Delete flow.
>
> **Left rail**, 208px, sticky, its own scroll: the mono uppercase label `STEPS`
> with a count; then a vertical timeline, one 36px row per step. Each row has a
> mono step number in a 20px circle, a 14px step-type icon colour-coded
> (navigate blue, click teal, input violet, note slate), a truncated 12px action
> label, and a mono 11px faint elapsed time (`+2.7s`). Steps containing a console
> error or a 4xx/5xx response get a 6px red dot on the right edge. The active step
> has a `#0F2B29` background and a 2px teal left edge. A vertical hairline
> connects the rows into a timeline. At the bottom of the rail, a filter row of
> small toggle chips: `All`, `Clicks`, `Inputs`, `Navigation`, `Errors`.
>
> **Right column** — the step list. Each step is a card, 10px gap between cards:
>
> - **Card header row:** a mono step number in a 24px circle; a step-type chip
>   (mono 10px uppercase, tinted per type); the action title at 15px/550 —
>   `Clicked "Save changes"` — which becomes an inline text input on click; a mono
>   11px faint elapsed chip `+2.7s` that must never clip at the card edge; and on
>   the right, revealed on hover, ghost icon buttons `grip-vertical` (reorder),
>   `image` (annotate), and `trash-2`.
> - **URL line:** mono 12px, muted, truncated from the middle, with a `copy` icon
>   on hover. Shown only when the URL differs from the previous step, and then
>   prefixed with a 12px `corner-down-right` icon and the mono label `PAGE
>   CHANGED`.
> - **Screenshot:** the whole capture at its own aspect ratio — full width,
>   `height: auto`, 8px radius, 1px border, on a `#0A0E0F` mat. A `maximize-2`
>   icon button in the top-right corner on hover opens it full size.
>
>   *Superseded.* The brief called for a 320px cap cropped from the top and said
>   explicitly not to render screenshots full-bleed. Shipped, that crop cut the
>   page mid-content, and since a cropped shot looks identical to a short one,
>   the part a step was recorded to show could silently be below the cut. Height
>   is the cost and the step rail already jumps past it.
> - **Detail rows, collapsed by default**, each a 28px row with a chevron, a
>   label, and a count chip: **Selectors**, **Network (3)**, **Console (1)**.
>   Network and Console rows show their most severe status as a chip on the right
>   — a red `500` chip, or an amber `warn` chip — so the user can see there is
>   something wrong without expanding.
> - **Expanded Selectors** shows two mono rows: `CSS` with the selector in a
>   `#0A0E0F` code block and a `copy` button, and `XPath` in the same treatment
>   but clamped to two lines with a "show full" affordance. **The XPath must never
>   be the largest element on the card** — in the version being replaced it
>   occupied three full lines and dominated everything.
> - **Notes:** a borderless 13px textarea with the placeholder "Add a note for the
>   AI…", which only shows its border on focus.
>
> **Also design these variants:**
> - **A `navigate` step card** — no selectors row, a page-title line, blue chip.
> - **An expanded Network row** — a compact table of request rows, each with a
>   coloured method chip, a truncated mono path, a status chip, and a duration.
> - **A step with an error** — a 2px crimson left edge on the card and a red
>   `error` chip in the header.
> - **The empty state** — centred: a 40px `circle-dot` icon at 30% opacity, "This
>   flow has no steps" at 15px/600, "Steps you delete can be restored with Ctrl+Z
>   until you close this tab." at 13px muted, and a **Back to flows** button.
> - **The loading state** — the rail and three step cards as shimmering skeletons.
> - **An undo toast** — bottom-centre, `#1D2426`, 10px radius, shadow: a
>   `trash-2` icon, "Step 4 deleted", and a teal **Undo** text button, with a 6s
>   progress hairline along the bottom edge.
>
> Keyboard shortcuts must not occupy a permanent row: put them behind a `?` ghost
> icon button in the app bar that opens a shortcut sheet.
>
> Deliver dark and light themes.

---

### Prompt 6 — Export dialog

> Design the **export dialog** for FlowSnap, a Chrome extension that records
> browser sessions for AI analysis. It is a modal over the flow review screen.
> Use the FlowSnap design system: `#161B1D` dialog surface on a `rgba(0,0,0,0.6)`
> scrim, `#28312F` borders, teal `#2BB3A3` accent, IBM Plex Sans + IBM Plex Mono,
> 10px dialog radius, 6px control radius, one shadow `0 12px 32px rgb(0 0 0/45%)`.
>
> **This screen replaces four separate things:** three toolbar buttons that were
> the same export in different formats (ZIP, Markdown, JSON), a permanent row of
> three "include" checkboxes that only mattered at export time, and a bare
> filename prompt.
>
> **User goal:** get the flow out in the right shape, without guessing what each
> format contains.
>
> **Dialog: 480px wide, centred.**
>
> 1. **Header**: "Export flow" at 15px/600, a muted 12px subtitle "18 steps ·
>    github.com", and a ghost `x` close button.
> 2. **Format** — three selectable cards in a vertical stack, radio behaviour, the
>    selected one bearing a 1px teal border and a `#0F2B29` tint with a teal
>    `check-circle`. Each card has an icon, a name, a one-line description, and a
>    mono size estimate on the right:
>    - `file-archive` · **ZIP** · "Markdown, JSON and screenshot files. Best for
>      Claude — attach the folder." · `4.2 MB` · plus a small teal `RECOMMENDED`
>      chip.
>    - `file-text` · **Markdown** · "One file, screenshots embedded. Readable
>      anywhere." · `5.8 MB`
>    - `braces` · **JSON** · "Full selectors and timings. For replay and
>      tooling." · `240 KB`
> 3. **Include** — the mono uppercase label `INCLUDE`, then three checkbox rows,
>    each with a label and a mono size contribution on the right: "Screenshots
>    `4.0 MB`", "Network calls `180 KB`", "Console logs `24 KB`". Unchecking one
>    must visibly reduce the total.
> 4. **Redaction notice** — when network calls are included, a `#2A2213`
>    amber-tinted block with an `alert-triangle` icon: "Request and response
>    bodies may contain tokens or personal data. Headers are redacted
>    automatically; bodies are not." with a ghost text link "Review redaction
>    settings".
> 5. **Filename** — a text input pre-filled `flowsnap-flow-2026-08-15` with the
>    file extension shown as a non-editable mono suffix inside the field's right
>    edge.
> 6. **Footer** — a hairline top border, the running total on the left in mono
>    12px `Total 4.2 MB`, and on the right a ghost **Cancel** and a teal filled
>    **Export** button.
>
> **Also design an in-progress variant:** the Export button becomes disabled and
> shows a spinner with the label "Packaging…", a teal determinate progress bar
> appears above the footer, and a mono 12px caption reads "Compressing screenshot
> 12 of 18". This state does not exist today — a large export simply freezes with
> no feedback.
>
> Dark and light themes.

---

### Prompt 7 — Screenshot annotation editor

> Design the **screenshot annotation editor** for FlowSnap, a Chrome extension
> that records browser sessions. It opens as a full-screen modal over the flow
> review screen. Use the FlowSnap design system: `#0A0E0F` canvas mat, `#161B1D`
> chrome, `#28312F` borders, teal `#2BB3A3` accent, IBM Plex Sans + IBM Plex Mono,
> 6px/10px radii.
>
> **User goal:** mark up a screenshot to show the AI what matters, and hide
> anything sensitive before the image leaves the machine.
>
> **Problems in the version being replaced:** seven tools rendered as wide text
> buttons in a row (including an invented abbreviation, "Hi-lite"); the toolbar
> wrapped so that Undo, Save and Cancel ended up on a detached second row; the
> **Blur tool — the PII redaction control, the highest-stakes thing in the
> product — was the sixth text button and looked like every other option**; the
> colour swatches were raw iOS system colours unrelated to the theme, with a white
> swatch invisible against a white background; there was no zoom or fit-to-width;
> and the editor was inline, shoving the page around as it opened.
>
> **Layout:**
>
> 1. **Top bar**, 52px, `#161B1D`, hairline bottom border: on the left the title
>    "Annotate step 3" at 13px/600 with the mono 12px muted action beneath,
>    `Typed "hunter2" into Password`; on the right a ghost **Cancel** and a teal
>    filled **Save changes** button. These stay visible at all times — they must
>    never wrap to a second row.
> 2. **Left tool rail**, 56px wide, full height, `#161B1D`: vertically stacked
>    40px icon buttons, each with a tooltip on hover and a keyboard hint. In order:
>    `mouse-pointer` Select, `pen-tool` Pen, `square` Rectangle, `circle` Ellipse,
>    `arrow-up-right` Arrow, `highlighter` Highlight, `type` Text. Then a hairline
>    divider, then **`eye-off` Redact** — given its own group, an amber `#D9A441`
>    icon tint, and the tooltip "Redact — pixelates the area so it never leaves
>    your machine". The active tool has a `#0F2B29` background and a 2px teal left
>    edge.
> 3. **Canvas area**, centred on the `#0A0E0F` mat, the screenshot at 8px radius
>    with a 1px border and a subtle checkerboard behind any transparency. Show a
>    rectangle annotation in progress with 6px teal resize handles at its corners.
> 4. **Right properties panel**, 200px, `#161B1D`: the mono uppercase label
>    `STROKE`, a 3×3 grid of 24px colour swatches drawn from the design system —
>    red `#E5484D`, amber `#D9A441`, teal `#2BB3A3`, green `#3FB984`, blue
>    `#4C8DFF`, violet `#9A7CF0`, white, black, and a custom swatch — the selected
>    one ringed in teal. Beneath, `WIDTH` as a three-option segmented control
>    S / M / L showing actual stroke previews rather than letters. Beneath that,
>    `OPACITY` as a slider. When the Redact tool is active this panel changes to
>    show `BLOCK SIZE` as a slider with a live pixelation preview, and no colour
>    grid.
> 5. **Bottom bar**, 40px: on the left, zoom controls — a `minus` button, a mono
>    12px readout `100%`, a `plus` button, and a ghost **Fit** button. In the
>    centre, `undo` and `redo` icon buttons with their keyboard hints. On the
>    right, a mono 11px faint hint: `Esc to cancel · ⌘S to save`.
>
> **Also design:** the Redact tool in its active state with a pixelated region
> visible on the canvas, and an unsaved-changes confirmation dialog reading
> "Discard annotations?" with body "Your markup on this screenshot will be lost."
> and buttons Cancel / Discard, the latter in crimson `#C24A4A`.
>
> Dark and light themes.

---

### Prompt 8 — Settings

> Design the **settings page** for FlowSnap, a Chrome extension that records
> browser sessions for AI analysis. It is a full browser tab. Use the FlowSnap
> design system: `#0E1213` page, `#161B1D` cards, `#28312F` borders, teal
> `#2BB3A3` accent, amber `#D9A441`, crimson `#C24A4A`, IBM Plex Sans + IBM Plex
> Mono, 6px/10px radii.
>
> **This screen is new.** These controls were previously either hardcoded in
> source or hidden inside a disclosure triangle at the bottom of the extension
> popup.
>
> **Layout:** app bar with a `arrow-left` Back button, the product mark and the
> title "Settings". Content column max 720px, centred. Sections separated by
> hairlines, each with a 13px/600 heading, a 12px muted description, and rows
> where the label and its helper text sit left and the control sits right.
>
> **Recording**
> - "Steps per recording" — a number input, default 30, helper "Recording stops
>   automatically at this many steps."
> - "Screenshot quality" — a segmented control Low / Medium / High with a mono
>   helper showing the storage trade-off, "~180 KB per step".
> - "Capture network requests" — a toggle, on.
> - "Capture console output" — a toggle, on.
> - "Hide the recording indicator in screenshots" — a toggle, on, with the helper
>   "Keeps FlowSnap's own badge out of the images you export."
>
> **Privacy**
> - "Mask password fields" — a toggle, on, locked, with a small `lock` icon and
>   the helper "Always on. Password values are never stored."
> - "Redact request and response bodies" — a toggle, off, helper "Headers are
>   always redacted. Turn this on to also strip body contents."
> - "Additional redaction patterns" — a mono textarea with one regular expression
>   per line and the placeholder `api[_-]?key`.
>
> **Claude / MCP**
> - "MCP server URL" — a mono text input pre-filled `http://127.0.0.1:7734/flows`,
>   with a **Test connection** secondary button beside it. Show three result
>   states inline: a teal `check-circle` with "Connected · flowsnap v1.0.0", an
>   amber spinner with "Checking…", and a crimson `alert-triangle` with "No server
>   at that address. Start it with `npm start` in mcp-server/."
> - "Send flows automatically when recording stops" — a toggle, **off by
>   default**, with an amber-tinted helper block: "Sends the whole flow —
>   screenshots and request bodies included — to the address above every time you
>   press Stop."
>
> **Storage**
> - A segmented usage bar with a mono legend, exactly as designed for the popup's
>   storage-full state.
> - A **Delete all flows** button in crimson ghost style, right-aligned.
>
> **Appearance**
> - "Theme" — a segmented control System / Light / Dark.
>
> Footer: mono 11px faint, `FlowSnap 1.0.0`, with ghost links "Changelog" and
> "Report an issue".
>
> Dark and light themes.

---

### Prompt 9 — Dialogs, toasts and feedback

> Design the **confirmation and feedback components** for FlowSnap, a Chrome
> extension that records browser sessions. Use the FlowSnap design system:
> `#161B1D` surfaces on a `rgba(0,0,0,0.6)` scrim, `#28312F` borders, teal
> `#2BB3A3`, crimson `#C24A4A` for destructive actions, amber `#D9A441`, green
> `#3FB984`, IBM Plex Sans + IBM Plex Mono, 10px dialog radius, one shadow.
>
> **None of these exist in the product today** — destructive actions currently
> fire immediately with no confirmation and no feedback.
>
> **Confirmation dialogs**, 420px wide, each with an icon, a title at 15px/600, a
> body at 13px muted, and a right-aligned button pair where the destructive
> action is a crimson fill and Cancel is a ghost. The destructive button is
> **never** the default focus. Design these four:
> - `trash-2` crimson — "Discard this recording?" / "12 steps and their
>   screenshots will be deleted. This cannot be undone." / Cancel · Discard.
> - `trash-2` crimson — "Delete "Checkout bug repro"?" / "18 steps will be removed
>   from your library." / Cancel · Delete.
> - `alert-triangle` amber — "Delete all 7 flows?" / "Everything in your library
>   will be removed. Export anything you want to keep first." / with a text input
>   the user must fill with the word `delete` to enable the destructive button —
>   show it both disabled and enabled. / Cancel · Delete everything.
> - `upload` teal — "Send this flow to Claude?" / "The whole flow, including
>   screenshots and captured request bodies, will be sent to
>   `http://127.0.0.1:7734`." / with a "Don't ask again" checkbox / Cancel · Send.
>
> **Toasts**, bottom-centre, 360px, 10px radius, icon plus message plus optional
> action, with a 6s progress hairline along the bottom edge. Design five:
> - Success, green `check-circle`: "Flow sent to Claude" with a mono flow id
>   beneath and a **Copy prompt** action.
> - Undo, slate `trash-2`: "Step 4 deleted" with an **Undo** action.
> - Success, green `download`: "Exported flowsnap-flow-2026-08-15.zip".
> - Error, crimson `alert-triangle`: "Couldn't reach the MCP server" with body
>   "Start it with `npm start` in mcp-server/" and a **Retry** action.
> - Warning, amber `alert-triangle`: "Screenshot skipped — storage is nearly full"
>   with a **Manage storage** action.
>
> **Inline banners**, full-width within a content column, 10px radius, tinted
> background and a 1px border at 40% opacity, icon plus text plus optional action.
> Design three: an amber "This flow is read-only. Save a copy to edit it." with a
> **Save a copy** action; a red "3 screenshots are missing — Chrome limits how
> often extensions can capture the screen." with a **Learn more** link; and a teal
> "Recording in progress in another tab" with a **Go to tab** action.
>
> Dark and light themes for everything.

---

### Prompt 10 — On-page recording indicator

> Design the **on-page recording indicator** for FlowSnap, a Chrome extension
> that records browser sessions. This element is injected into the web page the
> user is recording, so it sits on top of someone else's design and must be
> unmistakably not part of it. Use the FlowSnap design system: record red
> `#E5484D`, `#161B1D` surface, IBM Plex Sans, 999px radius.
>
> **Constraints:** fixed to the bottom-right, 16px from each edge, above all page
> content. Must be legible on both a white and a black page. Must not obstruct
> content. **It is hidden during screenshot capture** — the current build bakes it
> into every screenshot it takes.
>
> Design four states as a single compact pill, 32px tall, `#161B1D` at 96%
> opacity with a 1px `#E5484D` border at 50% opacity, 12px horizontal padding,
> and a soft shadow:
>
> 1. **Recording** — an 8px pulsing red dot, the word "Recording" at 12px/600 in
>    white, a hairline divider, and a mono 12px step count `12`.
> 2. **Paused** — an amber `pause` icon, the word "Paused" in amber, the count
>    dimmed, no pulse.
> 3. **Step captured** — a momentary expansion showing a teal `check` icon and the
>    truncated action text `Clicked "Save changes"`, which collapses back to state
>    1 after 1.5 seconds. Show both the expanded frame and the collapsed one.
> 4. **Hovered** — the pill expands to reveal two 24px icon buttons, `pause` and
>    `square` (stop), so the user can control recording without opening the popup.
>
> Show each state composited over both a light page and a dark page to prove
> legibility. Also show the reduced-motion variant, where the dot is solid rather
> than pulsing.

---

## 5 — How to run and review this

1. Run **Prompt 0** first and keep the generated design system open — Stitch is
   more consistent when the palette and components already exist in the project.
2. Run prompts **1 → 10** in order. Each is self-contained by design; the
   repetition of the palette and type rules is deliberate.
3. Bring the output back and we review against this checklist before any code is
   written:

| Check | Why |
|---|---|
| Is exactly one action per screen visually primary? | The current popup has three co-equal buttons. |
| Is red used *only* for recording? | Today it means record, danger and error at once. |
| Does every destructive action have a confirmation, or an undo? | Today none of them do. |
| Is the XPath visually subordinate on the step card? | Today it is the largest element. |
| Does the 360px popup hold every state without scrolling? | The blocked and storage-full states are the tight ones. |
| Do both themes exist for every screen? | The build ships light only. |
| Is any state missing its loading, empty, and error variant? | Six states have no design at all today. |
| Does a 30-step flow stay navigable? | This is what the left rail exists to prove. |

4. Once approved, implementation follows migration steps 6 → 8 in `AUDIT.md`:
   tokens and shared components first, then the popup state by state, then the
   viewer view by view. Each state is implemented and checked against its Stitch
   frame before the next one starts.

**Not in scope for this phase:** the seven correctness defects from `AUDIT.md`
plus C8 above. Those are migration step 5 and land against the current UI, so a
regression there cannot be confused with a redesign change.
