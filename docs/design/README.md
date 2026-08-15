# Working with the Stitch export

**Read this before porting anything from `stitch_flowsnap_design_system/`.**

The export is a *layout and composition* reference. It is not a source of
colour, type weight, icon choice, or copy. `src/ui/styles/tokens.css` is
authored from [`../DESIGN-BRIEF.md`](../DESIGN-BRIEF.md) §3 and is the only
authority on tokens.

Verified against the export on 15 August 2026, 35 screens.

---

## 1. Stitch substituted its own Material 3 palette

Every screen imports `technical_precision/DESIGN.md`, a complete M3 token set
that Stitch generated rather than the palette the prompts specified. The brief's
accent was demoted to a container role and Stitch's own lighter teal became
primary.

| Role | Brief (`tokens.css`) | Export | Uses in export |
|---|---|---|---|
| Accent | `#2BB3A3` | `#5EDAC9` (brief value demoted to `primary-container`) | 33 |
| Page background | `#0E1213` | `#101415` | 12 |
| Surface | `#161B1D` | `#181C1D` | 2 |
| Body text | `#E4EBE9` | `#E0E3E4` | — |
| Border | `#28312F` | `#3D4947` | — |
| **Record red** | `#E5484D` | Material `secondary` / `error` | **1** |

`#E5484D` — the one colour the redesign exists to protect — appears exactly once
across all 35 screens.

**Consequence:** `tokens.css` cannot be generated from the export. It was
written from the brief instead. When a Stitch frame and `tokens.css` disagree
about a colour, `tokens.css` wins, always.

## 2. The record-red collision came back

Structural decision **F** exists because the shipped build used one red for
"record", "delete" and "failed" at once, so nothing about a red thing told you
which it was. The export reintroduces it:

- `flowsnap_recording_dark` drives the pulsing dot and the Stop button from
  `bg-error`.
- `flowsnap_review_dark_main` drives console-error text, `500` chips and the
  failed step's left edge from the same family.
- Material's `secondary` `#FFB3B0` (66 uses) and `error` `#FFB4AB` (32 uses)
  differ by 3 in a single channel. They are indistinguishable on screen.

**When implementing:** recording UI takes `--record`. Destructive confirmation
takes `--danger`. Failure states take `--log-error` / `--status-5xx`. Never
reuse one for another, whatever the frame shows.

## 3. Seven of the twelve "light" screens are dark

| Genuinely light (5) | Named `_light`, actually dark (7) |
|---|---|
| `annotation_editor_light`, `confirmation_dialogs_light`, `export_light_main`, `popup_light_empty`, `popup_light_flow` | `blocked_tab_light`, `feedback_banners_light`, `recording_light`, `review_light_main`, `settings_light_main`, `storage_full_light`, `library_light_main` |

Six carry `<html class="dark">`; `library_light_main` carries no theme class at
all.

**Do not regenerate these.** §3 of the brief has a complete light token table,
and the five real light frames prove the mapping works. Deriving the rest from
tokens at implementation is cheaper and more consistent than another Stitch
round.

## 4. Quarantined screens — do not port

| Screen | Why |
|---|---|
| `flowsnap_review_light_main` | Not the review screen. A single step-detail view with an `Export JSON` button — the exact thing decision **B** collapses — a rail labelled "EXECUTION TIMELINE" with no elapsed times or error dots, and no screenshot, notes field or step cards. |
| `flowsnap_popup_light_flow` | Inverts the colour semantics the redesign fixes: it is a *recording* state with a teal **Stop Recording** fill and a red timer pill. Also invents a Tags feature, reports `50MB USED` against a 10 MB quota, and versions the product `v1.2.4`. |
| `flowsnap_annotation_editor_dark` | Branded **TraceCapture**, not FlowSnap. |
| `flowsnap_annotation_editor_light` | Branded **TraceCapture**. |
| `flowsnap_redact_tool_active` | Branded **TraceCapture**. |
| `flowsnap_discard_confirmation` | Branded **TraceCapture**. |

The whole annotation-editor family carries the wrong product name, so Prompt 7
is the one screen with no usable frame. Implement it from the prompt text.
Done in step 8 — see the header comment on `src/ui/viewer/annotate.ts`, which
lists the five failings of the editor it replaces and where each one is
addressed. The two quarantined *light* screens were not regenerated either:
their dark counterparts are correct and light is derivable from the token table,
so another Stitch round would risk a third palette rather than settle anything.

## 5. Smaller drift to correct while porting

- **Icons are Material Symbols** in all 35 screens; the system specifies Lucide
  at 16px / 1.5px stroke. Substitute on the way in — the geometry is generated
  into `src/ui/icons.generated.ts` by `npm run build:icons`, so this is a
  one-word swap. Markup names an icon (`<span data-icon="circle-dot"></span>`)
  and never carries a path.
- **Amber is inconsistent** — `#FBBF24` in 11 places against the token
  `#D9A441` in 8. Use the token.
- **Weight 550 does not exist.** The brief specified it twice; static IBM Plex
  Sans ships 450/500/600, so it would have rounded silently. `tokens.css`
  corrects this to `--weight-medium: 500`.
- ~~**IBM Plex is not vendored yet.**~~ Resolved in step 6: the woff2 files are
  in `public/fonts/` and declared in `src/ui/styles/fonts.css`. See
  [`fonts.md`](./fonts.md), in particular the `unicode-range` descriptor — only
  the Latin subset ships, and that descriptor is what keeps a Cyrillic or CJK
  page title from rendering as tofu.

---

## What step 6 built

| File | What it is |
|---|---|
| `src/ui/styles/tokens.css` | The values. The only file allowed to name a colour. |
| `src/ui/styles/fonts.css` | `@font-face` for the five vendored weights. |
| `src/ui/styles/base.css` | Reset, document defaults, focus ring, six utilities. |
| `src/ui/styles/components.css` | Button, chip, card, field, switch, segmented, banner, empty state, meter, toast, dialog, spinner, skeleton, record dot. |
| `src/ui/styles/index.css` | The single stylesheet a page links. Order is load-bearing. |
| `src/ui/icons.ts` + `icons.generated.ts` | Lucide geometry, generated from `lucide-static`. |
| `src/ui/theme.ts` | The three-state preference, applied before first paint. |
| `src/ui/format.ts`, `src/ui/toast.ts` | Shared so a phrase means one thing everywhere. |

`npm run lint:tokens` enforces the rule the whole system rests on: no colour
outside `tokens.css`. It runs in `verify` and in CI. **One file is exempt**, and
the script says why: `public/content.css`, which is injected into somebody
else's document where `tokens.css` does not exist and `:root` belongs to the
page. The `PENDING` list — the surfaces that predated the design system — is
empty as of step 8.

## What step 8 built

| File | What it is |
|---|---|
| `src/viewer.html` | Both views' markup, plus a `<template>` per repeated row. |
| `src/ui/viewer/viewer.css` | Layout only. Every control is a component. |
| `route.ts` | `#/` · `#/current` · `#/flow/<id>`, and the id validation the hash needs. |
| `library-view.ts` · `review-view.ts` · `export-view.ts` | The three pure view models. 45 tests. |
| `library.ts` · `review.ts` · `export-dialog.ts` · `annotate.ts` | The controllers. They render a view and nothing else. |
| `annotate-ops.ts` | The annotation model and its geometry, tested apart from the canvas. |
| `features/flows/store.ts` | The only place saved flows are read or written. |
| `features/export/download.ts` | The file-writing half of an export, split from the choosing half. |
| `features/mcp/send.ts` | Send to Claude, lifted out of the viewer. |

### The product mark

`scripts/build-mark.mjs` rasterises `public/icons/icon{16,32,48,128}.png` from
the same geometry as the inline SVG the popup, viewer and settings page draw —
`npm run build:mark`. It is a supersampling rasteriser and a minimal PNG encoder
with no dependencies, because `manifest.icons` is raster only and Chrome will
not take the SVG.

The icons it replaced were a red circle with a white slash, unrelated to
anything else in the product and never updated when it was renamed. The toolbar
icon cannot follow the theme — it sits in Chrome's chrome, not ours — so it uses
the dark palette's brighter teal, which reads on a light toolbar as well.

Two deliberate departures from the frames, both recorded here so they are
choices rather than drift:

- **The library's sort control is Recent / Largest / Name**, not the frame's
  `All / Recent / Largest`. That set is one filter and two sorts wearing the
  same control — "All" of what, against a list that is already all of them?
- **The library has no "New recording" button.** The frame puts one in the app
  bar. The viewer is an extension page, so a recording started there targets a
  tab Chrome blocks — the button could only ever open a popup saying it cannot
  record this tab. Recording begins on the tab being recorded, from the toolbar;
  the empty state says so.
- **There is no Duplicate action.** The review frame's overflow menu offers one.
  It was originally left out because duplicating doubled the largest thing in a
  10 MB store; that argument died with the quota (see below), so what remains is
  simply that I could not name the use. It can arrive in step 10 if one turns up.

One departure from the *prompt*: the annotation palette is a fixed set of
values in `annotate-ops.ts`, not design tokens. That ink is baked into a JPEG
that leaves the machine, so it must not change when the theme does. The values
are taken from the system's data colours so the two still look like one product,
and the swatch borders are tokens — which is what makes the white swatch
visible on a white panel, as the audit complained it was not.

## The storage quota, and the designs that assumed it

The brief and the frames were drawn against `chrome.storage.local`'s 10 MB
default: §5 State B specifies a "Storage is full" screen, Prompt 1 specifies a
`1.2 MB / 10 MB` meter in the popup footer, and Prompt 2's live counter has a
progress bar "because a 30-step cap exists". The manifest now asks for
**`unlimitedStorage`**, and none of those three things survive it.

Measured against the 125 real recordings in `mcp-server/flows/`: 946
screenshots, median 86 KB each; per flow, median 632 KB and 2.6 MB at the top.
Base64 in `storage.local` adds about 37%. So 10 MB held roughly five ordinary
flows — a library screen with search, three sorts and a size column, over a store
that could not hold enough to sort.

What changed, and why the frames are not simply wrong:

| Frame | Now | Why |
|---|---|---|
| Storage meter, popup and library | A figure — `14.2 MB stored` | A bar needs a denominator. The only one left is the user's disk, and a bar against that reads empty forever while implying a budget nobody is managing. |
| Settings meter with `45% used` | The same figure, plus per-step cost | Per-step is the number that lets someone predict what the next recording costs. A percentage of nothing does not. |
| Live counter's `12 / 30` bar | The count alone | It filled toward a cap that no longer exists. |
| "Storage is full" | "The disk is full" | With `unlimitedStorage` the only remaining write failure is the disk. Saying "storage" sends the user hunting for flows to delete, which frees almost nothing. |
| `MAX_STEPS = 30` | `500`, as a runaway guard | Detailed below. |

`MAX_STEPS` is no longer a product limit. Stopping a recording at 30 steps makes
the user repeat everything they just did, and the number came from storage rather
than from usefulness. It is now a backstop, and 500 was measured rather than
picked for roundness.

Every capture rewrites the whole `recordedSteps` key, so a step costs more the
longer the flow is. Against real screenshot sizes that round trip is:

| Steps | Rewritten per capture | Cost per capture |
|---|---|---|
| 30 | 6 MB | 8 ms |
| 100 | 19 MB | 22 ms |
| 200 | 38 MB | 43 ms |
| 500 | 94 MB | 106 ms |

`CAPTURE_MIN_INTERVAL_MS` is 550 ms, so even at the backstop the recorder never
falls behind its own throttle. Going higher than 500 would mean splitting the
array into a key per step first — which is the same change that would let
screenshots move to IndexedDB, and neither is worth doing until a flow that long
actually exists.

`WARN_STEPS` moved from 25 to 150 and changed meaning with it: it no longer says
the cap is close, it says the flow is getting long to export. It deliberately
does not name `MAX_STEPS`, because pointing at the backstop would turn a note
about usefulness back into a note about running out of room.

Two deletions worth calling out separately:

- The worker used to measure usage before every capture and **silently drop the
  screenshot** past an 8 MB budget, so a long recording quietly degraded into
  steps with no pictures. That is the one thing a screenshot recorder must not
  do, and there is nothing left to trade away.
- `screenshotOriginal` is now stored **only when annotating actually changed the
  image**. A step with no highlight box held two byte-identical copies of the
  same picture, and since the whole array is rewritten on every capture, that
  waste was multiplied by the length of the recording. Every reader already
  treats it as `screenshotOriginal ?? screenshot`, so null was always the right
  way to say "the same one".

`tests/manifest.test.ts` guards the permission, because the guard it replaced is
gone — losing `unlimitedStorage` now means hitting 10 MB with nothing to catch it.

## 6. What the export gets right

- **`flowsnap_review_dark_main` is the strongest frame in the set**, and it is
  the hardest screen: rail with elapsed times, error dots and filter chips; type
  chips; the `+2.7s` chip unclipped; Selectors and Network collapsed behind
  count badges; notes textarea; failed step with a crimson left edge; undo toast
  with its progress hairline. XPath is subordinate. Port its composition
  directly.
- **`flowsnap_popup_dark_flow`** matches Prompt 1: 360px, target row, one primary
  action, current-flow card with thumbnails, storage footer.
- Zero emoji anywhere.
- IBM Plex Sans + Mono throughout.
- The 360px popup width is honoured in all 16 popup frames.
- Every one of the six states that had no design at all — blocked tab, storage
  full, loading, export progress, destructive confirmation, real empty states —
  has a dark frame.

---

## Porting checklist

For each screen, in this order:

1. Take **composition** from the frame: layout, hierarchy, spacing rhythm,
   what is on screen and what is behind a disclosure.
2. Take **colour, type and shape** from `tokens.css`. Never copy a hex from the
   export.
3. Swap Material Symbols for Lucide.
4. Check the frame is not in the quarantine table above.
5. If the screen is one of the seven false-light ones, build light from tokens
   and check it against a real light frame for rhythm.
6. Verify against [`../DESIGN-BRIEF.md`](../DESIGN-BRIEF.md) §5.
