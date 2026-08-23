/**
 * One dialog in front of "Send to Claude".
 *
 * The button used to POST the whole recording the moment it was pressed, which
 * is the same mistake the three export buttons made before decision B: the
 * choice existed, it was just made for you. This is the export dialog with the
 * parts that do not apply to a wire removed — no formats, no filename — and the
 * sizes restated in the currency this destination is spent in.
 *
 * It shares `tpl-include` and the `.includes` rules with the export dialog on
 * purpose. Two dialogs that ask the same question should not look like two
 * questions.
 */

import { sendFlow, type SendResult } from '../../features/mcp/send.js';
import { getLocal, setLocal } from '../../chrome/storage.js';
import { flowHost } from '../../core/flow/index.js';
import type { ExportOptions, FlowReact, Step } from '../../shared/types.js';
import { formatBytes, formatTokens } from '../format.js';
import { setIcon } from '../icons.js';
import { showToast } from '../toast.js';
import { clone, el, find, show } from './dom.js';
import type { IncludeRow } from './export-view.js';
import { deriveSendView, SEND_DEFAULTS } from './send-view.js';

const dom = {
  dialog: el<HTMLDialogElement>('send-dialog'),
  subtitle: el('send-subtitle'),
  close: el<HTMLButtonElement>('send-close'),
  includes: el('send-includes'),
  note: el('send-note'),
  warning: el('send-warning'),
  context: el('send-context'),
  total: el('send-total'),
  cancel: el<HTMLButtonElement>('send-cancel'),
  run: el<HTMLButtonElement>('send-run'),
  runIcon: el('send-run-icon'),
  runLabel: el('send-run-label'),
};

interface Session {
  steps: Step[];
  name: string;
  id: string | undefined;
  options: ExportOptions;
  busy: boolean;
  /** An archived flow's frozen table. Absent for the live recording, whose
   *  table `sendFlow` reads back itself after its final resolve pass. */
  react: FlowReact | undefined;
}

let session: Session | null = null;

function paint(): void {
  if (!session) return;

  const view = deriveSendView({
    steps: session.steps,
    options: session.options,
    react: session.react,
    busy: session.busy,
  });

  const host = flowHost(session.steps);
  dom.subtitle.textContent = [
    `${session.steps.length} ${session.steps.length === 1 ? 'step' : 'steps'}`,
    host,
  ]
    .filter(Boolean)
    .join(' · ');

  dom.includes.replaceChildren(...view.includes.map(buildInclude));

  show(dom.note, view.note !== null);
  dom.note.textContent = view.note ?? '';

  show(dom.warning, view.warnBodies);

  dom.context.textContent = `~${formatTokens(view.context)} tokens of context`;
  dom.total.textContent = `Upload ${formatBytes(view.total)}`;

  dom.run.disabled = !view.canSend;
  dom.runLabel.textContent = view.busy ? 'Sending…' : 'Send';
  setIcon(dom.runIcon, view.busy ? 'loader-circle' : 'sparkles');
  dom.cancel.disabled = view.busy;
}

/**
 * What each part costs once it is over there.
 *
 * Screenshots are the one that surprises people: they are the biggest upload by
 * far and the cheapest to keep, because the server writes them to disk and
 * Claude only pays for the ones it opens.
 */
const NOTE: Record<keyof ExportOptions, string> = {
  images: 'Saved to disk; read on demand',
  network: 'Read with the steps',
  logs: 'Read with the steps',
  // Kept to the length of the other three: it sits beside the longest label,
  // and the value it describes is already in that label.
  react: 'Read with the steps',
};

function buildInclude(row: IncludeRow): HTMLElement {
  const node = clone<HTMLLabelElement>('tpl-include');

  node.dataset.ignored = String(row.ignored !== null);

  const input = find<HTMLInputElement>(node, '.include__input');
  input.checked = row.checked;
  input.disabled = row.ignored !== null || (session?.busy ?? false);

  find(node, '.include__label').textContent = row.label;
  // The ignored reason wins when there is one: "no React was recorded" is the
  // answer to the question the note would otherwise be answering.
  const note = find(node, '.include__note');
  note.textContent = row.ignored ?? NOTE[row.id];
  // The note is one line and truncates; the title is what a narrow dialog owes
  // whoever wants the rest of the sentence.
  note.title = note.textContent;
  find(node, '.include__size').textContent = row.ignored ? '—' : formatBytes(row.bytes);

  input.addEventListener('change', () => {
    if (!session) return;
    session.options = { ...session.options, [row.id]: input.checked };
    void setLocal({ sendOptions: session.options });
    paint();
  });

  return node;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

dom.close.addEventListener('click', () => dom.dialog.close());
dom.cancel.addEventListener('click', () => dom.dialog.close());
dom.run.addEventListener('click', () => void run());

/**
 * Escape must not cancel an upload in flight.
 *
 * `fetch` carries on after the dialog closes, and the server would store a flow
 * whose id nothing on screen is waiting to report.
 */
dom.dialog.addEventListener('cancel', (event) => {
  if (session?.busy) event.preventDefault();
});

async function run(): Promise<void> {
  if (!session || session.busy) return;

  session.busy = true;
  paint();

  const sent = await sendFlow(
    session.name,
    session.steps,
    session.id,
    session.options,
    session.react,
  );

  session.busy = false;
  paint();

  if (!sent.ok) {
    showToast({ message: sent.error.message, tone: 'danger', durationMs: 8000 });
    return;
  }

  dom.dialog.close();
  report(sent.value);
}

function report(result: SendResult): void {
  showToast({
    message: result.prompt
      ? 'Flow sent. The prompt is on your clipboard — paste it into Claude.'
      : `Flow sent as ${result.id}. Chrome refused the clipboard, so ask Claude for that id.`,
    tone: 'success',
    durationMs: 8000,
  });
}

export interface OpenSendOptions {
  steps: Step[];
  name: string;
  /** The saved flow's id, so a re-send overwrites rather than piling up. */
  id?: string;
  /** An archived flow's frozen component table; omitted for the recording. */
  react?: FlowReact | null;
}

export function openSend({ steps, name, id, react }: OpenSendOptions): void {
  if (steps.length === 0) {
    showToast({ message: 'There is nothing to send yet.' });
    return;
  }

  void (async () => {
    const stored = await getLocal('sendOptions');
    const options =
      stored.ok && stored.value.sendOptions
        ? { ...SEND_DEFAULTS, ...stored.value.sendOptions }
        : SEND_DEFAULTS;

    session = {
      steps,
      name,
      id,
      options,
      busy: false,
      react: react ?? undefined,
    };

    paint();
    dom.dialog.showModal();
  })();
}
