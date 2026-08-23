# The shared core

`react-source-locator` and `Flow-Recorder` (FlowSnap) both need the same six
things: walk a React fiber, take a slice of a component's source, find that
slice in a bundle, read the bundle's source map, decide whether the result is
the user's code, and turn it into an editor link.

Those files exist twice, by copy. This document is why, which files pair with
which, and — the part that matters — **which differences between the copies are
deliberate and must not be back-ported.**

## Why a copy and not a package

Extracting a `react-source-core` package was planned, designed, and then
dropped. The reason is in the divergence table below: the two copies
deliberately disagree in four places, and every one of those would have to
become a parameter on the shared API.

The clearest case is the line base. Source maps are 0-based. The locator keeps
that all the way to `buildEditorUrl`, which adds one when it fills `{line1}`.
FlowSnap converts once at the source-map edge, so everything downstream of it
is already 1-based. Both are right. Shared, `lookupOriginal` and
`buildEditorUrl` would each need a required `base: 0 | 1`, and the failure mode
if a call site passes the wrong one is that the editor opens the file one line
off — silently, every time. Two files that are each unambiguously correct in
their own repo are safer than one file that is correct only if every caller
gets an argument right.

The structural costs pointed the same way: a third repository with its own
release cadence, version skew between the two extensions, and neither
extension able to `npm ci` from a fresh clone until the package is published.
Both extensions are meant to be cloned and built with nothing else present.

With two consumers and six files, a hand back-port is cheap — the three that
landed in the locator's 2.2.0 took under an hour. That is the trade being made:
a little duplication, in exchange for two repos that each stand alone.

## The pairs

| Concern | `react-source-locator` | `Flow-Recorder` |
| --- | --- | --- |
| Base64-VLQ decode | `src/core/vlq.ts` | `src/core/react/vlq.ts` |
| Source map parse + lookup | `src/core/sourcemap.ts` | `src/core/react/sourcemap.ts` |
| Needle build + bundle search | `src/core/bundle-search.ts` | `src/core/react/needle.ts`, `src/core/react/search.ts` |
| Component classification | `src/panel/classify.ts` | `src/core/react/classify.ts` |
| Editor templates + URL | `src/panel/settings.ts` | `src/core/react/editor.ts` |
| Fiber walk | `src/injected/fiber.ts` | `src/core/react/fiber.ts` |

`vlq.ts` and `normalizeSourcePath` are byte-identical as of the locator's
2.2.0. Everything else differs, on purpose.

## Do not back-port these

**Line base.** The locator is 0-based end to end. FlowSnap converts to 1-based
once, in `sourcemap.ts`, because a flow is read by an AI that pastes the number
into an editor. Consequently `buildEditorUrl` means opposite things by
`{line1}` in the two repos. Copying either version into the other opens every
file one line off, and nothing fails loudly.

**`force` on the fiber walk.** The locator resolves a lazy component on a pick
(`force = true`) — the user asked for it. FlowSnap never does: it is a passive
recorder, and starting a dynamic `import()` would mean the act of recording
changes what the page loads, so the flow stops describing the session it
claims to.

**`sourcesContent`.** The locator keeps it and renders a preview. FlowSnap
drops it deliberately: a flow is sent to an AI, and inlined original source is
both a token disaster and a way to leak code the user did not mean to send.

**Fetching and caching.** The locator's `sourcemap.ts` owns a fetch callback
and module-level caches. FlowSnap's is pure — its worker's resolver owns every
fetch, because that is also what owns the time and count budgets they have to
respect.

**Panel-only code.** `classify.ts` upstream carries filter chips, their labels,
`filterComponents` and `countByCategory`. FlowSnap classifies only to pick one
owner out of a chain and drops all of it.

## Keeping them level

Every ported file carries a provenance line naming where it came from and the
commit it was taken at:

```
Ported from react-source-locator `src/core/vlq.ts` @ 6eb7a30.
Back-ported from Flow-Recorder `src/core/react/needle.ts` @ 3dc9bef.
```

`npm run core:drift` reads those lines and asks the sibling checkout what has
landed on each path since. It needs the sibling cloned next to this repo, and
says so rather than failing when it is not:

```
npm run core:drift              # compare against ../<sibling>
npm run core:drift -- --fetch   # fetch the sibling first
npm run core:drift -- --sibling Flow-Recorder=/path/to/repo
```

Anything it flags is a commit to *look at*, not a commit to copy — check it
against the table above first. When you have reviewed it, bump the `@ sha` in
the header to what you looked at, whether or not you copied anything. A header
that still names an old commit means the review has not happened; that is the
only thing keeping this honest.
