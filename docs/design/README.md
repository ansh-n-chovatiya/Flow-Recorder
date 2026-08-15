# The design system, and the decisions behind it

`src/ui/styles/tokens.css` is the only authority on colour, type and shape. It is
authored from [`../DESIGN-BRIEF.md`](../DESIGN-BRIEF.md) §3.

The screens were composed in a Google Stitch export, which has since served its
purpose and been removed. Two rules survive it, because both were things the
export got wrong and the codebase must not:

**Never copy a colour from a mockup.** Stitch substituted its own Material 3
palette for the one the brief specified — the accent was demoted to a container
role, and `#E5484D`, the one colour the redesign exists to protect, appeared once
across 35 screens. `tokens.css` was written from the brief instead, and wins over
any mockup, always.

**The three reds are not interchangeable.** Structural decision **F** exists
because the shipped build used one red for "record", "delete" and "failed" at
once, so nothing about a red thing told you which it was. Recording UI takes
`--record`. Destructive confirmation takes `--danger`. Failure states take
`--log-error` / `--status-5xx`.

Icons are Lucide at 16px / 1.5px stroke, generated into
`src/ui/icons.generated.ts` by `npm run build:icons`. Markup names an icon
(`<span data-icon="circle-dot"></span>`) and never carries a path.

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

IBM Plex is vendored in `public/fonts/`; see [`fonts.md`](./fonts.md), in
particular the `unicode-range` descriptor, which is what keeps a Cyrillic or CJK
page title from rendering as tofu.

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

## Departures from the frames

Recorded here so they are choices rather than drift.

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
- **The annotation editor was built from the prompt text, not a frame.** Every
  frame in that family was branded *TraceCapture*. See the header comment on
  `src/ui/viewer/annotate.ts`.
- **The annotation palette is fixed values in `annotate-ops.ts`, not tokens.**
  That ink is baked into a JPEG that leaves the machine, so it must not change
  when the theme does. The values are taken from the system's data colours so the
  two still look like one product, and the swatch borders *are* tokens — which is
  what makes the white swatch visible on a white panel, as the audit complained
  it was not.

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
