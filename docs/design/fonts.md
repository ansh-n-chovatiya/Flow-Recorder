# Vendored fonts

A Chrome extension cannot fetch a font from a CDN under its own CSP, so IBM Plex
ships in the repository, in [`../../public/fonts/`](../../public/fonts/). Those
five files are the entire type system; nothing else in `tokens.css` matters if
they are missing, because an unavailable family falls back to the system UI font
without warning.

This file lives in `docs/` rather than beside them because everything under
`public/` is copied verbatim into the packaged extension, and a build note is not
something to ship to users. `OFL.txt` is the exception — the licence has to
travel with the fonts.

## What is here

| File | Family | Weight |
|---|---|---|
| `ibm-plex-sans-latin-400.woff2` | IBM Plex Sans | 400 — body, metadata |
| `ibm-plex-sans-latin-500.woff2` | IBM Plex Sans | 500 — buttons, step titles, labels |
| `ibm-plex-sans-latin-600.woff2` | IBM Plex Sans | 600 — headings |
| `ibm-plex-mono-latin-400.woff2` | IBM Plex Mono | 400 — selectors, URLs, code |
| `ibm-plex-mono-latin-500.woff2` | IBM Plex Mono | 500 — chips, uppercase labels |

104 KB total. Only the weights `tokens.css` declares, and only the Latin subset —
see "Non-Latin text" below.

Italics are not vendored because the design system never uses them. Weight 550
does not exist in static IBM Plex Sans; `--weight-medium` is 500 for that reason.

## Provenance

Extracted from [Fontsource](https://fontsource.org) `@fontsource/ibm-plex-sans`
and `@fontsource/ibm-plex-mono`, both **5.3.0**, then renamed. The packages are
not a dependency — vendored bytes are more reproducible than a resolved version
range, and nothing in the build imports them.

```
08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7  ibm-plex-mono-latin-400.woff2
01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22  ibm-plex-mono-latin-500.woff2
3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e  ibm-plex-sans-latin-400.woff2
0717336fb31fcdcde4b8deb3675bb4a0f7f6d484864afcd6751ac29975962203  ibm-plex-sans-latin-500.woff2
8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f  ibm-plex-sans-latin-600.woff2
```

To refresh, install the two packages, copy the matching
`files/*-latin-<weight>-normal.woff2`, re-record the hashes above, and uninstall.

## Non-Latin text

FlowSnap renders text it did not write: page titles, element labels, typed
values, URLs. Those can be in any script, and the Latin subset covers none of
them. Every `@font-face` in [`../../src/ui/styles/fonts.css`](../../src/ui/styles/fonts.css)
therefore declares the subset's `unicode-range`, so a Cyrillic or CJK glyph falls
through to the next family in the stack instead of rendering as tofu. Dropping
that descriptor is the failure mode to watch for — it looks fine until someone
records a page that is not in English.

## Licence

IBM Plex is licensed under the SIL Open Font License 1.1 — see
[`../../public/fonts/OFL.txt`](../../public/fonts/OFL.txt), which must ship with
the fonts.
