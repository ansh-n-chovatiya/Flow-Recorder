// FlowSnap — selector utilities.
// Loaded BEFORE content.js in the same content_scripts array, so these
// top-level function declarations are visible to content.js in the shared
// isolated-world global scope. Do NOT wrap in a module/IIFE.

// Classes that represent transient UI state rather than stable identity.
const STATE_CLASS_RE = /^(active|hover|focus|selected|disabled|visible|hidden)$/;

// Build a stable selector for an element, preferring the most robust hook.
// Order: id > data-testid > aria-label > full CSS path.
function generateSelector(el) {
  if (!el || el.nodeType !== 1) return '';

  if (el.id) {
    return '#' + CSS.escape(el.id);
  }

  const testId = el.getAttribute && el.getAttribute('data-testid');
  if (testId) {
    return el.tagName.toLowerCase() + '[data-testid="' + CSS.escape(testId) + '"]';
  }

  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel) {
    return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
  }

  return buildCSSPath(el);
}

// Walk up the tree to <body> building a descendant CSS path.
// An ancestor id short-circuits the walk (ids are unique enough to anchor on).
function buildCSSPath(el) {
  const parts = [];
  let node = el;

  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'body') {
    // An id anchors the path — prepend and stop walking up.
    if (node.id) {
      parts.unshift('#' + CSS.escape(node.id));
      break;
    }

    let segment = node.tagName.toLowerCase();

    // Filter out state classes and cap at 2 stable classes.
    const classes = (node.classList ? Array.from(node.classList) : [])
      .filter((cls) => !STATE_CLASS_RE.test(cls))
      .slice(0, 2);

    for (const cls of classes) {
      segment += '.' + CSS.escape(cls);
    }

    // Disambiguate with nth-of-type when there are multiple same-tag siblings.
    const parent = node.parentNode;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (sib) => sib.tagName === node.tagName
      );
      if (sameTag.length > 1) {
        const index = sameTag.indexOf(node) + 1;
        segment += ':nth-of-type(' + index + ')';
      }
    }

    parts.unshift(segment);
    node = node.parentNode;
  }

  return parts.join(' > ');
}

// Build a positional XPath from the document root to the element.
function generateXPath(el) {
  if (!el || el.nodeType !== 1) return '';

  const parts = [];
  let node = el;

  while (node && node.nodeType === 1) {
    let index = 1;
    let sibling = node.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && sibling.tagName === node.tagName) {
        index++;
      }
      sibling = sibling.previousSibling;
    }

    const tag = node.tagName.toLowerCase();
    parts.unshift(tag + '[' + index + ']');

    node = node.parentNode;
    if (!node || node.nodeType !== 1) break;
  }

  return '/' + parts.join('/');
}
