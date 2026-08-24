// @vitest-environment jsdom

/**
 * The last few inches: flow → Blob → file on disk.
 *
 * `exportFlow` is the only place that touches the DOM, and both things asserted
 * here are invisible from the pure exporters — that the flow's name reaches
 * `flow.json`, and that the object URL outlives the click that reads it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportFlow } from '../src/features/export/download.js';
import type { ExportOptions, Step } from '../src/shared/types.js';

const OPTIONS: ExportOptions = { images: true, network: true, logs: true, react: true };

const step = (): Step => ({
  type: 'click',
  url: 'https://app.example.com/orders',
  timestamp: 1_000,
  action: 'Clicked "Save"',
  element: {
    tag: 'button',
    cssSelector: '#save',
    xpath: '/html[1]/body[1]/button[1]',
    boundingBox: null,
  },
});

let created: Blob[];
let revoked: string[];
let clicks: number;

beforeEach(() => {
  created = [];
  revoked = [];
  clicks = 0;

  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    created.push(blob as Blob);
    return `blob:mock/${created.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => void revoked.push(url));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => void (clicks += 1));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the object URL outlives the click', () => {
  it('is still valid when the click returns, and revoked on the next task', async () => {
    const written = await exportFlow({
      steps: [step()],
      title: 'Checkout',
      format: 'json',
      options: OPTIONS,
      filename: 'flowsnap-test',
    });

    expect(written.ok).toBe(true);
    expect(clicks).toBe(1);
    // Revoking in the same task is what truncated a large download to zero bytes
    // while `exportFlow` still returned ok() and the dialog toasted "Saved …".
    expect(revoked).toEqual([]);

    vi.runAllTimers();
    expect(revoked).toEqual(['blob:mock/1']);
  });
});

describe('flow.json carries the flow name', () => {
  it('writes the title the Markdown heading uses', async () => {
    await exportFlow({
      steps: [step()],
      title: 'Checkout · attempt 2',
      format: 'json',
      options: OPTIONS,
      filename: 'flowsnap-test',
    });

    const json = JSON.parse(await created[0].text()) as { name?: string };
    expect(json.name).toBe('Checkout · attempt 2');
  });
});
