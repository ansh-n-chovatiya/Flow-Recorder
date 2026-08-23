/**
 * A component's `source` is untrusted text, and the server must keep treating
 * it that way.
 *
 * The string comes from a source map served by whatever page was recorded. It
 * looks exactly like a path — `src/components/Cart.tsx` — which is what makes it
 * dangerous: the obvious next step is to join it to a directory and open it, and
 * a page that emits `../../../.ssh/id_rsa` in its map would then be choosing
 * files on the reader's machine. The flow renders it as text and nothing else.
 *
 * Structural, like tests/react-isolation.test.ts: the guarantee is about what
 * the server never does, and a behavioural test can only cover the cases someone
 * thought of. The behavioural half is that screenshots are still named by index.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(resolve(root, 'mcp-server/server.js'), 'utf8');

/** Every `path.join(...)` / `path.resolve(...)` argument list in the server. */
function pathCalls(source: string): string[] {
  return [...source.matchAll(/path\.(?:join|resolve)\(([^)]*)\)/g)].map((match) => match[1]);
}

describe('the server never builds a filesystem path from page-supplied text', () => {
  it('has no path call mentioning a component field', () => {
    const suspicious = pathCalls(server).filter((args) =>
      /\b(source|absolutePath|compiled|component|react)\b/i.test(args),
    );

    expect(suspicious).toEqual([]);
  });

  it('still names screenshots by index rather than by anything from the page', () => {
    expect(server).toContain('`step-${pad2(i + 1)}.${ext}`');
  });

  it('renders a component location through the one function that only returns text', () => {
    // `componentSource` is a template literal and nothing else. If it ever grows
    // a `path.` call, the line above catches it and this says why it mattered.
    const body = /function componentSource\(component\) \{[\s\S]*?\n\}/.exec(server)?.[0] ?? '';

    expect(body).not.toBe('');
    expect(body).not.toContain('path.');
    expect(body).not.toContain('readFile');
  });
});
