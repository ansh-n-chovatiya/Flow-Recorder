/**
 * Turning a clicked DOM node into a sentence a human recognises.
 *
 * This is the difference between "Clicked element" and `Clicked "Save changes"`,
 * and it is the most valuable logic in the recorder. Pure functions over an
 * element, so each rule is testable on its own.
 */

const INTERACTIVE_TAGS = new Set(['a', 'button', 'select', 'summary']);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'switch',
  'checkbox',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
]);

/**
 * Lucide icon names → what the button does. An icon-only button has no text, so
 * without this the step reads "Clicked element" and tells nobody anything.
 */
const ICON_NAMES: Record<string, string> = {
  'move-up': 'sort ascending',
  'move-down': 'sort descending',
  'arrow-up': 'sort ascending',
  'arrow-down': 'sort descending',
  'arrow-up-down': 'sort',
  'chevrons-up-down': 'sort',
  'chevron-down': 'expand',
  'chevron-up': 'collapse',
  'chevron-right': 'expand',
  x: 'close',
  trash: 'delete',
  'trash-2': 'delete',
  plus: 'add',
  pencil: 'edit',
  pen: 'edit',
  search: 'search',
  settings: 'settings',
  'sliders-horizontal': 'filters',
  'more-horizontal': 'more options',
  'more-vertical': 'more options',
  eye: 'show',
  'eye-off': 'hide',
  filter: 'filter',
  funnel: 'filter',
  'refresh-cw': 'refresh',
  'rotate-cw': 'refresh',
  play: 'run',
  star: 'favorite',
  download: 'download',
  upload: 'upload',
  copy: 'copy',
  check: 'confirm',
  'external-link': 'open in new tab',
};

/** How far up the tree to look for the real control behind a clicked child. */
const MAX_TARGET_HOPS = 4;

/** Longest label we keep; past this it is a paragraph, not a name. */
const MAX_NAME_LEN = 80;

function isInteractive(el: Element | null): boolean {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'input' || tag === 'textarea') return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return el.hasAttribute('onclick');
}

/**
 * Clicks land on whatever is under the cursor — usually a `<span>` or `<svg>`
 * inside the button. Walk up to the element that actually handles the click.
 */
export function resolveTarget(el: Element): Element {
  if (isInteractive(el)) return el;
  let node = el.parentElement;
  let hops = 0;
  while (node && node.nodeType === 1 && hops < MAX_TARGET_HOPS) {
    if (node.tagName.toLowerCase() === 'body') break;
    if (isInteractive(node)) return node;
    node = node.parentElement;
    hops++;
  }
  return el;
}

export function iconName(el: Element): string {
  const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
  const cls = svg?.getAttribute('class') ?? '';
  const match = /lucide-([a-z0-9-]+)/i.exec(cls);
  if (!match) return '';
  const key = match[1].toLowerCase();
  return ICON_NAMES[key] ?? key.replace(/-/g, ' ');
}

function textOf(el: Element): string {
  // `value` exists on inputs and a handful of other elements; typing it here
  // beats narrowing at four call sites.
  const node = el as HTMLElement & { value?: string };
  return node.innerText?.trim() || node.value?.trim() || '';
}

/** The name a screen reader would announce, by roughly the same precedence. */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim().slice(0, MAX_NAME_LEN);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const ref = el.ownerDocument.getElementById(labelledby);
    const refText = ref?.innerText?.trim();
    if (refText) return refText.slice(0, MAX_NAME_LEN);
  }

  const text = textOf(el);
  if (text) return text.slice(0, MAX_NAME_LEN);

  for (const attr of ['title', 'alt'] as const) {
    const value = el.getAttribute(attr);
    if (value?.trim()) return value.trim().slice(0, MAX_NAME_LEN);
  }

  const icon = iconName(el);
  if (icon) return icon;

  // A cell in a table has no name of its own; its column header is the next
  // best thing, and is usually what the user would call it.
  const th = el.closest('th');
  const thText = (th as HTMLElement | null)?.innerText?.trim();
  if (thText) return thText.slice(0, 40);

  return '';
}

/** Visible text for an element, falling back through the usual label attributes. */
export function getElementText(el: Element): string {
  const node = el as HTMLElement & { value?: string };
  const text =
    node.innerText?.trim() ||
    node.value?.trim() ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    '';
  return text.trim().slice(0, MAX_NAME_LEN);
}

/** The label a person would use for a form field. */
export function getElementLabel(el: Element): string {
  const labelled = el as HTMLInputElement;
  const firstLabel = labelled.labels?.[0]?.innerText?.trim();
  if (firstLabel) return firstLabel;

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;

  if (el.id) {
    const forLabel = el.ownerDocument.querySelector<HTMLElement>(
      `label[for="${CSS.escape(el.id)}"]`,
    );
    const forText = forLabel?.innerText?.trim();
    if (forText) return forText;
  }

  return getElementText(el) || el.tagName.toLowerCase();
}

function toggleState(el: Element): string | null {
  const checked = el.getAttribute('aria-checked');
  if (checked === 'true') return 'on';
  if (checked === 'false') return 'off';
  const input = el as HTMLInputElement;
  if (el.tagName.toLowerCase() === 'input' && input.type === 'checkbox') {
    return input.checked ? 'on' : 'off';
  }
  return null;
}

export interface DescribedTarget {
  /** The control that was really clicked, which may be an ancestor of the node. */
  el: Element;
  /** One sentence in the past tense, e.g. `Clicked "Save" (confirm)`. */
  action: string;
}

/** Resolve the real target of a click and describe what the user just did. */
export function describeTarget(rawEl: Element): DescribedTarget {
  const el = resolveTarget(rawEl);
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const input = el as HTMLInputElement;
  const name = accessibleName(el);
  const quoted = name ? ` "${name}"` : '';

  if (role === 'switch' || role === 'checkbox' || (tag === 'input' && input.type === 'checkbox')) {
    const state = toggleState(el);
    return { el, action: `Toggled${quoted || ' control'}${state ? ` → ${state}` : ''}` };
  }

  if (tag === 'a' || role === 'link') return { el, action: `Clicked link${quoted}` };
  if (tag === 'select') return { el, action: `Opened dropdown${quoted}` };

  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'submit') return { el, action: `Clicked submit${quoted}` };
    if (type === 'radio') return { el, action: `Selected${quoted}` };
  }

  const icon = iconName(el);
  if (name) {
    // Only append the icon when it says something the name does not.
    const suffix = icon && icon !== name && !name.toLowerCase().includes(icon) ? ` (${icon})` : '';
    return { el, action: `Clicked "${name}"${suffix}` };
  }
  if (icon) return { el, action: `Clicked "${icon}"` };
  return { el, action: 'Clicked element' };
}
