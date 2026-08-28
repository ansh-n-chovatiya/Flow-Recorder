import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories containing ported files. */
const SCAN_DIRS = ['src'];

/** Pattern matching source provenance annotations. */
const PROVENANCE =
  /(?:back-)?ported from ([\w.-]+) `([^`]+)` @ ([0-9a-f]{7,40})/gi;

const args = process.argv.slice(2);
const shouldFetch = args.includes('--fetch');

/** Sibling repository path overrides from CLI options. */
const overrides = new Map();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--sibling') continue;
  const [name, path] = (args[i + 1] ?? '').split('=');
  if (name && path) overrides.set(name, resolve(path));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Normalizes source comments to parse provenance headers across line breaks. */
function unwrap(source) {
  return source.replace(/^\s*\*+ ?/gm, ' ').replace(/\s+/g, ' ');
}

const ported = [];
for (const dir of SCAN_DIRS) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const file of walk(full)) {
    const text = unwrap(readFileSync(file, 'utf8'));
    // A module may contain multiple provenance declarations.
    for (const match of text.matchAll(PROVENANCE)) {
      const [, repo, path, sha] = match;
      const relative = file.slice(ROOT.length + 1);
      if (
        ported.some(
          (e) => e.file === relative && e.path === path && e.sha === sha,
        )
      )
        continue;
      ported.push({ file: relative, repo, path, sha });
    }
  }
}

if (ported.length === 0) {
  console.log('No ported files found — nothing to compare.');
  process.exit(0);
}

function git(cwd, ...gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim();
}

/** Determines if a commit only updated provenance header annotations. */
function isProvenanceOnly(cwd, sha, path) {
  let diff;
  try {
    diff = git(cwd, 'show', '--format=', '--unified=0', sha, '--', path);
  } catch {
    return false;
  }

  const changed = diff
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .map((line) => line.slice(1).trim());

  if (changed.length === 0) return false;

  return changed.every((line) => {
    PROVENANCE.lastIndex = 0;
    return line === '' || PROVENANCE.test(line.replace(/^\*+ ?/, ''));
  });
}

const byRepo = new Map();
for (const entry of ported) {
  if (!byRepo.has(entry.repo)) byRepo.set(entry.repo, []);
  byRepo.get(entry.repo).push(entry);
}

let drifted = 0;
let skipped = 0;

for (const [repo, entries] of byRepo) {
  const sibling = overrides.get(repo) ?? resolve(ROOT, '..', repo);

  if (!existsSync(join(sibling, '.git'))) {
    console.log(`- ${repo}: no checkout at ${sibling} — skipped.`);
    console.log(
      `  Clone it beside this repo, or pass --sibling ${repo}=<path>.`,
    );
    skipped += entries.length;
    continue;
  }

  if (shouldFetch) {
    try {
      git(sibling, 'fetch', '--quiet');
    } catch {
      console.log(
        `- ${repo}: fetch failed, comparing against what is checked out.`,
      );
    }
  }

  console.log(`\n${repo}  (${sibling})`);

  for (const entry of entries) {
    let commits = '';
    try {
      git(sibling, 'cat-file', '-e', `${entry.sha}^{commit}`);
    } catch {
      console.log(`  ? ${entry.file}`);
      console.log(
        `      header names ${entry.sha}, which this checkout does not have.`,
      );
      console.log('      Fetch the sibling, or fix the header.');
      drifted++;
      continue;
    }

    try {
      commits = git(
        sibling,
        'log',
        '--format=%h %s',
        `${entry.sha}..HEAD`,
        '--',
        entry.path,
      )
        .split('\n')
        .filter(
          (line) =>
            line && !isProvenanceOnly(sibling, line.split(' ')[0], entry.path),
        )
        .join('\n');
    } catch {
      commits = '';
    }

    if (!commits) {
      console.log(`  ok ${entry.file}`);
      continue;
    }

    drifted++;
    console.log(`  ! ${entry.file}`);
    console.log(`      from ${entry.path} @ ${entry.sha}`);
    for (const line of commits.split('\n')) console.log(`      ${line}`);
  }
}

console.log('');

if (drifted > 0) {
  console.log(`${drifted} file${drifted === 1 ? '' : 's'} to review.`);
  console.log(
    'Check both copies before changing anything: some of these',
  );
  console.log('differences are deliberate and must not be back-ported.');
  console.log(
    'Once reviewed, bump the @ sha in the header to what you looked at.',
  );
  process.exit(1);
}

if (skipped > 0) {
  console.log(
    `${skipped} file${skipped === 1 ? '' : 's'} could not be checked.`,
  );
  process.exit(0);
}

console.log('Every ported file is level with its source.');
