/**
 * Synchronizes package.json version across manifest.json and subpackage configurations.
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
