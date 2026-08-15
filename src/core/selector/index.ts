/**
 * Selector generation.
 *
 * Pure functions over a DOM element — no `chrome.*`, no module-level state — so
 * they can be exercised in jsdom rather than by clicking around a real page.
 */

/** Classes that represent transient UI state rather than stable identity. */
const STATE_CLASS_RE = /^(active|hover|focus|selected|disabled|visible|hidden)$/;

/** Framework-generated ids, which change on every render. */
const GENERATED_ID_RE = /radix|:r[0-9a-z]*:|_r_/i;

/**
 * Build a selector for an element, preferring the most robust hook available:
 * id > data-testid > aria-label > full CSS path.
 */
export function generateSelector(el: Element | null): string {
  if (!el || el.nodeType !== 1) return '';

  if (el.id) return `#${CSS.escape(el.id)}`;

  const testId = el.getAttribute('data-testid');
  if (testId) return `${el.tagName.toLowerCase()}[data-testid="${CSS.escape(testId)}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;

  return buildCSSPath(el);
}

/**
 * Walk up to `<body>` building a descendant path. An ancestor id short-circuits
 * the walk — ids are unique enough to anchor on, and stopping there keeps the
 * selector short enough to stay readable.
 */
export function buildCSSPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'body') {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }

    let segment = node.tagName.toLowerCase();

    // Filter out state classes and cap at 2 stable classes.
    const classes = Array.from(node.classList)
      .filter((cls) => !STATE_CLASS_RE.test(cls))
      .slice(0, 2);
    for (const cls of classes) segment += `.${CSS.escape(cls)}`;

    // Disambiguate with nth-of-type when there are multiple same-tag siblings.
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((sib) => sib.tagName === node!.tagName);
      if (sameTag.length > 1) segment += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }

    parts.unshift(segment);
    node = node.parentElement;
  }

  return parts.join(' > ');
}

/** Build a positional XPath from the document root to the element. */
export function generateXPath(el: Element | null): string {
  if (!el || el.nodeType !== 1) return '';

  const parts: string[] = [];
  let node: Node | null = el;

  while (node && node.nodeType === 1) {
    const current = node as Element;
    let index = 1;
    let sibling = current.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && (sibling as Element).tagName === current.tagName) index++;
      sibling = sibling.previousSibling;
    }

    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);

    node = current.parentNode;
    if (!node || node.nodeType !== 1) break;
  }

  return `/${parts.join('/')}`;
}

/**
 * Whether a selector is worth showing to a human or an AI: a short, stable hook
 * that maps to source code. Long ancestor chains and framework-generated ids are
 * hundreds of tokens of noise per step, and belong only in the replay JSON.
 */
export function isStableSelector(selector: string | null | undefined): boolean {
  if (!selector || selector.length > 60) return false;
  if (GENERATED_ID_RE.test(selector)) return false;
  if (selector.includes(' ')) return false; // descendant chain → brittle
  return (
    selector.startsWith('#') ||
    selector.includes('[data-testid') ||
    selector.includes('[aria-label')
  );
}
