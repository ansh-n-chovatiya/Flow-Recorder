/**
 * The only place `chrome.tabs` is called.
 *
 * Two things here are load-bearing beyond wrapping the API: screenshots are
 * taken from an explicit window rather than "whatever has focus", and captures
 * are spaced so they stay inside Chrome's rate limit.
 */

import { flowError } from '../shared/errors.js';
import { CAPTURE_MIN_INTERVAL_MS, SCREENSHOT_QUALITY } from '../shared/constants.js';
import { err, ok, type Result } from '../shared/result.js';

/**
 * URL schemes Chrome refuses to let extensions touch. Starting a recording on
 * one of these used to report success and then capture nothing at all.
 */
const BLOCKED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
  'data:',
];

/** Hosts that are ordinary https but still off-limits to extension scripts. */
const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

/** Whether FlowSnap is allowed to run on a URL at all. Pure — see tests. */
export function isRecordableUrl(url: string | undefined): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (BLOCKED_SCHEMES.includes(parsed.protocol)) return false;

  // chrome.google.com is only blocked for the Web Store path, but the store is
  // the only reason anyone lands there from an extension.
  if (BLOCKED_HOSTS.includes(parsed.hostname)) return false;

  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
}

export async function getActiveTab(): Promise<Result<chrome.tabs.Tab>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id == null ? err(flowError('NO_ACTIVE_TAB')) : ok(tab);
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Chrome permits roughly two `captureVisibleTab` calls per second and rejects
 * the rest. The original code fired one every 150 ms and swallowed the
 * rejection, so fast clicking silently produced steps with no screenshot. This
 * spaces calls instead of losing them.
 */
let lastCaptureAt = 0;
let captureChain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureNow(windowId: number | undefined): Promise<Result<string>> {
  const wait = CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);

  try {
    const dataUrl =
      windowId == null
        ? await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: SCREENSHOT_QUALITY })
        : await chrome.tabs.captureVisibleTab(windowId, {
            format: 'jpeg',
            quality: SCREENSHOT_QUALITY,
          });
    lastCaptureAt = Date.now();
    return ok(dataUrl);
  } catch (error) {
    lastCaptureAt = Date.now();
    const detail = error instanceof Error ? error.message : String(error);
    const rateLimited = /quota|too many/i.test(detail);
    return err(flowError(rateLimited ? 'CAPTURE_RATE_LIMITED' : 'CAPTURE_FAILED', detail));
  }
}

/**
 * Screenshot a specific window's visible tab.
 *
 * `windowId` comes from the message sender, not from "the current window" — a
 * service worker has no meaningful current window, so the old call captured
 * whichever window last had focus, which is not necessarily the one the step
 * came from.
 */
export function captureVisibleTab(windowId: number | undefined): Promise<Result<string>> {
  // Serialise: two concurrent captures would both see the same `lastCaptureAt`
  // and neither would wait.
  const next = captureChain.then(() => captureNow(windowId));
  captureChain = next.catch(() => undefined);
  return next;
}

// ── Messaging ────────────────────────────────────────────────────────────────

/**
 * Send to a tab, treating "no receiving end" as a normal outcome — it means the
 * content script is not there, which is a state the caller has to handle rather
 * than an exception.
 */
export async function sendToTab<T>(tabId: number, message: unknown): Promise<Result<T>> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, message)) as T;
    return ok(response);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return err(flowError(/No tab with id/i.test(detail) ? 'TAB_GONE' : 'TAB_NOT_READY', detail));
  }
}

/** Send to every tab that has a content script, ignoring the ones that do not. */
export async function broadcast(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || !isRecordableUrl(tab.url)) return;
      await sendToTab(tab.id, message);
    }),
  );
}
