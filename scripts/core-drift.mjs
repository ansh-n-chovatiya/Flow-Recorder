#!/usr/bin/env node
/**
 * Reports which ported files have moved on in the repo they came from.
 *
 * This project and its sibling share six files by copy, not by package — see
 * `docs/SHARED-CORE.md` for why. What keeps that honest is the provenance line
 * every ported file carries:
 *
 *     Ported from react-source-locator `src/core/vlq.ts` @ 6eb7a30.
 *     Back-ported from Flow-Recorder `src/core/react/needle.ts` @ 3dc9bef.
 *
 * This reads that line out of each file and asks the sibling checkout what has
 * landed on that path since. Anything it prints is a commit somebody should at
 * least look at before deciding it does not apply here.
 *
 * A dev tool, not a CI gate: it needs the sibling repo checked out next to this
 * one, and it exits 0 with a note when that is not the case. `--fetch` runs a
 * `git fetch` in the sibling first, in case a commit was pushed but not pulled.
 *
 * Usage:  npm run core:drift  [-- --fetch]  [-- --sibling <name>=<path>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where ported files live. Everything else is this repo's own. */
const SCAN_DIRS = ['src'];

/**
 * `Ported from <repo> `<path>` @ <sha>` — the `Back-` prefix is the same fact in
 * the other direction. Matched against the comment block with its leading ` * `
 * decoration stripped, so a line that wrapped still parses.
 */
const PROVENANCE = /(?:back-)?ported from ([\w.-]+) `([^`]+)` @ ([0-9a-f]{7,40})/gi;

const args = process.argv.slice(2);
const shouldFetch = args.includes('--fetch');

/** `--sibling name=path`, for a checkout that is not `../name`. */
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

/**
 * The whole file with comment decoration stripped and wrapping undone, so a
 * provenance line parses wherever it sits — a file header, or the doc comment
 * of the one function that was ported into an otherwise local module.
 */
function unwrap(source) {
  return source.replace(/^\s*\*+ ?/gm, ' ').replace(/\s+/g, ' ');
}

const ported = [];
for (const dir of SCAN_DIRS) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const file of walk(full)) {
    const text = unwrap(readFileSync(file, 'utf8'));
    // A module can carry more than one: a local file with one ported function
    // names a different source than the file it lives in.
    for (const match of text.matchAll(PROVENANCE)) {
      const [, repo, path, sha] = match;
      const relative = file.slice(ROOT.length + 1);
      if (ported.some((e) => e.file === relative && e.path === path && e.sha === sha)) continue;
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
    console.log(`  Clone it beside this repo, or pass --sibling ${repo}=<path>.`);
    skipped += entries.length;
    continue;
  }

  if (shouldFetch) {
    try {
      git(sibling, 'fetch', '--quiet');
    } catch {
      console.log(`- ${repo}: fetch failed, comparing against what is checked out.`);
    }
  }

  console.log(`\n${repo}  (${sibling})`);

  for (const entry of entries) {
    let commits = '';
    try {
      git(sibling, 'cat-file', '-e', `${entry.sha}^{commit}`);
    } catch {
      console.log(`  ? ${entry.file}`);
      console.log(`      header names ${entry.sha}, which this checkout does not have.`);
      console.log('      Fetch the sibling, or fix the header.');
      drifted++;
      continue;
    }

    try {
      commits = git(sibling, 'log', '--oneline', `${entry.sha}..HEAD`, '--', entry.path);
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
  console.log('Read docs/SHARED-CORE.md before copying anything: some of these');
  console.log('differences are deliberate and must not be back-ported.');
  console.log('Once reviewed, bump the @ sha in the header to what you looked at.');
  process.exit(1);
}

if (skipped > 0) {
  console.log(`${skipped} file${skipped === 1 ? '' : 's'} could not be checked.`);
  process.exit(0);
}

console.log('Every ported file is level with its source.');
