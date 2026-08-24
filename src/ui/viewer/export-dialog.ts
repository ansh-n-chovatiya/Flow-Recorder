/**
 * One export dialog — structural decision B.
 *
 * It replaces three toolbar buttons that were the same export in three file
 * formats, the include checkboxes that sat on screen permanently although they
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
const DEFAULT_OPTIONS: ExportOptions = {
  images: true,
  network: true,
  logs: true,
  react: true,
};

function paint(): void {
  if (!session) return;

  const view = deriveExportView({
    steps: session.steps,
    format: session.format,
    options: session.options,
    react: session.react,
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
  // The X is the same door as Cancel and Escape, and it was the only one left
  // open: `dialog.close()` called from script fires no `cancel` event, so the
  // guard below never saw it and a second export could start over the first.
  dom.close.disabled = view.busy;

  show(dom.progress, view.caption !== null);
  if (view.caption && session.progress) {
    paintProgress(session.progress);
  }
}

/**
 * The two nodes a progress tick actually changes.
 *
 * The caption carries the counts, so it has to move with the bar — updating
 * only the fill would leave the text frozen at "1 of 200" for the whole
 * package. The wording is duplicated from `deriveExportView` rather than
 * derived, because deriving it is the measure this exists to avoid; the test
 * pins the two together.
 */
function paintProgress(progress: { done: number; total: number }): void {
  const ratio = progress.total === 0 ? 1 : progress.done / progress.total;
  dom.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  dom.caption.textContent = `Packaging screenshot ${progress.done} of ${progress.total}`;
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
  const note = find(node, '.include__note');
  note.textContent = row.ignored ?? '';
  // One line, truncated; the full reason a checkbox is disabled stays reachable.
  note.title = note.textContent;
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
  /*
   * The session this run belongs to, held locally for the whole of it.
   *
   * `openExport` replaces the module-level `session` outright, so a flow opened
   * while an archive is still being packaged makes every `session.` below refer
   * to the wrong flow: A's export would close B's dialog mid-package and toast
   * A's filename while B was still building. Every mutation after an await is
   * therefore against `active`, and skipped once it is no longer on screen.
   */
  const active = session;
  if (!active || active.busy) return;

  const view = deriveExportView({ ...active });
  active.busy = true;
  active.progress = { done: 0, total: 0 };
  paint();

  const written = await exportFlow({
    steps: active.steps,
    title: active.title,
    format: active.format,
    options: active.options,
    filename: view.filename,
    react: active.react,
    onProgress: (done, total) => {
      if (session !== active) return;
      active.progress = { done, total };
      // The bar only, not a repaint.
      //
      // `paint()` runs `deriveExportView`, which re-measures the flow — a
      // `JSON.stringify` of every step, every network call and every console
      // entry — and rebuilds all seven rows. Doing that once per packed
      // screenshot was hundreds of full measures of a multi-megabyte array
      // between the yields `buildZip` makes precisely so the bar can move, so
      // the work meant to keep the tab responsive was what froze it.
      paintProgress(active.progress);
    },
  });

  active.busy = false;
  active.progress = null;
  if (session !== active) return;
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
