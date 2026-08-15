/**
 * Handing a flow to Claude.
 *
 * The flow is POSTed to the local MCP server, which writes it to disk and
 * answers with the id Claude will fetch it by. What comes back to the user is a
 * prompt on the clipboard: the server cannot start a conversation, so the last
 * step is always a paste, and pretending otherwise was the old toast's mistake.
 */

import { startUrl } from '../../core/flow/index.js';
import { getSync } from '../../chrome/storage.js';
import { DEFAULT_MCP_URL } from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { FlowPayload, Step } from '../../shared/types.js';

/** How long to wait before calling a silent address unreachable. */
const TIMEOUT_MS = 10_000;

export interface SendResult {
  /** The id the server stored the flow under. */
  id: string;
  /** The prompt written to the clipboard, or `null` if the write was refused. */
  prompt: string | null;
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
): Promise<Result<SendResult>> {
  if (steps.length === 0) return err(flowError('MCP_UNREACHABLE', 'nothing to send'));

  const settings = await getSync({ mcpServerUrl: DEFAULT_MCP_URL });
  const url = settings.ok ? settings.value.mcpServerUrl : DEFAULT_MCP_URL;

  const first = startUrl(steps);
  const payload: FlowPayload = { id, name, timestamp: Date.now(), startUrl: first, steps };

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
    const prompt = buildPrompt(savedId, steps, first);

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
