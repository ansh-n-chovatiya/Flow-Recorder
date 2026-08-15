/**
 * Zips dist/ into releases/.
 *
 * The same script runs locally and in CI, so a zip you build on your machine is
 * the zip the workflow publishes. Only dist/ goes in — no source, no config, no
 * lockfile — because the archive is meant to be unzipped and loaded unpacked.
 *
 *   node scripts/package.mjs            → releases/flowsnap-1.0.0.zip
 *   node scripts/package.mjs --sha abc  → releases/flowsnap-1.0.0-abc.zip
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const releases = resolve(root, 'releases');

if (!existsSync(resolve(dist, 'manifest.json'))) {
  console.error('No dist/manifest.json — run `npm run build` first.');
  process.exit(1);
}

const shaIndex = process.argv.indexOf('--sha');
const sha = shaIndex === -1 ? null : process.argv[shaIndex + 1]?.slice(0, 7);

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const name = sha ? `flowsnap-${version}-${sha}.zip` : `flowsnap-${version}.zip`;
const out = resolve(releases, name);

mkdirSync(releases, { recursive: true });
rmSync(out, { force: true });

// -r recurse, -q quiet, -X drop extended attributes so the archive is
// reproducible across machines.
execFileSync('zip', ['-qrX', out, '.'], { cwd: dist, stdio: 'inherit' });

console.log(`releases/${name}`);
