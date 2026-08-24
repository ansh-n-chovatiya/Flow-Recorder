/**
 * Writes to the MCP server that are not a send.
 *
 * Its own module rather than part of `send.ts`, because `store.ts` has to call
 * this and `send.ts` imports `store.ts` — putting it there would close a cycle
 * between storage and the network layer.
 */

import { getSync } from '../../chrome/storage.js';
import { DEFAULT_MCP_URL } from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';

/** How long to wait before calling a silent address unreachable. */
const TIMEOUT_MS = 10_000;

/**
 * Tell the MCP server to forget a flow, if it ever had it.
 *
 * Deleting in the extension used to clear `chrome.storage` and stop there, so a
 * recording the user deleted — perhaps *because* they saw it had captured a
 * session token in a response body — stayed in `~/.flowsnap/flows` and was
 * handed to Claude by the next `list_flows`. The row disappeared and the
 * extension reported success, which is the worst version of not deleting
 * something.
 *
 * Best effort by design: the server is usually not running, and a delete that
 * failed because nothing was listening must not stop the local delete. The
 * result says what happened so the caller can mention it rather than guess.
 */
export async function deleteRemoteFlow(id: string): Promise<Result<void>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    // Inside the guard, not before it. Callers fire this and walk away, so a
    // throw from here would surface as an unhandled rejection rather than as
    // the failed `Result` this promises to return.
    const settings = await getSync({ mcpServerUrl: DEFAULT_MCP_URL });
    const base = settings.ok ? settings.value.mcpServerUrl : DEFAULT_MCP_URL;

    const path = new URL(base).pathname.replace(/\/$/, '');
    const url = new URL(`${path}/${encodeURIComponent(id)}`, base);
    const response = await fetch(url, { method: 'DELETE', signal: abort.signal });
    return response.ok ? ok(undefined) : err(flowError('MCP_UNREACHABLE', `HTTP ${response.status}`));
  } catch (error) {
    return err(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    clearTimeout(timer);
  }
}
