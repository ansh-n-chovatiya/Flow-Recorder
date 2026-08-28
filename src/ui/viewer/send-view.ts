/**
 * What the "Send to Claude" dialog should show, derived from the flow and the
 * choices.
 *
 * The export dialog already answers "which parts of this flow do you want?" —
 * sending answered it for you, with everything, and a thirty-step recording of
 * a page that talks to an API is mostly network bodies nobody asked to read.
 * So the same switches, measured the way *this* destination charges for them:
 * an upload in bytes, and a context cost in tokens.
 *
 * Deliberately no format cards and no filename. The wire format is fixed by the
 * server and the id is assigned by it, so a choice there would be a decoration.
 *
 * Pure — see tests/send-view.test.ts.
 */

import {
  SEND_DEFAULT_IMAGES,
  SEND_DEFAULT_LOGS,
  SEND_DEFAULT_NETWORK,
  SEND_DEFAULT_REACT,
} from '../../shared/constants.js';
import type { ExportOptions, FlowReact, Step } from '../../shared/types.js';
import {
  INCLUDE_LABEL,
  measure,
  NO_REACT_NOTE,
  type IncludeRow,
  type Parts,
} from './export-view.js';

/**
 * What a send carries before anyone touches the switches.
 *
 * Not a second copy of the four booleans: they are `SEND_DEFAULT_*` in
 * `shared/constants.ts`, which is where `export.send*` in the field table takes
 * its own defaults from, and where the reasoning for the asymmetry with the
 * export dialog is written down. Phase 4 made this a derivation rather than a
 * literal — the dialog reads the *setting* now, and a second hardcoded answer
 * here would be the one that disagreed with the Settings screen.
 *
 * Kept, rather than deleted with its last product caller, because the shipped
 * default is worth being a tested fact in the module that documents what a send
 * costs.
 */
export const SEND_DEFAULTS: ExportOptions = {
  images: SEND_DEFAULT_IMAGES,
  network: SEND_DEFAULT_NETWORK,
  logs: SEND_DEFAULT_LOGS,
  react: SEND_DEFAULT_REACT,
};

export interface SendInput {
  steps: Step[];
  options: ExportOptions;
  /** The flow's component table, so the React row can price itself. */
  react?: FlowReact;
  /** True while the POST is in flight. */
  busy: boolean;
}

export interface SendView {
  includes: IncludeRow[];
  /** Bytes on the wire — what the POST body will weigh. */
  total: number;
  /** Bytes of text Claude actually reads back, for the token estimate. */
  context: number;
  /** Bodies are not redacted, and this is the moment that matters. */
  warnBodies: boolean;
  /** Set when every switch is off, because a flow can still be sent that way. */
  note: string | null;
  canSend: boolean;
  busy: boolean;
}

/**
 * What the POST body weighs.
 *
 * Screenshots travel as the data URLs they are stored as, so they cost their
 * full string length here rather than the decoded size a ZIP entry costs.
 */
function uploadBytes(parts: Parts, options: ExportOptions): number {
  return (
    parts.base +
    (options.images ? parts.screenshotsInline : 0) +
    (options.network ? parts.network : 0) +
    (options.logs ? parts.logs : 0) +
    (options.react ? parts.react : 0)
  );
}

/**
 * What lands in the conversation.
 *
 * Screenshots are excluded on purpose: the server writes them to disk and
 * `get_flow` hands back paths, so an image costs nothing until Claude opens
 * one. Counting them here would tell the user to switch off the one part that
 * is already free.
 */
function contextBytes(parts: Parts, options: ExportOptions): number {
  return (
    parts.base +
    (options.network ? parts.network : 0) +
    (options.logs ? parts.logs : 0) +
    // Counted, unlike screenshots: the component table is read back with the
    // steps, so it is context the assistant pays for on every turn.
    (options.react ? parts.react : 0)
  );
}

export function deriveSendView(input: SendInput): SendView {
  const { steps, options, busy } = input;
  const parts = measure(steps, input.react);

  const includes: IncludeRow[] = [
    {
      id: 'images',
      label: INCLUDE_LABEL.images,
      checked: options.images,
      bytes: parts.screenshotsInline,
      // Never ignored: unlike the JSON export, the server keeps every image it
      // is given. The note says where they go, since that is what decides
      // whether leaving them on is expensive.
      ignored: null,
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
    {
      id: 'react',
      label: INCLUDE_LABEL.react,
      checked: options.react,
      bytes: parts.react,
      ignored: parts.react === 0 ? NO_REACT_NOTE : null,
    },
  ];

  // A React switch left on over a flow that recorded none is still a bare send:
  // the note describes what Claude will get, not which boxes are ticked.
  const bare =
    !options.images && !options.network && !options.logs && (!options.react || parts.react === 0);

  return {
    includes,
    total: uploadBytes(parts, options),
    context: contextBytes(parts, options),
    // Headers are redacted at capture; bodies are not. Saying so belongs at the
    // moment the bodies are about to leave the machine.
    warnBodies: options.network && parts.network > 0,
    note: bare ? 'Claude will get the steps and their URLs, and nothing else.' : null,
    canSend: steps.length > 0 && !busy,
    busy,
  };
}
