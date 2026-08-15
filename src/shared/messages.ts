/**
 * Message contracts between the popup, viewer, content script and worker.
 *
 * Every `chrome.runtime` / `chrome.tabs` message in the extension is one of the
 * unions below, and every response is looked up from a type map — so a handler
 * that returns the wrong shape is a compile error rather than an undefined at
 * runtime. `sendMessage` also reads `lastError`, which unread would log
 * "Unchecked runtime.lastError" on every closed tab.
 */

import type { BoundingBox, DraftStep, Step } from './types.js';

// ── Page → worker ────────────────────────────────────────────────────────────

export interface CaptureAndSaveStep {
  type: 'CAPTURE_AND_SAVE_STEP';
  step: DraftStep;
  elementBox: BoundingBox | null;
  dpr: number;
}

export interface AnnotateScreenshot {
  type: 'ANNOTATE_SCREENSHOT';
  screenshot: string;
  box: BoundingBox;
  dpr: number;
}

/**
 * Screenshot now and hold it for the click that is about to happen. Sent on
 * pointerdown for interactions that may navigate.
 */
export interface Precapture {
  type: 'PRECAPTURE';
}

export interface GetSteps {
  type: 'GET_STEPS';
}

export interface ClearSteps {
  type: 'CLEAR_STEPS';
}

export type WorkerRequest =
  | CaptureAndSaveStep
  | Precapture
  | AnnotateScreenshot
  | GetSteps
  | ClearSteps;

export interface AnnotateScreenshotResponse {
  screenshot: string | null;
}

export interface GetStepsResponse {
  steps: Step[];
}

export interface OkResponse {
  ok: boolean;
}

export interface ResponseByType {
  /** Resolves once the capture is done, so the page can restore its indicator. */
  CAPTURE_AND_SAVE_STEP: OkResponse;
  PRECAPTURE: OkResponse;
  ANNOTATE_SCREENSHOT: AnnotateScreenshotResponse;
  GET_STEPS: GetStepsResponse;
  CLEAR_STEPS: OkResponse;
}

// ── UI → content script ──────────────────────────────────────────────────────

export type ContentRequest =
  | { type: 'PING' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'RESUME_RECORDING' }
  | { type: 'CLEAR_STEPS' };

// ── Injected agent → content script ──────────────────────────────────────────

export interface AgentLogMessage {
  __flowsnap_source__: string;
  kind: 'log';
  level: string;
  args: string[];
  timestamp: number;
}

export interface AgentNetworkMessage {
  __flowsnap_source__: string;
  kind: 'network';
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  durationMs: number;
  timestamp: number;
}

export type AgentMessage = AgentLogMessage | AgentNetworkMessage;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Promise wrapper around `chrome.runtime.sendMessage` that resolves with
 * `undefined` when the receiving end is gone rather than rejecting, so callers
 * can treat "worker asleep" and "worker answered" the same way.
 */
export function sendToWorker<T extends WorkerRequest>(
  req: T,
): Promise<ResponseByType[T['type']] | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (resp: ResponseByType[T['type']] | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(resp);
    });
  });
}
