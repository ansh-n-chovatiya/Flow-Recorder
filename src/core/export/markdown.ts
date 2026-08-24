/**
 * Markdown export — the comprehension artifact an AI actually reads.
 *
 * Everything here is in service of staying token-lean: brittle full-path CSS
 * selectors are omitted (they live in flow.json for replay), bodies are
 * schema-compacted, and console output is filtered to errors and warnings.
 */

import { isStableSelector } from '../selector/index.js';
import { compactBody } from '../schema/index.js';
import { flowHost, urlPath } from '../flow/index.js';
import {
  formatSource,
  referencedComponentIds,
  stepEnclosing,
  stepOwner,
} from '../react/attribution.js';
import { CAPPED_ID } from '../react/table.js';
import type { ComponentSource, ExportOptions, FlowReact, Step } from '../../shared/types.js';

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

/*
 * How much page-derived text each slot is worth.
 *
 * Local rather than in `shared/constants`: nothing outside this renderer has an
 * opinion about how long a response body may be in a *document*, and the JSON
 * export deliberately keeps the full one.
 */
const MAX_REQUEST_BODY = 150;
const MAX_RESPONSE_BODY = 800;
const MAX_CONSOLE_MESSAGE = 200;
const MAX_CONSOLE_ENTRIES = 5;

/**
 * Cut to `limit`, and say so.
 *
 * Silent truncation is worse than no truncation: a 900-character JSON body cut
 * to 150 ends mid-object and reads as a complete one, so a reader concludes the
 * cart held two items when it held nine. `compactBody` already stamps
 * `[schema — 12.4KB raw]` for exactly this reason; these cuts then shortened its
 * output again without a word.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (+${text.length - limit} chars truncated)`;
}

/** Collapse every run of whitespace, so page text cannot span lines. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The longest run of backticks in `text`, or 0. */
function backtickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * A fence long enough that `content` cannot escape it.
 *
 * Response bodies are arbitrary page text and routinely carry their own ``` — a
 * code sample inside an error message, a chat API echoing a snippet. Pasted into
 * a three-backtick block that run closes it and opens an unterminated one, and
 * everything after it (this step's console errors, every later step, the whole
 * React components table) renders as literal text inside it. CommonMark closes a
 * fence only on a run at least as long, so the fence grows past the content's
 * longest run.
 */
function fenceFor(content: string): string {
  return '`'.repeat(Math.max(3, backtickRun(content) + 1));
}

/**
 * One line of page-derived text as an inline code span.
 *
 * Page text reaches the document verbatim — a console `error` whose message
 * contains `### 100. Clicked "Confirm delete"` used to render as a step heading
 * for an action nobody performed, and an ordinary multi-line stack trace broke
 * the document's structure without anyone trying. Flattened so it cannot open a
 * new block, fenced past its own backticks so it cannot leave the span.
 */
function inlineCode(text: string): string {
  const flat = flatten(text);
  const ticks = '`'.repeat(backtickRun(flat) + 1);
  // CommonMark strips one space from each side of a span, so padding is what
  // lets the content itself start or end with a backtick.
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

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

/**
 * Host of the first URL we can parse, shown once in the header, and the compact
 * pathname used for page-change markers.
 *
 * Both live in `core/flow` now that the viewer's library and the component table
 * also need them; re-exported here because this is where they have always been
 * imported from.
 */
export { flowHost, urlPath };

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
  components: Record<string, ComponentSource>,
): string {
  /*
   * `action` is page text: `accessibleName()` is `innerText.trim().slice(0,80)`,
   * and innerText keeps its internal newlines. A plan card reading "Pro plan"
   * over "$20/mo" used to produce `### 1. Clicked "Pro plan` and leave `$20/mo"`
   * behind as a stray paragraph — no attacker required.
   */
  lines.push(`### ${n}. ${flatten(step.action ?? '') || step.type}`);

  const path = urlPath(step.url);
  if (path && path !== prevPath) lines.push(`📍 ${path}`);

  if (step.element && isStableSelector(step.element.cssSelector)) {
    lines.push(`\`${step.element.cssSelector}\``);
  }

  /*
   * The component *name* only. Its path is in the table at the end of the
   * document, so a flow that clicks one button forty times pays for that path
   * once — the same rule that keeps full CSS selectors out of here.
   */
  const owner = stepOwner(step, components);
  if (owner) {
    // The enclosing feature component is named alongside it, because on an app
    // with a shared UI kit `⚛ Button` on its own is true and useless.
    const within = stepEnclosing(step, components);
    lines.push(
      within ? `⚛ ${owner.component.name} · in ${within.component.name}` : `⚛ ${owner.component.name}`,
    );
  }

  /*
   * Typed text, quoted as code rather than in bare quotation marks. A textarea
   * holding `### 99. Clicked "Delete account"` forged a step that way; a value
   * with a newline in it spilled the rest into the document as prose.
   */
  if (step.value) {
    if (/\n/.test(step.value)) {
      // A multi-line value is worth keeping whole — a pasted address, a commit
      // message — so it gets a block rather than being squashed onto one line.
      const fence = fenceFor(step.value);
      lines.push('↳ value:');
      lines.push(fence);
      lines.push(step.value);
      lines.push(fence);
    } else {
      lines.push(`↳ value: ${inlineCode(step.value)}`);
    }
  }

  if (step.notes?.trim()) {
    lines.push(`> ${step.notes.trim().replace(/\n/g, '\n> ')}`);
    lines.push('');
  }

  /*
   * The alt text carries the provenance because the image itself cannot. A
   * model reading this treats a screenshot as evidence of what the page looked
   * like; for an imported one that is the user's account, not the recorder's.
   */
  if (image) {
    lines.push(`![${step.screenshotImported ? `${n} — added by hand` : n}](${image})`);
  }

  if (step.networkCalls?.length && opts.network !== false) {
    lines.push('');
    for (const call of step.networkCalls) {
      lines.push(
        `\`${call.method || 'GET'}\` ${urlPath(call.url)} → ${call.status ?? 'err'} (${call.durationMs || 0}ms)`,
      );
      if (call.requestBody) {
        const body = truncate(
          flatten(
            compactBody(call.requestBody, {
              truncated: call.requestBodyTruncated,
              bytes: call.requestBodyBytes,
            }) ?? '',
          ),
          MAX_REQUEST_BODY,
        );
        lines.push(`  ↳ req: ${inlineCode(body)}`);
      }
      if (call.responseBody) {
        // Truncated before the block is built, not after: the old code indented
        // every line first and then sliced, so a multi-line body lost two
        // characters of its own content per line to the indent. The indent is
        // gone as well — it is what let an interior ``` line up as a closer.
        const body = truncate(
          compactBody(call.responseBody, {
            truncated: call.responseBodyTruncated,
            bytes: call.responseBodyBytes,
          }) ?? '',
          MAX_RESPONSE_BODY,
        );
        const fence = fenceFor(body);
        lines.push('  ↳ res:');
        lines.push(fence);
        lines.push(body);
        lines.push(fence);
      }
    }
  }

  // Console: only errors and warnings. `log`/`info` are noise for an AI.
  if (step.consoleLogs?.length && opts.logs !== false) {
    const all = step.consoleLogs.filter((log) => log.level === 'error' || log.level === 'warn');
    const notable = all.slice(0, MAX_CONSOLE_ENTRIES);
    if (notable.length) {
      lines.push('');
      for (const log of notable) {
        const text = truncate(flatten(log.args.join(' ')), MAX_CONSOLE_MESSAGE);
        lines.push(`⚠ \`[${log.level}]\` ${inlineCode(text)}`);
      }
      // Six errors on one step reading as five is a different story about the
      // page than six is, so the cap says what it swallowed.
      if (all.length > notable.length) lines.push(`⚠ … +${all.length - notable.length} more`);
    }
  }

  lines.push('');
  return path;
}

/**
 * The one place a component's source is written down.
 *
 * Every row states its own confidence, so the document cannot claim a path in
 * one place and hedge about it in another. A component with nowhere to point
 * still gets a row: its name appeared beside a step, and whoever looks it up
 * deserves the reason rather than a gap.
 */
function appendComponents(lines: string[], react: FlowReact, steps: Step[]): void {
  const rows = referencedComponentIds(steps)
    .map((id) => react.components[id])
    .filter((component): component is ComponentSource => Boolean(component))
    .map((c) => `| ${c.name} | ${formatSource(c) ?? '—'} | ${c.detail ?? ''} |`);

  /*
   * The cap is a fact about the recording, not about any one row.
   *
   * `pruneComponents` keeps the marker whatever happens, so a flow that exceeded
   * `MAX_COMPONENTS_PER_FLOW` and then had its early steps deleted arrives here
   * with the marker and nothing else. Returning on the empty table first threw
   * the note away with it, and the document then claimed nothing was left out.
   */
  const capped = react.components[CAPPED_ID];
  const note = capped?.detail;

  if (rows.length === 0) {
    if (note) {
      lines.push(`> ${note}`);
      lines.push('');
    }
    return;
  }

  lines.push('## React components');
  lines.push('');
  lines.push('| Component | Source | Notes |');
  lines.push('| --- | --- | --- |');
  lines.push(...rows);
  lines.push('');

  if (note) {
    lines.push(`> ${note}`);
    lines.push('');
  }
}

export interface MarkdownOptions extends Omit<Partial<ExportOptions>, 'images' | 'react'> {
  title?: string;
  /** `true`/`undefined` inlines base64; `false` omits; a strategy is explicit. */
  images?: ImageStrategy | boolean;
  /**
   * The flow's component table, when it was recorded on a React page.
   *
   * Stands in for the `react` switch the other parts have, exactly as it does in
   * `exportToJSON`: no table means no `⚛` line and no components section, since
   * the per-step ids are unreadable without it. The caller decides; this renders.
   */
  react?: FlowReact;
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
  /*
   * "Recorded" is the capture time the steps carry, not the moment of export.
   * Reading it off `new Date()` dated a flow captured on 1 August to the 24th,
   * which is the one date a reader cannot check against anything else in the
   * document. The export time is still worth having — it says how stale the
   * screenshots are — so it is kept under its own name, as `flow.json` does.
   */
  const recordedAt = list[0]?.timestamp;
  lines.push(
    [
      recordedAt ? `Recorded ${new Date(recordedAt).toLocaleString()}` : null,
      `Exported ${new Date().toLocaleString()}`,
      `${list.length} steps`,
      host || null,
    ]
      .filter(Boolean)
      .join(' · '),
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
  const components = options.react?.components ?? {};
  list.forEach((step, i) => {
    const image = imageRef(step, i, strategy);
    prevPath = appendStep(lines, step, i + 1, prevPath, image, opts, components);
  });

  if (options.react) appendComponents(lines, options.react, list);

  return lines.join('\n');
}
