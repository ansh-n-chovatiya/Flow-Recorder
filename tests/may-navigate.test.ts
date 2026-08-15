// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mayNavigate } from '../src/core/describe/index.js';

function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * These are the interactions whose screenshot has to be taken *before* the
 * click, because the page they describe is gone milliseconds later.
 */
describe('mayNavigate', () => {
  it('is true for a link with an href', () => {
    mount('<a href="/orders">Orders</a>');
    expect(mayNavigate(document.querySelector('a')!)).toBe(true);
  });

  it('is false for an anchor used as a button', () => {
    mount('<a>Toggle</a>');
    expect(mayNavigate(document.querySelector('a')!)).toBe(false);
  });

  it('is true for anything with role=link', () => {
    mount('<div role="link">Go</div>');
    expect(mayNavigate(document.querySelector('div')!)).toBe(true);
  });

  it('is true for a submit button and for any button inside a form', () => {
    mount('<button type="submit">Save</button>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(true);

    mount('<form><button type="button">Add row</button></form>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(true);
  });

  it('is false for a standalone button', () => {
    mount('<button type="button">Open menu</button>');
    expect(mayNavigate(document.querySelector('button')!)).toBe(false);
  });

  it('is true for submit and image inputs', () => {
    mount('<input type="submit" value="Go">');
    expect(mayNavigate(document.querySelector('input')!)).toBe(true);

    mount('<input type="image" alt="Go">');
    expect(mayNavigate(document.querySelector('input')!)).toBe(true);
  });

  it('is false for a text input', () => {
    mount('<input type="text">');
    expect(mayNavigate(document.querySelector('input')!)).toBe(false);
  });

  it('resolves through the icon inside a link, which is what gets clicked', () => {
    mount('<a href="/x"><svg class="lucide lucide-external-link"></svg></a>');
    expect(mayNavigate(document.querySelector('svg')!)).toBe(true);
  });

  it('is false for ordinary page content', () => {
    mount('<p id="p">Some text</p>');
    expect(mayNavigate(document.getElementById('p')!)).toBe(false);
  });
});
