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
outside `tokens.css`. It runs in `verify` and in CI. Two files are exempt and
both say why in the script — `public/content.css`, which is injected into
somebody else's document where `tokens.css` does not exist, and `src/viewer.html`,
which has not been rebuilt yet. **That second entry is the list of remaining
work; delete from it, never add to it.**

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
