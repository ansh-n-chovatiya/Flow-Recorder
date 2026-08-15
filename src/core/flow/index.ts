/** Operations on a flow's step list. Pure — no storage, no Chrome APIs. */

import type { Step } from '../../shared/types.js';

/**
 * Re-derive `stepNumber` from position.
 *
 * The recorder stamps a number at capture time, so deleting a step used to leave
 * exports numbered 1, 2, 4. Numbering is a function of order, so it is derived
 * on the way out rather than stored and maintained.
 */
export function renumber(steps: Step[]): Step[] {
  return steps.map((step, i) => ({ ...step, stepNumber: i + 1 }));
}

/** Two-digit zero-padded string, for `step-01.jpg`. */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Strip characters that are illegal in filenames on any of the big three. */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, '')
      .trim()
      .replace(/^\.+|\.+$/g, '') || 'flowsnap-flow'
  );
}

/** Default export filename: `flowsnap-flow-2026-08-15`. */
export function defaultFilename(now = new Date()): string {
  return `flowsnap-flow-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Millisecond delta as `+1.2s` or `+1m 3s`. Empty string for negative deltas. */
export function formatDelta(ms: number): string {
  if (ms < 0) return '';
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `+${minutes}m ${seconds}s`;
}

/** The first URL in the flow, used as the MCP payload's `startUrl`. */
export function startUrl(steps: Step[]): string | undefined {
  return steps[0]?.url;
}
