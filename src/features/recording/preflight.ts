/**
 * Can this tab be recorded, and is it ready?
 *
 * Answering before the user presses Start is the whole point: the popup used to
 * flip to "Recording in progress" regardless of whether anything was listening,
 * so a recording on a chrome:// page, the Web Store, or any tab opened before
 * the extension was installed produced nothing at all, with no error.
 */

import { ensureContentScript } from '../../chrome/scripting.js';
import { getActiveTab, isRecordableUrl } from '../../chrome/tabs.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';

export interface RecordingTarget {
  tabId: number;
  windowId: number;
  url: string;
  /** Hostname, for display. Empty when the URL will not parse. */
  host: string;
  title: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Resolve the tab a recording would target.
 *
 * `inject` is false for a passive check — opening the popup should not modify
 * the page — and true when the user has actually asked to record.
 */
export async function preflight(inject: boolean): Promise<Result<RecordingTarget>> {
  const tab = await getActiveTab();
  if (!tab.ok) return err(tab.error);

  const { id, windowId, url, title } = tab.value;
  if (id == null) return err(flowError('NO_ACTIVE_TAB'));
  if (!isRecordableUrl(url)) return err(flowError('TAB_NOT_RECORDABLE', url));

  const target: RecordingTarget = {
    tabId: id,
    windowId,
    url: url!,
    host: hostOf(url!),
    title: title ?? '',
  };

  if (inject) {
    const ready = await ensureContentScript(id, url);
    if (!ready.ok) return err(ready.error);
  }

  return ok(target);
}
