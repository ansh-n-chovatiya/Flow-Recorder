/**
 * Markdown export — the comprehension artifact an AI actually reads.
 *
 * Everything here is in service of staying token-lean: brittle full-path CSS
 * selectors are omitted (they live in flow.json for replay), bodies are
 * schema-compacted, and console output is filtered to errors and warnings.
 */

import { isStableSelector } from '../selector/index.js';
import { compactBody } from '../schema/index.js';
import { flowHost } from '../flow/index.js';
import type { ExportOptions, Step } from '../../shared/types.js';

/**
 * How a step's screenshot is referenced.
 * - `inline`: the base64 data URL, for a single self-contained .md file.
 * - `file`: a relative path into the ZIP's images/ folder. Vision models read
 *   image files; they cannot read base64 pasted as text.
 * - `none`: images excluded.
 */
export type ImageStrategy =
  | { kind: 'inline' }
  | { kind: 'file'; names: (string | null)[] }
  | { kind: 'none' };

function imageRef(step: Step, index: number, strategy: ImageStrategy): string | null {
  switch (strategy.kind) {
    case 'inline':
      return step.screenshot ?? null;
    case 'file':
      return strategy.names[index] ?? null;
    case 'none':
      return null;
  }
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

/**
 * Host of the first URL we can parse, shown once in the header.
 *
 * It lives in `core/flow` now that the viewer's library also needs it; re-exported
 * here because this is where it has always been imported from.
 */
export { flowHost };

/**
 * Append one step block. `prevPath` is the previous step's path; the returned
 * path lets the caller track transitions so 📍 only marks real page changes.
 */
function appendStep(
  lines: string[],
  step: Step,
  n: number,
  prevPath: string,
  image: string | null,
  opts: Partial<ExportOptions>,
): string {
  lines.push(`### ${n}. ${step.action || step.type}`);

  const path = urlPath(step.url);
  if (path && path !== prevPath) lines.push(`📍 ${path}`);

  if (step.element && isStableSelector(step.element.cssSelector)) {
    lines.push(`\`${step.element.cssSelector}\``);
  }

  if (step.value) lines.push(`↳ value: "${step.value}"`);

  if (step.notes?.trim()) {
    lines.push(`> ${step.notes.trim().replace(/\n/g, '\n> ')}`);
    lines.push('');
  }

  if (image) lines.push(`![${n}](${image})`);

  if (step.networkCalls?.length && opts.network !== false) {
    lines.push('');
    for (const call of step.networkCalls) {
      lines.push(
        `\`${call.method || 'GET'}\` ${urlPath(call.url)} → ${call.status ?? 'err'} (${call.durationMs || 0}ms)`,
      );
      if (call.requestBody) {
        const body = (compactBody(call.requestBody) ?? '').replace(/\n/g, ' ').slice(0, 150);
        lines.push(`  ↳ req: \`${body}\``);
      }
      if (call.responseBody) {
        lines.push('  ↳ res:');
        lines.push('  ```');
        lines.push(`  ${(compactBody(call.responseBody) ?? '').replace(/\n/g, '\n  ').slice(0, 800)}`);
        lines.push('  ```');
      }
    }
  }

  // Console: only errors and warnings. `log`/`info` are noise for an AI.
  if (step.consoleLogs?.length && opts.logs !== false) {
    const notable = step.consoleLogs
      .filter((log) => log.level === 'error' || log.level === 'warn')
      .slice(0, 5);
    if (notable.length) {
      lines.push('');
      for (const log of notable) {
        lines.push(`⚠ \`[${log.level}]\` ${log.args.join(' ').slice(0, 200)}`);
      }
    }
  }

  lines.push('');
  return path;
}

export interface MarkdownOptions extends Omit<Partial<ExportOptions>, 'images'> {
  title?: string;
  /** `true`/`undefined` inlines base64; `false` omits; a strategy is explicit. */
  images?: ImageStrategy | boolean;
}

/** Render a flow as Markdown. */
export function exportToMarkdown(steps: Step[], options: MarkdownOptions = {}): string {
  const list = steps;
  const title = options.title ?? 'Flow Recording';

  const strategy: ImageStrategy =
    options.images === false
      ? { kind: 'none' }
      : options.images === true || options.images === undefined
        ? { kind: 'inline' }
        : options.images;

  const lines: string[] = [];
  const host = flowHost(list);

  lines.push(`# ${title}`);
  lines.push(
    `Recorded ${new Date().toLocaleString()} · ${list.length} steps${host ? ` · ${host}` : ''}`,
  );
  lines.push('');
  lines.push(
    strategy.kind === 'file'
      ? '> Each step is one user action; 📍 marks a page change. Screenshots are the ' +
          '`images/step-NN.*` files — attach them to Claude (vision reads image files, ' +
          'not base64 text). Full selectors/XPath for replay live in `flow.json`.'
      : '> A recorded UI flow. Each step is one user action; 📍 marks a page change.',
  );
  lines.push('');

  let prevPath = '';
  const opts: Partial<ExportOptions> = { network: options.network, logs: options.logs };
  list.forEach((step, i) => {
    prevPath = appendStep(lines, step, i + 1, prevPath, imageRef(step, i, strategy), opts);
  });

  return lines.join('\n');
}
