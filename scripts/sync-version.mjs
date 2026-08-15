/**
 * Copies the version from package.json into everything else that carries one.
 *
 * package.json is the single source of truth; `npm version` bumps it and this
 * runs as the `version` lifecycle hook, so the files cannot drift. CI checks the
 * same invariant, in case someone edits a version by hand.
 *
 * The MCP server is published to npm separately from the extension, but from the
 * same tag and at the same number — otherwise "which server matches my
 * extension" needs a table to answer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

for (const file of ['public/manifest.json', 'mcp-server/package.json']) {
  const path = resolve(root, file);
  const json = JSON.parse(readFileSync(path, 'utf8'));

  if (json.version === version) {
    console.log(`${file} already at ${version}`);
    continue;
  }

  console.log(`${file} ${json.version} → ${version}`);
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}
