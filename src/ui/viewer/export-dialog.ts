/**
 * One export dialog — structural decision B.
 *
 * It replaces three toolbar buttons that were the same export in three file
 * formats, three include checkboxes that sat on screen permanently although they
 * only mattered here, and a bare filename prompt. The size estimates are the
 * reason it is a dialog rather than a shorter menu: choosing ZIP over Markdown
 * used to be a guess.
 */

import { exportFlow, suggestFilename } from '../../features/export/download.js';
import { getLocal, setLocal } from '../../chrome/storage.js';
import { flowHost } from '../../core/flow/index.js';
import type { ExportOptions, FlowReact, Step } from '../../shared/types.js';
import { formatBytes } from '../format.js';
import { hydrateIcons, setIcon } from '../icons.js';
import { showToast } from '../toast.js';
import { clone, el, find, show } from './dom.js';
import {
  deriveExportView,
  type ExportFormat,
  type FormatCard,
  type IncludeRow,
} from './export-view.js';

const dom = {
  dialog: el<HTMLDialogElement>('export-dialog'),
  subtitle: el('export-subtitle'),
  close: el<HTMLButtonElement>('export-close'),
  formats: el('export-formats'),
  includes: el('export-includes'),
  warning: el('export-warning'),
  filename: el<HTMLInputElement>('export-filename'),
  extension: el('export-ext'),
  progress: el('export-progress'),
  progressFill: el('export-progress-fill'),
  caption: el('export-caption'),
  total: el('export-total'),
  cancel: el<HTMLButtonElement>('export-cancel'),
  run: el<HTMLButtonElement>('export-run'),
  runIcon: el('export-run-icon'),
  runLabel: el('export-run-label'),
};

interface Session {
  steps: Step[];
  title: string;
  format: ExportFormat;
  options: ExportOptions;
  filename: string;
  busy: boolean;
  progress: { done: number; total: number } | null;
  /** The component table, so the Markdown and JSON in the archive carry it. */
  react: FlowReact | undefined;
}

let session: Session | null = null;

/** The include choices persist; the format and filename are per-export. */
const DEFAULT_OPTIONS: ExportOptions = { images: true, network: true, logs: true };

function paint(): void {
  if (!session) return;

  const view = deriveExportView({
    steps: session.steps,
    format: session.format,
    options: session.options,
    filename: session.filename,
    busy: session.busy,
    progress: session.progress,
  });

  const host = flowHost(session.steps);
  dom.subtitle.textContent = [
    `${session.steps.length} ${session.steps.length === 1 ? 'step' : 'steps'}`,
    host,
  ]
    .filter(Boolean)
    .join(' · ');

  dom.formats.replaceChildren(...view.formats.map(buildFormat));
  dom.includes.replaceChildren(...view.includes.map(buildInclude));

  show(dom.warning, view.warnBodies);

  dom.extension.textContent = view.extension;
  dom.total.textContent = `Total ${formatBytes(view.total)}`;

  dom.run.disabled = !view.canExport;
  dom.runLabel.textContent = view.busy ? 'Packaging…' : 'Export';
  setIcon(dom.runIcon, view.busy ? 'loader-circle' : 'download');
  dom.cancel.disabled = view.busy;

  show(dom.progress, view.caption !== null);
  if (view.caption && session.progress) {
    dom.caption.textContent = view.caption;
    const ratio = session.progress.total === 0 ? 1 : session.progress.done / session.progress.total;
    dom.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  }
}

function buildFormat(card: FormatCard): HTMLElement {
  const node = clone('tpl-format');
  node.setAttribute('aria-checked', String(card.selected));

  find(node, '.format__icon').dataset.icon = card.icon;
  find(node, '.format__name').textContent = card.name;
  find(node, '.format__description').textContent = card.description;
  find(node, '.format__size').textContent = formatBytes(card.bytes);

  const badge = find(node, '.format__badge');
  if (card.recommended) show(badge, true);
  else badge.remove();

  node.addEventListener('click', () => {
    if (!session || session.busy) return;
    session.format = card.id;
    paint();
  });

  hydrateIcons(node);
  return node;
}

function buildInclude(row: IncludeRow): HTMLElement {
  const node = clone<HTMLLabelElement>('tpl-include');
  node.dataset.ignored = String(row.ignored !== null);

  const input = find<HTMLInputElement>(node, '.include__input');
  input.checked = row.checked;
  input.disabled = row.ignored !== null;

  find(node, '.include__label').textContent = row.label;
  find(node, '.include__note').textContent = row.ignored ?? '';
  find(node, '.include__size').textContent = row.ignored ? '—' : formatBytes(row.bytes);

  input.addEventListener('change', () => {
    if (!session) return;
    session.options = { ...session.options, [row.id]: input.checked };
    void setLocal({ exportOptions: session.options });
    paint();
  });

  return node;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

dom.close.addEventListener('click', () => dom.dialog.close());
dom.cancel.addEventListener('click', () => dom.dialog.close());

dom.filename.addEventListener('input', () => {
  if (!session) return;
  session.filename = dom.filename.value;
});

dom.run.addEventListener('click', () => void run());

/**
 * Escape must not cancel a running export.
 *
 * The dialog is the only thing reporting progress, and the download itself
 * cannot be called back once the archive is being assembled — so closing early
 * would leave a file arriving with nothing on screen to explain it.
 */
dom.dialog.addEventListener('cancel', (event) => {
  if (session?.busy) event.preventDefault();
});

async function run(): Promise<void> {
  if (!session || session.busy) return;

  const view = deriveExportView({ ...session });
  session.busy = true;
  session.progress = { done: 0, total: 0 };
  paint();

  const written = await exportFlow({
    steps: session.steps,
    title: session.title,
    format: session.format,
    options: session.options,
    filename: view.filename,
    react: session.react,
    onProgress: (done, total) => {
      if (!session) return;
      session.progress = { done, total };
      paint();
    },
  });

  session.busy = false;
  session.progress = null;
  paint();

  if (!written.ok) {
    showToast({ message: written.error.message, tone: 'danger' });
    return;
  }

  dom.dialog.close();
  showToast({ message: `Saved ${written.value}.`, tone: 'success' });
}

export interface OpenExportOptions {
  steps: Step[];
  title: string;
  /** The flow's component table, absent when the page was not React. */
  react?: FlowReact | null;
}

export function openExport({ steps, title, react }: OpenExportOptions): void {
  if (steps.length === 0) {
    showToast({ message: 'There is nothing to export yet.' });
    return;
  }

  void (async () => {
    const stored = await getLocal('exportOptions');
    const options =
      stored.ok && stored.value.exportOptions
        ? { ...DEFAULT_OPTIONS, ...stored.value.exportOptions }
        : DEFAULT_OPTIONS;

    session = {
      steps,
      title,
      react: react ?? undefined,
      format: 'zip',
      options,
      filename: suggestFilename(steps),
      busy: false,
      progress: null,
    };

    dom.filename.value = session.filename;
    paint();
    dom.dialog.showModal();
  })();
}
