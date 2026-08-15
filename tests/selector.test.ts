// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateSelector,
  generateXPath,
  isStableSelector,
} from '../src/core/selector/index.js';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('generateSelector', () => {
  it('prefers an id over everything else', () => {
    mount('<button id="save" data-testid="save-btn" aria-label="Save">Save</button>');
    expect(generateSelector(document.querySelector('button'))).toBe('#save');
  });

  it('falls back to data-testid, then aria-label', () => {
    mount('<button data-testid="save-btn" aria-label="Save">Save</button>');
    expect(generateSelector(document.querySelector('button'))).toBe(
      'button[data-testid="save-btn"]',
    );

    mount('<button aria-label="Save">Save</button>');
    expect(generateSelector(document.querySelector('button'))).toBe('button[aria-label="Save"]');
  });

  it('builds a path when the element has no stable hook', () => {
    mount('<div class="wrap"><span><button>Go</button></span></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('div.wrap > span > button');
  });

  it('anchors the path on the nearest ancestor id and stops there', () => {
    mount('<div id="panel"><div class="row"><button>Go</button></div></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('#panel > div.row > button');
  });

  it('drops transient state classes', () => {
    mount('<div class="card active hover"><button>Go</button></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('div.card > button');
  });

  it('keeps at most two classes so the selector stays readable', () => {
    mount('<div class="a b c d"><button>Go</button></div>');
    expect(generateSelector(document.querySelector('button'))).toBe('div.a.b > button');
  });

  it('disambiguates repeated siblings by position', () => {
    mount('<ul><li>one</li><li>two</li></ul>');
    const second = document.querySelectorAll('li')[1];
    expect(generateSelector(second)).toBe('ul > li:nth-of-type(2)');
  });

  it('returns empty for a missing element', () => {
    expect(generateSelector(null)).toBe('');
  });
});

describe('generateXPath', () => {
  it('numbers each level from the root', () => {
    mount('<div><p>one</p><p>two</p></div>');
    const second = document.querySelectorAll('p')[1];
    expect(generateXPath(second)).toBe('/html[1]/body[1]/div[1]/p[2]');
  });

  it('returns empty for a missing element', () => {
    expect(generateXPath(null)).toBe('');
  });
});

describe('isStableSelector', () => {
  it('accepts ids and test hooks', () => {
    expect(isStableSelector('#save')).toBe(true);
    expect(isStableSelector('button[data-testid="save"]')).toBe(true);
    expect(isStableSelector('button[aria-label="Save"]')).toBe(true);
  });

  it('rejects descendant chains, which break on any markup change', () => {
    expect(isStableSelector('div.wrap > span > button')).toBe(false);
  });

  it('rejects framework-generated ids, which change every render', () => {
    expect(isStableSelector('#radix-1')).toBe(false);
    expect(isStableSelector('#:r3:')).toBe(false);
  });

  it('rejects anything long enough to be noise in an export', () => {
    expect(isStableSelector(`#${'x'.repeat(70)}`)).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(isStableSelector('')).toBe(false);
    expect(isStableSelector(null)).toBe(false);
  });
});
