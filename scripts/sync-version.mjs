/**
 * Copies the version from package.json into public/manifest.json.
 *
 * package.json is the single source of truth; `npm version` bumps it and this
 * runs as the `version` lifecycle hook, so the two files cannot drift. CI checks
 * the same invariant, in case someone edits a version by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'public/manifest.json');

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.version === version) {
  console.log(`manifest.json already at ${version}`);
} else {
  console.log(`manifest.json ${manifest.version} → ${version}`);
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
