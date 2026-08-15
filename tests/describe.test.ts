// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessibleName,
  describeTarget,
  getElementLabel,
  iconName,
  resolveTarget,
} from '../src/core/describe/index.js';

function mount(html: string): void {
  document.body.innerHTML = html;
}

/** jsdom implements `textContent` but not layout-dependent `innerText`. */
function shimInnerText(): void {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
}

beforeEach(() => {
  shimInnerText();
  document.body.innerHTML = '';
});

describe('resolveTarget', () => {
  it('walks up from an icon to the button that handles the click', () => {
    mount('<button id="b"><svg class="lucide lucide-trash-2"></svg></button>');
    const svg = document.querySelector('svg')!;
    expect(resolveTarget(svg).id).toBe('b');
  });

  it('gives up after four hops rather than selecting the page', () => {
    mount('<button><a><b><i><u><span id="deep">x</span></u></i></b></a></button>');
    const deep = document.getElementById('deep')!;
    // <a> is interactive and sits four hops up, so it wins over <button>.
    expect(resolveTarget(deep).tagName).toBe('A');
  });

  it('returns the element itself when it is already interactive', () => {
    mount('<button id="b">Go</button>');
    expect(resolveTarget(document.getElementById('b')!).id).toBe('b');
  });
});

describe('accessibleName', () => {
  it('prefers aria-label over text', () => {
    mount('<button aria-label="Close dialog">×</button>');
    expect(accessibleName(document.querySelector('button')!)).toBe('Close dialog');
  });

  it('follows aria-labelledby', () => {
    mount('<span id="lbl">Delete order</span><button aria-labelledby="lbl"></button>');
    expect(accessibleName(document.querySelector('button')!)).toBe('Delete order');
  });

  it('falls back to the column header for a bare table cell', () => {
    mount('<table><tr><th>Status<span id="c">x</span></th></tr></table>');
    // The span has text, so use an empty one to reach the <th> branch.
    document.getElementById('c')!.textContent = '';
    expect(accessibleName(document.getElementById('c')!)).toBe('Status');
  });

  it('is empty when there is genuinely nothing to say', () => {
    mount('<div id="d"></div>');
    expect(accessibleName(document.getElementById('d')!)).toBe('');
  });
});

describe('iconName', () => {
  it('maps a known Lucide icon to what it does', () => {
    mount('<button><svg class="lucide lucide-trash-2"></svg></button>');
    expect(iconName(document.querySelector('button')!)).toBe('delete');
  });

  it('humanises an unknown icon rather than dropping it', () => {
    mount('<button><svg class="lucide lucide-rocket-ship"></svg></button>');
    expect(iconName(document.querySelector('button')!)).toBe('rocket ship');
  });

  it('is empty when there is no icon', () => {
    mount('<button>Go</button>');
    expect(iconName(document.querySelector('button')!)).toBe('');
  });
});

describe('getElementLabel', () => {
  it('uses the associated label element', () => {
    mount('<label for="email">Email address</label><input id="email">');
    expect(getElementLabel(document.getElementById('email')!)).toBe('Email address');
  });

  it('falls back to the placeholder', () => {
    mount('<input placeholder="you@example.com">');
    expect(getElementLabel(document.querySelector('input')!)).toBe('you@example.com');
  });

  it('falls back to the tag name when nothing identifies the field', () => {
    mount('<input>');
    expect(getElementLabel(document.querySelector('input')!)).toBe('input');
  });
});

describe('describeTarget', () => {
  it('names a plain button click', () => {
    mount('<button>Save changes</button>');
    expect(describeTarget(document.querySelector('button')!).action).toBe(
      'Clicked "Save changes"',
    );
  });

  it('reports a toggle with its resulting state', () => {
    mount('<div role="switch" aria-checked="true" aria-label="Notifications"></div>');
    expect(describeTarget(document.querySelector('[role=switch]')!).action).toBe(
      'Toggled "Notifications" → on',
    );
  });

  it('distinguishes links from buttons', () => {
    mount('<a href="/orders">Orders</a>');
    expect(describeTarget(document.querySelector('a')!).action).toBe('Clicked link "Orders"');
  });

  it('calls out a submit input', () => {
    mount('<input type="submit" value="Place order">');
    expect(describeTarget(document.querySelector('input')!).action).toBe(
      'Clicked submit "Place order"',
    );
  });

  it('appends the icon meaning when the label does not already say it', () => {
    mount('<button aria-label="Row actions"><svg class="lucide lucide-trash-2"></svg></button>');
    expect(describeTarget(document.querySelector('button')!).action).toBe(
      'Clicked "Row actions" (delete)',
    );
  });

  it('uses the icon alone for an unlabelled icon button', () => {
    mount('<button><svg class="lucide lucide-search"></svg></button>');
    expect(describeTarget(document.querySelector('button')!).action).toBe('Clicked "search"');
  });

  it('says something rather than nothing for an anonymous element', () => {
    mount('<div id="d"></div>');
    expect(describeTarget(document.getElementById('d')!).action).toBe('Clicked element');
  });
});
