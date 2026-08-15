import { describe, expect, it } from 'vitest';
import { exportToMarkdown, flowHost, urlPath } from '../src/core/export/markdown.js';
import type { Step } from '../src/shared/types.js';

const click = (over: Partial<Step> = {}): Step =>
  ({
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
    ...over,
  }) as Step;

describe('urlPath', () => {
  it('keeps the path and query, drops the origin', () => {
    expect(urlPath('https://example.com/a/b?x=1')).toBe('/a/b?x=1');
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(urlPath('not a url')).toBe('not a url');
    expect(urlPath(undefined)).toBe('');
  });
});

describe('flowHost', () => {
  it('takes the host of the first parseable URL', () => {
    const steps = [click({ url: 'nonsense' }), click({ url: 'https://a.example.com/x' })];
    expect(flowHost(steps)).toBe('a.example.com');
  });

  it('is empty when nothing parses', () => {
    expect(flowHost([click({ url: 'nope' })])).toBe('');
  });
});

describe('exportToMarkdown', () => {
  it('numbers steps and titles the document', () => {
    const md = exportToMarkdown([click(), click({ action: 'Clicked "Cancel"' })], {
      title: 'Checkout',
    });
    expect(md).toContain('# Checkout');
    expect(md).toContain('### 1. Clicked "Save"');
    expect(md).toContain('### 2. Clicked "Cancel"');
    expect(md).toContain('2 steps');
  });

  it('marks a page change once, not on every step of the same page', () => {
    const md = exportToMarkdown([
      click(),
      click(),
      click({ url: 'https://app.example.com/checkout' }),
    ]);
    // Count markers at the start of a line — the legend mentions 📍 too.
    const markers = md.split('\n').filter((line) => line.startsWith('📍'));
    expect(markers).toEqual(['📍 /orders', '📍 /checkout']);
  });

  it('includes a stable selector and omits a brittle one', () => {
    const stable = exportToMarkdown([click()]);
    expect(stable).toContain('`#save`');

    const brittle = exportToMarkdown([
      click({
        element: {
          tag: 'button',
          cssSelector: 'div.wrap > div.row > button:nth-of-type(2)',
          xpath: '/x',
          boundingBox: null,
        },
      }),
    ]);
    expect(brittle).not.toContain('nth-of-type');
  });

  it('references image files rather than base64 when given filenames', () => {
    const md = exportToMarkdown([click({ screenshot: 'data:image/jpeg;base64,AAAA' })], {
      images: { kind: 'file', names: ['images/step-01.jpg'] },
    });
    expect(md).toContain('![1](images/step-01.jpg)');
    expect(md).not.toContain('base64,AAAA');
  });

  it('omits images entirely when asked to', () => {
    const md = exportToMarkdown([click({ screenshot: 'data:image/jpeg;base64,AAAA' })], {
      images: false,
    });
    expect(md).not.toContain('![1]');
  });

  it('keeps only errors and warnings from the console', () => {
    const md = exportToMarkdown([
      click({
        consoleLogs: [
          { level: 'log', args: ['chatter'], timestamp: 1 },
          { level: 'error', args: ['Boom'], timestamp: 2 },
          { level: 'warn', args: ['Careful'], timestamp: 3 },
        ],
      }),
    ]);
    expect(md).toContain('Boom');
    expect(md).toContain('Careful');
    expect(md).not.toContain('chatter');
  });

  it('drops network and console sections when excluded', () => {
    const step = click({
      networkCalls: [
        {
          method: 'POST',
          url: 'https://api.example.com/v2/submit',
          requestHeaders: {},
          requestBody: null,
          status: 201,
          responseHeaders: {},
          responseBody: null,
          durationMs: 12,
          timestamp: 1,
        },
      ],
      consoleLogs: [{ level: 'error', args: ['Boom'], timestamp: 1 }],
    });

    const full = exportToMarkdown([step]);
    expect(full).toContain('/v2/submit');
    expect(full).toContain('Boom');

    const stripped = exportToMarkdown([step], { network: false, logs: false });
    expect(stripped).not.toContain('/v2/submit');
    expect(stripped).not.toContain('Boom');
  });

  it('renders notes as a blockquote', () => {
    const md = exportToMarkdown([click({ notes: 'first\nsecond' })]);
    expect(md).toContain('> first\n> second');
  });
});
