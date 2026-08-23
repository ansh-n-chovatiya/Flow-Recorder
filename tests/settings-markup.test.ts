/**
 * The settings controller and settings.html have to agree.
 *
 * Same failure mode `viewer-markup.test.ts` exists for, on the page nothing
 * else covers: `el()` throws on a miss, so a renamed id is a settings page that
 * is blank from the first line of script — and typecheck, lint and every other
 * test in this suite pass regardless.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/settings.html'), 'utf8');
const source = readFileSync(resolve(root, 'src/ui/settings/main.ts'), 'utf8');

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

describe('settings.html answers every lookup the controller makes', () => {
  it('has every element `el()` demands', () => {
    const wanted = [...source.matchAll(/\bel(?:<[^>]*>)?\('([^']+)'\)/g)].map((m) => m[1]);

    expect(wanted.length).toBeGreaterThan(0);
    for (const id of wanted) expect(ids, `#${id}`).toContain(id);
  });

  it('has every element the controller selects by attribute', () => {
    const selectors = [...source.matchAll(/querySelectorAll<[^>]*>\('([^']+)'\)/g)].map(
      (m) => m[1],
    );

    for (const selector of selectors) {
      for (const attribute of [...selector.matchAll(/\[([\w-]+)\]/g)].map((m) => m[1])) {
        expect(html, `[${attribute}]`).toContain(`${attribute}=`);
      }
    }
  });

  it('labels both React switches with the element that names them', () => {
    // A switch is an unlabelled checkbox without this, and the note beside it —
    // the part that says what the setting costs — is invisible to a screenreader.
    for (const id of ['react-capture-label', 'react-resolve-label']) {
      expect(html).toContain(`aria-labelledby="${id}"`);
      expect(ids).toContain(id);
    }
  });
});
