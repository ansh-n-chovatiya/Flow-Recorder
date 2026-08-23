/**
 * Turning a flow into a file on disk.
 *
 * Split from the dialog so that *what* an export contains (export-view.ts, pure
 * and tested) is separate from *how* it reaches the filesystem. The old viewer
 * had the two welded together in three near-identical functions, which is why
 * the ZIP path grew an image-naming scheme the other two never got.
 */

import { exportToJSON } from '../../core/export/json.js';
import { exportToMarkdown } from '../../core/export/markdown.js';
import { createZip, dataUrlToBytes, type ZipEntry } from '../../core/export/zip.js';
import { flowHost, pad2, renumber } from '../../core/flow/index.js';
import { err, ok, type Result } from '../../shared/result.js';
import { flowError } from '../../shared/errors.js';
import type { ExportOptions, FlowReact, Step } from '../../shared/types.js';
import { EXTENSION, type ExportFormat } from './formats.js';

export interface ExportRequest {
  steps: Step[];
  /** The flow's name, which becomes the Markdown title. */
  title: string;
  format: ExportFormat;
  options: ExportOptions;
  /** Without an extension; this adds the one the format requires. */
  filename: string;
  /** The flow's component table, absent when the page was not React. */
  react?: FlowReact;
  /** Called as each screenshot is packed, so a large ZIP is not a frozen tab. */
  onProgress?: (done: number, total: number) => void;
}

function download(filename: string, blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

/**
 * Yield to the event loop.
 *
 * Packing thirty base64 screenshots is enough work to drop frames, and a dialog
 * that reports progress it never repaints is worse than one that reports none.
 */
function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function buildZip(request: ExportRequest): Promise<Blob> {
  const { steps, options, title, onProgress, react } = request;

  const encoder = new TextEncoder();
  const files: ZipEntry[] = [];
  const imageNames: (string | null)[] = [];

  const withImages = options.images ? steps.filter((step) => hasImage(step)).length : 0;
  let packed = 0;

  for (const [index, step] of steps.entries()) {
    if (!options.images || !hasImage(step)) {
      imageNames.push(null);
      continue;
    }

    const { bytes, ext } = dataUrlToBytes(step.screenshot as string);
    const name = `images/step-${pad2(index + 1)}.${ext}`;
    files.push({ name, data: bytes });
    imageNames.push(name);

    packed += 1;
    onProgress?.(packed, withImages);
    // Every eighth image: often enough that the count visibly moves, rarely
    // enough that yielding is not itself the cost.
    if (packed % 8 === 0) await breathe();
  }

  files.push({
    name: 'flow.md',
    data: encoder.encode(
      exportToMarkdown(steps, {
        title,
        images: options.images ? { kind: 'file', names: imageNames } : { kind: 'none' },
        network: options.network,
        logs: options.logs,
        react,
      }),
    ),
  });

  files.push({
    name: 'flow.json',
    data: encoder.encode(exportToJSON(steps, { ...options, imageNames, react })),
  });

  return createZip(files);
}

function hasImage(step: Step): boolean {
  return typeof step.screenshot === 'string' && step.screenshot.startsWith('data:');
}

export async function exportFlow(request: ExportRequest): Promise<Result<string>> {
  const { format, options, title, react } = request;
  // Numbered on the way out, so a flow with deleted steps exports 1, 2, 3 rather
  // than the capture-time 1, 2, 4.
  const steps = renumber(request.steps);
  if (steps.length === 0) return err(flowError('STORAGE_READ', 'nothing to export'));

  const filename = `${request.filename}${EXTENSION[format]}`;

  try {
    if (format === 'zip') {
      download(filename, await buildZip({ ...request, steps }));
    } else if (format === 'markdown') {
      const markdown = exportToMarkdown(steps, {
        title,
        images: options.images,
        network: options.network,
        logs: options.logs,
        react,
      });
      download(filename, new Blob([markdown], { type: 'text/markdown' }));
    } else {
      download(
        filename,
        new Blob([exportToJSON(steps, { ...options, react })], {
          type: 'application/json',
        }),
      );
    }

    return ok(filename);
  } catch (error) {
    // Building the archive is the one place here that can genuinely fail —
    // usually by running out of memory on a flow of full-page screenshots.
    return err(flowError('STORAGE_READ', error instanceof Error ? error.message : error));
  }
}

/** The default filename's flow-specific half: `flowsnap-github-com-2026-08-15`. */
export function suggestFilename(steps: Step[], date = new Date()): string {
  const host = flowHost(steps).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return host ? `flowsnap-${host}-${day}` : `flowsnap-flow-${day}`;
}
