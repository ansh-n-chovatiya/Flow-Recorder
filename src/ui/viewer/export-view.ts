/**
 * What the export dialog should show, derived from the flow and the choices.
 *
 * Structural decision B: three toolbar buttons that were the same export in
 * three file formats, three permanently-visible include checkboxes and a bare
 * filename prompt collapse into one dialog. The thing that makes the dialog
 * worth having rather than a shorter menu is the size estimate — the reason
 * someone picked ZIP over Markdown was previously guesswork.
 *
 * Pure — see tests/export-view.test.ts.
 */

import { defaultFilename, sanitizeFilename } from '../../core/flow/index.js';
import { EXTENSION, FORMAT_NAME, type ExportFormat } from '../../features/export/formats.js';
import type { ExportOptions, Step } from '../../shared/types.js';
import type { IconName } from '../icons.js';

export type { ExportFormat };

export interface ExportInput {
  steps: Step[];
  format: ExportFormat;
  options: ExportOptions;
  /** What the user has typed, before sanitising. */
  filename: string;
  /** True while the export is being built. */
  busy: boolean;
  /** Which step is being packaged, for the progress caption. */
  progress: { done: number; total: number } | null;
}

export interface FormatCard {
  id: ExportFormat;
  name: string;
  icon: IconName;
  description: string;
  bytes: number;
  selected: boolean;
  recommended: boolean;
}

export interface IncludeRow {
  id: keyof ExportOptions;
  label: string;
  checked: boolean;
  bytes: number;
  /**
   * Set when the chosen format ignores this content entirely, with the reason.
   * The alternative is a checkbox that changes nothing and a total that does not
   * move — which is how a user learns to distrust the numbers.
   */
  ignored: string | null;
}

export interface ExportView {
  formats: FormatCard[];
  includes: IncludeRow[];
  total: number;
  extension: string;
  /** Sanitised — what the file will actually be called. */
  filename: string;
  /** Bodies are not redacted, and this is the moment that matters. */
  warnBodies: boolean;
  canExport: boolean;
  busy: boolean;
  /** `Compressing screenshot 12 of 18`, or `null` when nothing is running. */
  caption: string | null;
}

/**
 * Bytes behind a base64 payload.
 *
 * A data URL is `data:image/jpeg;base64,` plus four characters per three bytes,
 * so the decoded size — which is what a ZIP entry costs — is three quarters of
 * the tail. Markdown embeds the data URL as text and pays the full length.
 */
function decodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;

  const payload = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

export interface Parts {
  /** The step text itself: actions, URLs, selectors, notes. */
  base: number;
  /** Screenshots, as they cost in a ZIP. */
  screenshots: number;
  /** Screenshots, as they cost embedded in Markdown. */
  screenshotsInline: number;
  network: number;
  logs: number;
}

/**
 * What each part of the flow weighs.
 *
 * Measured off the real payload rather than guessed from a per-step constant,
 * because the whole point of the number is to explain why one flow is 400 KB and
 * the next is 8 MB. It is still an estimate: the exporters compact bodies and
 * ZIP deflates the text, so the figure shown is an upper bound on everything
 * except the images, which are already compressed and pass through as they are.
 */
export function measure(steps: Step[]): Parts {
  let base = 0;
  let screenshots = 0;
  let screenshotsInline = 0;
  let network = 0;
  let logs = 0;

  for (const step of steps) {
    const { screenshot, screenshotOriginal, networkCalls, consoleLogs, ...rest } = step;
    void screenshotOriginal;

    base += JSON.stringify(rest).length;

    if (screenshot) {
      screenshots += decodedBytes(screenshot);
      screenshotsInline += screenshot.length;
    }
    if (networkCalls?.length) network += JSON.stringify(networkCalls).length;
    if (consoleLogs?.length) logs += JSON.stringify(consoleLogs).length;
  }

  return { base, screenshots, screenshotsInline, network, logs };
}

/**
 * Which parts a format actually writes.
 *
 * JSON never carries image data — `exportToJSON` writes a placeholder unless the
 * ZIP hands it filenames — so the Screenshots checkbox genuinely does nothing
 * there, and the dialog says so rather than pretending.
 */
function bytesFor(parts: Parts, format: ExportFormat, options: ExportOptions): number {
  const network = options.network ? parts.network : 0;
  const logs = options.logs ? parts.logs : 0;

  switch (format) {
    case 'zip':
      // Markdown and JSON both go in the archive, so the text is counted twice.
      return parts.base * 2 + network + logs + (options.images ? parts.screenshots : 0);
    case 'markdown':
      return parts.base + network + logs + (options.images ? parts.screenshotsInline : 0);
    case 'json':
      return parts.base + network + logs;
  }
}

const DESCRIPTION: Record<ExportFormat, string> = {
  zip: 'Markdown, JSON and screenshot files. Best for Claude — attach the folder.',
  markdown: 'One file, screenshots embedded. Readable anywhere.',
  json: 'Full selectors and timings. For replay and tooling.',
};

const FORMAT_ICON: Record<ExportFormat, IconName> = {
  zip: 'file-archive',
  markdown: 'file-text',
  json: 'braces',
};

/** Shared with the send dialog, so one part is never named two things. */
export const INCLUDE_LABEL: Record<keyof ExportOptions, string> = {
  images: 'Screenshots',
  network: 'Network calls',
  logs: 'Console logs',
};

export function deriveExportView(input: ExportInput): ExportView {
  const { steps, format, options, busy, progress } = input;
  const parts = measure(steps);

  const formats: FormatCard[] = (['zip', 'markdown', 'json'] as const).map((id) => ({
    id,
    name: FORMAT_NAME[id],
    icon: FORMAT_ICON[id],
    description: DESCRIPTION[id],
    bytes: bytesFor(parts, id, options),
    selected: id === format,
    recommended: id === 'zip',
  }));

  const includes: IncludeRow[] = [
    {
      id: 'images',
      label: INCLUDE_LABEL.images,
      checked: options.images,
      bytes: format === 'markdown' ? parts.screenshotsInline : parts.screenshots,
      ignored:
        format === 'json' ? 'JSON records the step data; images ship with the ZIP.' : null,
    },
    {
      id: 'network',
      label: INCLUDE_LABEL.network,
      checked: options.network,
      bytes: parts.network,
      ignored: null,
    },
    {
      id: 'logs',
      label: INCLUDE_LABEL.logs,
      checked: options.logs,
      bytes: parts.logs,
      ignored: null,
    },
  ];

  const name = sanitizeFilename(input.filename.trim() || defaultFilename());

  return {
    formats,
    includes,
    total: bytesFor(parts, format, options),
    extension: EXTENSION[format],
    filename: name,
    // Headers are redacted at capture; bodies are not. Saying so belongs at the
    // moment the bodies are about to leave the machine, not in a settings page
    // nobody opened.
    warnBodies: options.network && parts.network > 0,
    canExport: steps.length > 0 && !busy,
    busy,
    caption:
      progress === null
        ? null
        : `Packaging screenshot ${progress.done} of ${progress.total}`,
  };
}
