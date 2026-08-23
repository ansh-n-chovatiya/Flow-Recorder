/** Operations on a flow's step list. Pure — no storage, no Chrome APIs. */

import type { ConsoleLevel, NetworkCall, Step, StepType } from '../../shared/types.js';

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

/** Pathname (+ search) of a URL, for compact page-change markers. */
export function urlPath(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Host of the first URL we can parse. One unparseable URL must not blank it. */
export function flowHost(steps: Step[]): string {
  for (const step of steps) {
    if (!step.url) continue;
    try {
      return new URL(step.url).host;
    } catch {
      // Keep looking.
    }
  }
  return '';
}

/**
 * A step wearing a screenshot the user supplied instead of one we captured.
 *
 * Three fields move together, which is why this is a function rather than a
 * spread at the call site:
 *
 *   - `screenshotOriginal` goes. It is the un-annotated base the image editor
 *     draws from, and leaving the old one behind means opening the annotator on
 *     a replaced step silently reverts to the picture that was replaced.
 *   - `highlightBox` goes. It is in the capture's coordinate space, so against
 *     a different image it marks an arbitrary rectangle.
 *   - `screenshotImported` is set, because a screenshot is read everywhere as
 *     evidence of what the page looked like, and for this one that is a claim
 *     nobody checked.
 *
 * Pure — see tests/screenshot-import.test.ts.
 */
export function withImportedScreenshot(step: Step, dataUrl: string): Step {
  const next: Step = { ...step, screenshot: dataUrl, screenshotImported: true };
  delete next.screenshotOriginal;
  next.highlightBox = null;
  return next;
}

// ── Reading failure out of a step ────────────────────────────────────────────

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

/**
 * Which band an HTTP status falls in. A `null` status is a request that never
 * got a response at all, which is a failure of the same weight as a 5xx and is
 * reported as one — the alternative is a call that looks fine because it has no
 * number to colour.
 */
export function statusClass(status: number | null): StatusClass {
  if (status == null || status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/** The most severe status among a step's network calls, or `null` if it made none. */
export function worstStatus(calls: NetworkCall[] | undefined): StatusClass | null {
  const order: StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];
  let worst: StatusClass | null = null;

  for (const call of calls ?? []) {
    const band = statusClass(call.status);
    if (worst === null || order.indexOf(band) > order.indexOf(worst)) worst = band;
  }

  return worst;
}

const LEVEL_SEVERITY: Record<ConsoleLevel, number> = {
  debug: 0,
  log: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** The most severe console level a step captured, or `null` if it captured none. */
export function worstLevel(logs: { level: ConsoleLevel }[] | undefined): ConsoleLevel | null {
  let worst: ConsoleLevel | null = null;
  for (const log of logs ?? []) {
    if (worst === null || LEVEL_SEVERITY[log.level] > LEVEL_SEVERITY[worst]) worst = log.level;
  }
  return worst;
}

/**
 * Did something go wrong during this step?
 *
 * This is the single definition of "failed", and the rail's red tick, the card's
 * crimson edge, the Errors filter and the library's error count all read it —
 * so a step cannot be a failure in one place and fine in another.
 */
export function stepFailed(step: Step): boolean {
  const status = worstStatus(step.networkCalls);
  if (status === '4xx' || status === '5xx') return true;
  return worstLevel(step.consoleLogs) === 'error';
}

/** How many steps of each type, for the library row's chips. */
export function countByType(steps: Step[]): Partial<Record<StepType, number>> {
  const counts: Partial<Record<StepType, number>> = {};
  for (const step of steps) counts[step.type] = (counts[step.type] ?? 0) + 1;
  return counts;
}

/** How many steps carry a failure. */
export function countFailures(steps: Step[]): number {
  return steps.reduce((total, step) => total + (stepFailed(step) ? 1 : 0), 0);
}
