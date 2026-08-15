/**
 * JSON export — the replay artifact.
 *
 * Unlike the Markdown, this keeps the full selectors and XPaths: it is what a
 * future playback feature would drive from, and what the MCP server persists.
 */

import { compactBody } from '../schema/index.js';
import type { ExportOptions, Step } from '../../shared/types.js';

export const EXPORT_SCHEMA_VERSION = '1.0';

export interface JsonExportOptions extends Partial<ExportOptions> {
  /**
   * Per-step relative image path, for the ZIP export. When given, `screenshot`
   * becomes the filename rather than a placeholder string.
   */
  imageNames?: (string | null)[];
}

/** Serialise recorded steps to the on-disk flow format. */
export function exportToJSON(steps: Step[], options: JsonExportOptions = {}): string {
  const { imageNames, images, network, logs } = options;

  return JSON.stringify(
    {
      version: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      stepCount: steps.length,
      steps: steps.map((step, i) => {
        const out: Record<string, unknown> = { ...step };

        if (images === false) {
          out.screenshot = null;
        } else if (imageNames) {
          out.screenshot = imageNames[i] ?? null;
        } else {
          out.screenshot = step.screenshot ? '[base64 image data]' : null;
        }

        // Editor state, not flow data — never leaves the extension.
        delete out.screenshotOriginal;
        delete out.highlightBox;

        if (network === false) {
          delete out.networkCalls;
        } else if (step.networkCalls) {
          out.networkCalls = step.networkCalls.map((call) => ({
            ...call,
            requestBody: call.requestBody ? compactBody(call.requestBody) : call.requestBody,
            responseBody: call.responseBody ? compactBody(call.responseBody) : call.responseBody,
          }));
        }

        if (logs === false) delete out.consoleLogs;

        return out;
      }),
    },
    null,
    2,
  );
}
