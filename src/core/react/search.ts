/**
 * Finding a component's compiled position inside a bundle.
 *
 * Ported from react-source-locator `src/core/bundle-search.ts` @ 6eb7a30, with
 * two divergences:
 *
 *   1. **No resource listing and no fetching.** Upstream asks DevTools for the
 *      page's resources and loads them itself. FlowSnap has no DevTools page, so
 *      the script inventory is collected in the page (`features/react/inventory.ts`)
 *      and the bundle text is fetched by the worker. This module is handed text
 *      and searches it — which also makes it pure, and testable without a browser.
 *   2. **Needle building lives in `needle.ts`**, because it runs in the page on
 *      the click path while this runs in the worker minutes later.
 *
 * Pure — no DOM, no Chrome, no network.
 */

import { MAX_MATCHES_TRACKED } from '../../shared/constants.js';
import type { Needle } from './needle.js';

/** Converts a character offset into a 0-based line/column pair. */
export function offsetToLineColumn(
  content: string,
  offset: number,
): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;

  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, column: offset - lineStart };
}

/** Counts occurrences of `text`, stopping at `cap` so huge bundles stay cheap. */
export function countOccurrences(content: string, text: string, cap = MAX_MATCHES_TRACKED): number {
  if (text.length === 0) return 0;

  let count = 0;
  let from = 0;

  while (count < cap) {
    const at = content.indexOf(text, from);
    if (at === -1) break;
    count++;
    from = at + text.length;
  }

  return count;
}

export interface BundleHit {
  /** 0-based position of the function's start in the bundle text. */
  line: number;
  column: number;
  /** Distinct occurrences in this bundle, capped at `MAX_MATCHES_TRACKED`. */
  matchCount: number;
  /** The needle that hit, so later bundles can be checked for the same text. */
  needleText: string;
}

/**
 * Looks for one component in one bundle.
 *
 * The head needle is tried first: it is the most specific, and a hit on it puts
 * the position exactly at the function's start. The body needle is the fallback
 * for a bundler that renamed the function — its `bodyOffset` is subtracted so
 * the reported position is still the start rather than the middle.
 */
export function searchBundle(content: string, needle: Needle): BundleHit | null {
  const candidates: { text: string; offset: number }[] = [{ text: needle.head, offset: 0 }];
  if (needle.body !== undefined && needle.bodyOffset !== undefined) {
    candidates.push({ text: needle.body, offset: needle.bodyOffset });
  }

  for (const candidate of candidates) {
    const at = content.indexOf(candidate.text);
    if (at === -1) continue;

    const start = Math.max(0, at - candidate.offset);
    const { line, column } = offsetToLineColumn(content, start);

    return {
      line,
      column,
      matchCount: countOccurrences(content, candidate.text),
      needleText: candidate.text,
    };
  }

  return null;
}
