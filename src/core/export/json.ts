/**
 * JSON export — the replay artifact.
 *
 * Unlike the Markdown, this keeps the full selectors and XPaths: it is what a
 * future playback feature would drive from, and what the MCP server persists.
 */

import { compactBody } from '../schema/index.js';
import { attributeSteps, pruneComponents } from '../react/attribution.js';
import type { ExportOptions, FlowReact, Step } from '../../shared/types.js';

export const EXPORT_SCHEMA_VERSION = '1.0';

export interface JsonExportOptions extends Partial<ExportOptions> {
  /**
   * Per-step relative image path, for the ZIP export. When given, `screenshot`
   * becomes the filename rather than a placeholder string.
   */
  imageNames?: (string | null)[];
  /**
   * The flow's component table, when it was recorded on a React page.
   *
   * Pruned to the steps being written, for the same reason the payload is: a
   * flow with half its steps deleted must not still carry the source paths of
   * the code behind them.
   */
  react?: FlowReact;
}

/** Serialise recorded steps to the on-disk flow format. */
export function exportToJSON(steps: Step[], options: JsonExportOptions = {}): string {
  const { imageNames, images, network, logs, react } = options;
  const components = react ? pruneComponents(steps, react.components) : {};
  const carries = react !== undefined && Object.keys(components).length > 0;
  // Stamped here rather than left for the reader to derive: a flow.json is read
  // by whatever opens it, and the choice of component must not depend on that.
  const list = carries ? attributeSteps(steps, components) : steps;

  return JSON.stringify(
    {
      version: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      stepCount: steps.length,
      // Absent rather than empty, so a flow from a page that is not React reads
      // the same as one exported before this existed.
      ...(carries ? { react: { ...react, components } } : {}),
      steps: list.map((step, i) => {
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
