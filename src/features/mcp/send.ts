/**
 * Handing a flow to Claude.
 *
 * The flow is POSTed to the local MCP server, which writes it to disk and
 * answers with the id Claude will fetch it by. What comes back to the user is a
 * prompt on the clipboard: the server cannot start a conversation, so the last
 * step is always a paste, and pretending otherwise was the old toast's mistake.
 */

import { renumber, startUrl } from '../../core/flow/index.js';
import { attributeSteps, pruneComponents, stripReactRef } from '../../core/react/attribution.js';
import { getSync } from '../../chrome/storage.js';
import { readCurrentReact } from '../flows/store.js';
import { sendToWorker } from '../../shared/messages.js';
import { DEFAULT_MCP_URL, FLOW_SCHEMA_VERSION } from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { ExportOptions, FlowPayload, FlowReact, Step } from '../../shared/types.js';

/** How long to wait before calling a silent address unreachable. */
const TIMEOUT_MS = 10_000;

/**
 * What a send carries when nobody has chosen otherwise.
 *
 * Everything, because that is what every send did before the choice existed —
 * a default that quietly dropped screenshots would be a data loss disguised as
 * a feature.
 */
export const SEND_EVERYTHING: ExportOptions = {
  images: true,
  network: true,
  logs: true,
  react: true,
};

/**
 * Drop the parts of a flow the user chose not to hand over.
 *
 * Applied here rather than asked of the server: the point of the choice is that
 * the unwanted data never leaves the machine, and a flag the server honours is
 * not the same promise. Pure — see tests/send-view.test.ts.
 *
 * React is stripped from the step rather than from the payload, and that is what
 * makes the guarantee hold end to end: `buildPayload` prunes the component table
 * to the ids the steps still reference, so a step with no `react` ref keeps its
 * component out of the table without any second switch to forget.
 */
export function pruneSteps(steps: Step[], include: ExportOptions): Step[] {
  if (include.images && include.network && include.logs && include.react) return steps;

  return steps.map((step) => {
    const next = { ...step };

    if (!include.images) {
      delete next.screenshot;
      delete next.screenshotOriginal;
    }
    if (!include.network) delete next.networkCalls;
    if (!include.logs) delete next.consoleLogs;
    // `stripReactRef` copies rather than mutates, for the same reason `next`
    // does: the element is shared with the stored recording.
    return include.react ? next : stripReactRef(next);
  });
}

export interface SendResult {
  /** The id the server stored the flow under. */
  id: string;
  /** The prompt written to the clipboard, or `null` if the write was refused. */
  prompt: string | null;
}

/**
 * The body of the POST. Pure, so the wire format is testable without a server.
 *
 * The component table is pruned to what the steps being sent actually point at:
 * a user who dropped half the flow in the review tab, or turned a section off in
 * the send dialog, must not still hand over the source paths of the code behind
 * it. `react` is omitted entirely rather than sent empty, because the server and
 * the reader both take its absence to mean "not a React page".
 *
 * A needle never appears here, and there is a test that says so. Needles live in
 * their own storage key and are deleted the moment a component has an answer, so
 * this is a guarantee about the shape of `ComponentSource` rather than a filter —
 * which is the strong kind, and the assertion is what keeps it that way.
 */
export function buildPayload(
  id: string,
  name: string,
  steps: Step[],
  at: number,
  react?: FlowReact | null,
  include: ExportOptions = SEND_EVERYTHING,
): FlowPayload {
  const components = react ? pruneComponents(steps, react.components) : {};
  const carries = react !== null && react !== undefined && Object.keys(components).length > 0;
  const omitted = (['images', 'network', 'logs', 'react'] as const).filter((key) => !include[key]);

  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name,
    timestamp: at,
    startUrl: startUrl(steps),
    ...(omitted.length ? { omitted } : {}),
    // The owner is stamped here so the server does not have to know the rules
    // that pick it — see `attributeSteps`.
    steps: carries ? attributeSteps(steps, components) : steps,
    ...(carries ? { react: { ...react, components } } : {}),
  };
}

/** What to paste into Claude. Pure, so the wording is one place. */
export function buildPrompt(id: string, steps: Step[], first: string | undefined): string {
  return (
    `Call get_flow("${id}") now (flowsnap MCP) — ${steps.length}-step recording` +
    `${first ? ` @ ${first}` : ''}. Read the steps, identify what the user did or what broke, then help.`
  );
}

export async function sendFlow(
  name: string,
  steps: Step[],
  id = `flow-${Date.now()}`,
  include: ExportOptions = SEND_EVERYTHING,
  /** An archived flow's frozen table. Omitted for the live recording, whose
   *  table is read back here so it includes whatever the resolve below found. */
  archivedReact?: FlowReact | null,
  /** When the flow was *recorded*. Defaults to now, which is only right for the
   *  live recording — an archived flow has its own, older, `createdAt`. */
  recordedAt?: number,
): Promise<Result<SendResult>> {
  if (steps.length === 0) return err(flowError('MCP_UNREACHABLE', 'nothing to send'));

  // Last chance to resolve React components while the recorded tab may still be
  // open and its bundles still cached. It resolves nothing when there is nothing
  // pending, and a worker that never answers costs the send nothing.
  //
  // `final` is safe to ask for even though this path also sends archived flows:
  // the worker downgrades it whenever a recording is still running, which is the
  // only case where writing pending components off as skipped would be a lie.
  //
  // Skipped outright when React is not being sent: resolution reads the page's
  // bundles, and doing that work to build a table this send is about to throw
  // away would be the one cost the switch exists to avoid.
  if (include.react) await sendToWorker({ type: 'RESOLVE_COMPONENTS', final: true });

  const settings = await getSync({ mcpServerUrl: DEFAULT_MCP_URL });
  const url = settings.ok ? settings.value.mcpServerUrl : DEFAULT_MCP_URL;

  // Renumbered first, so `stepNumber` agrees with the position the server files
  // the step at. A flow with a step deleted in the review tab was sent carrying
  // its original numbers, so the JSON said "step 5" where the markdown said
  // "Step 4" and `get_flow_screenshots({steps:[5]})` answered that step 5 does
  // not exist. Every other export path already renumbers; this one did not.
  const sending = pruneSteps(renumber(steps), include);
  // Read after the resolve, so the table carries what that last pass found.
  // Not read at all when React is switched off for this send — `sending` has no
  // refs left, so the table would prune to nothing, but not touching storage is
  // the clearer promise.
  const react = include.react ? (archivedReact ?? (await readCurrentReact(sending))) : null;
  // The recording's own time, not the moment Send was pressed. The server
  // prints this as "Recorded" and orders `list_flows` by it, so stamping now
  // dated a week-old flow to this afternoon and pushed it above the recording
  // the user actually just made.
  const payload = buildPayload(id, name, sending, recordedAt ?? Date.now(), react, include);
  const first = payload.startUrl;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });

    if (!response.ok) return err(flowError('MCP_UNREACHABLE', `HTTP ${response.status}`));

    const body = (await response.json()) as { id?: string };
    const savedId = body.id ?? id;
    const prompt = buildPrompt(savedId, sending, first);

    // The clipboard needs the document to be focused, which it is not if the
    // user clicked away while a large flow uploaded. The send still worked, so
    // that is reported as a success with the prompt shown to copy by hand.
    const copied = await navigator.clipboard
      .writeText(prompt)
      .then(() => true)
      .catch(() => false);

    return ok({ id: savedId, prompt: copied ? prompt : null });
  } catch (error) {
    return err(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    clearTimeout(timer);
  }
}
