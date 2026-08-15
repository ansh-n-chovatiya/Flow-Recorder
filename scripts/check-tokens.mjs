/**
 * Enforce the design system's one hard rule: no colour outside tokens.css.
 *
 *   npm run lint:tokens
 *
 * A design system is only a system while nothing bypasses it. One `#2BB3A3`
 * pasted into a component is invisible in review, survives every test, and then
 * fails to change when the theme does — which is precisely how the build being
 * replaced ended up with a red that meant "record", "delete" and "failed" at
 * once.
 *
 * PENDING lists the files that predate the design system. They are exempt so the
 * rule can be enforced today rather than after the last screen is rebuilt; the
 * list is expected to reach empty, and shrinking it is the point.
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one file allowed to name a colour. */
const TOKENS = 'src/ui/styles/tokens.css';

/**
 * Injected into someone else's document, where tokens.css is not present and
 * `:root` belongs to the page. Its values are scoped to the indicator and
 * documented as copies; there is no way to import them.
 */
const SCOPED = ['public/content.css'];

/** Not rebuilt on the design system yet. Delete entries; never add them. */
const PENDING = ['src/viewer.html'];

/** Anything that names a colour directly. */
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|color-mix|oklch|lab)\(/gi;

/** The arguments of a function call starting at `open`, respecting nesting. */
function callArgs(text, open) {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }

  return text.slice(open + 1);
}

/**
 * `color-mix(in srgb, var(--record) 40%, transparent)` is a token derivation,
 * not a new colour. A call is allowed exactly when it is built from tokens; a
 * literal channel value anywhere is a colour that a theme cannot reach.
 */
function findings(source) {
  const found = [];

  source.split('\n').forEach((line, index) => {
    if (line.includes('token-check-ignore')) return;

    for (const match of line.matchAll(COLOUR)) {
      const text = match[0];

      if (text.endsWith('(')) {
        const args = callArgs(line, match.index + text.length - 1);
        if (args.includes('var(--')) continue;
      }

      found.push({ line: index + 1, text: text.replace(/\($/, '()'), source: line.trim() });
    }
  });

  return found;
}

const files = [
  ...globSync('src/**/*.css', { cwd: root }),
  ...globSync('src/**/*.html', { cwd: root }),
  ...globSync('public/*.css', { cwd: root }),
]
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file !== TOKENS && !SCOPED.includes(file) && !PENDING.includes(file))
  .sort();

let failed = 0;

for (const file of files) {
  const hits = findings(readFileSync(resolve(root, file), 'utf8'));
  for (const hit of hits) {
    console.error(`${file}:${hit.line}  ${hit.text} — use a token from ${TOKENS}`);
    console.error(`    ${hit.source}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} colour ${failed === 1 ? 'literal' : 'literals'} outside ${TOKENS}.`);
  process.exit(1);
}

const exempt = [...SCOPED, ...PENDING];
console.log(
  `tokens: ${files.length} files clean` +
    (exempt.length ? `, ${exempt.length} exempt (${exempt.join(', ')})` : ''),
);
