/**
 * Turning a captured needle into the file somebody wrote.
 *
 * This is stage B of the three (plan §1): it runs in the service worker, on
 * idle, decoupled from capture on purpose. A step is never delayed, degraded or
 * lost because a bundle was slow or a source map 404'd — the worst this can do
 * is leave a component with its name and a sentence saying why there is no path.
 *
 * Four properties it has to keep:
 *
 *   - **Idempotent.** An MV3 worker is killed whenever Chrome likes. Anything
 *     unfinished stays `pending` with its needle in storage, and the next
 *     trigger picks it up exactly where this one stopped.
 *   - **Bounded.** Every component gets at most one search per inventory
 *     generation, fetches are capped by size and concurrency, and a pass stops
 *     at a deadline. A pathological site costs a fixed amount and then stops.
 *   - **Honest.** Every outcome that is not a resolved path carries a status and
 *     one sentence saying why. There is no silent omission anywhere in here.
 *   - **Invisible to the recording.** These fetches come from the worker, so the
 *     page's patched `fetch`/`XHR` never see them and FlowSnap cannot end up
 *     recording itself.
 */

import { fetchText as fetchTextViaChrome } from '../../chrome/fetch.js';
import { isDependencyPath } from '../../core/react/classify.js';
import { searchBundle, countOccurrences } from '../../core/react/search.js';
import {
  extractSourceMappingURL,
  decodeDataUrl,
  lookupOriginal,
  parseSourceMap,
  SourceMapError,
  type PreparedMap,
} from '../../core/react/sourcemap.js';
import { isAbsolutePath } from '../../core/react/table.js';
import {
  BUNDLE_CACHE_BYTES,
  BUNDLE_CACHE_ENTRIES,
  MAX_MAP_BYTES,
  MAX_MATCHES_TRACKED,
  MAX_RESOLVE_MS_PER_FLOW,
  MAX_RESOURCE_BYTES,
  RESOLVE_CONCURRENCY,
} from '../../shared/constants.js';
import type { ComponentNeedle, ComponentSource } from '../../shared/types.js';
import { scriptsForPage } from './inventory.js';

/** Everything the resolver touches outside itself, so tests need no browser. */
export interface ResolveDeps {
  fetchText(url: string, maxBytes: number): Promise<{ ok: true; value: string } | { ok: false }>;
  now(): number;
}

const defaultDeps: ResolveDeps = {
  fetchText: fetchTextViaChrome,
  now: () => Date.now(),
};

export interface ResolveInput {
  components: Record<string, ComponentSource>;
  needles: Record<string, ComponentNeedle>;
  scripts: Record<string, string[]>;
  /**
   * No further trigger will follow — the recording has stopped, or the flow is
   * being sent. Anything still unattempted is reported as `skipped` rather than
   * left saying `pending`, which would read as "still working" forever.
   */
  final: boolean;
  /**
   * Resolution is switched off in settings. Nothing is fetched and nothing is
   * searched; the final pass says so, so a reader sees a reason rather than a
   * component that looks unresolvable.
   *
   * Needles are left in place until that final pass, which is what lets someone
   * who switches the setting back on mid-recording still get their paths.
   */
  disabled?: boolean;
}

export interface ResolveOutput {
  components: Record<string, ComponentSource>;
  needles: Record<string, ComponentNeedle>;
  /** False when nothing moved, so the caller can skip the storage write. */
  changed: boolean;
}

// ── Caches ───────────────────────────────────────────────────────────────────
//
// Worker-lived and keyed by URL. The bundle cache is what makes resolving the
// eighth component nearly free: it is the same four bundles as the first.

const bundleCache = new Map<string, string>();
let bundleCacheBytes = 0;

/** In-flight fetches, so four components racing for one bundle fetch it once. */
const bundleInflight = new Map<string, Promise<string | null>>();

/** Parsed maps, and the failures — a map that will not parse must not be re-parsed. */
const mapCache = new Map<string, PreparedMap | null>();

export function clearResolverCaches(): void {
  bundleCache.clear();
  bundleCacheBytes = 0;
  bundleInflight.clear();
  mapCache.clear();
}

/** Evicts oldest-first until the cache is back inside both of its limits. */
function trimBundleCache(): void {
  for (const [url, text] of bundleCache) {
    if (bundleCache.size <= BUNDLE_CACHE_ENTRIES && bundleCacheBytes <= BUNDLE_CACHE_BYTES) return;
    bundleCache.delete(url);
    bundleCacheBytes -= text.length;
  }
}

function loadBundle(url: string, deps: ResolveDeps): Promise<string | null> {
  const cached = bundleCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = bundleInflight.get(url);
  if (pending) return pending;

  const promise = deps
    .fetchText(url, MAX_RESOURCE_BYTES)
    .then((result) => {
      if (!result.ok) return null;
      bundleCache.set(url, result.value);
      bundleCacheBytes += result.value.length;
      trimBundleCache();
      return result.value;
    })
    .finally(() => bundleInflight.delete(url));

  bundleInflight.set(url, promise);
  return promise;
}

// ── Resolving one component ──────────────────────────────────────────────────

/** Why a bundle search ended without a position. */
type SearchFailure = 'not-found' | 'unfetchable';

interface SearchSuccess {
  url: string;
  line: number;
  column: number;
  matchCount: number;
  content: string;
}

/**
 * Walks the page's bundles in load order until the needle hits.
 *
 * Once it has, the remaining bundles are still scanned for the same text —
 * purely to find out whether the answer is ambiguous. A component whose code
 * was inlined into three chunks has three equally true positions, and reporting
 * one of them as fact would be the kind of confident wrong answer this feature
 * exists to remove.
 */
async function searchForNeedle(
  needle: ComponentNeedle,
  urls: string[],
  deps: ResolveDeps,
  deadline: number,
): Promise<SearchSuccess | SearchFailure> {
  let hit: SearchSuccess | null = null;
  let anyLoaded = false;

  for (const url of urls) {
    if (deps.now() > deadline) break;

    const content = await loadBundle(url, deps);
    if (!content) continue;
    anyLoaded = true;

    if (hit) {
      hit.matchCount += countOccurrences(
        content,
        needle.head,
        MAX_MATCHES_TRACKED - hit.matchCount,
      );
      if (hit.matchCount >= MAX_MATCHES_TRACKED) break;
      continue;
    }

    const found = searchBundle(content, needle);
    if (found) {
      hit = {
        url,
        line: found.line,
        column: found.column,
        matchCount: found.matchCount,
        content,
      };
      if (hit.matchCount >= MAX_MATCHES_TRACKED) break;
    }
  }

  if (hit) return hit;
  return anyLoaded ? 'not-found' : 'unfetchable';
}

/** Fetches and parses a bundle's map. Null means the bundle ships none. */
async function loadMap(
  bundleUrl: string,
  bundleContent: string,
  deps: ResolveDeps,
): Promise<PreparedMap | null> {
  const cached = mapCache.get(bundleUrl);
  if (cached !== undefined) return cached;

  const annotation = extractSourceMappingURL(bundleContent);
  if (!annotation) {
    mapCache.set(bundleUrl, null);
    return null;
  }

  let json: string;

  if (annotation.startsWith('data:')) {
    // Inlined by the bundler — no request, and no size guard needed beyond the
    // one the bundle itself already passed.
    json = decodeDataUrl(annotation);
  } else {
    let mapUrl: string;
    try {
      mapUrl = new URL(annotation, bundleUrl).toString();
    } catch {
      throw new SourceMapError(`the sourceMappingURL "${annotation}" is not a resolvable URL`);
    }

    const fetched = await deps.fetchText(mapUrl, MAX_MAP_BYTES);
    if (!fetched.ok) {
      throw new SourceMapError('its source map could not be fetched — it may be 404 or private');
    }
    json = fetched.value;
  }

  const map = parseSourceMap(json);
  mapCache.set(bundleUrl, map);
  return map;
}

/** One component, start to finish. Never throws — every failure is a status. */
async function resolveOne(
  entry: ComponentSource,
  needle: ComponentNeedle,
  urls: string[],
  deps: ResolveDeps,
  deadline: number,
): Promise<{ source: ComponentSource; retryAfter?: number }> {
  const name = entry.name;

  if (urls.length === 0) {
    return {
      source: {
        name,
        status: 'not-found',
        detail: 'No script bundles were seen loading on that page, so there was nothing to search.',
      },
      retryAfter: 0,
    };
  }

  const found = await searchForNeedle(needle, urls, deps, deadline);

  if (found === 'unfetchable') {
    return {
      source: {
        name,
        status: 'unfetchable',
        detail: "None of the page's script bundles could be read, so its source was never searched.",
      },
      // A bundle that would not load once may load on the next pass.
      retryAfter: 0,
    };
  }

  if (found === 'not-found') {
    return {
      source: {
        name,
        status: 'not-found',
        detail: `Not found in the ${urls.length} script${urls.length === 1 ? '' : 's'} the page had loaded — most likely a lazy chunk that was never fetched.`,
      },
      // Worth another look, but only once the page has loaded more scripts.
      retryAfter: urls.length,
    };
  }

  const compiled = { url: found.url, line: found.line + 1, column: found.column + 1 };
  const ambiguous = found.matchCount > 1;
  const ambiguityNote = ambiguous
    ? ` The same code appears in ${found.matchCount === MAX_MATCHES_TRACKED ? `${MAX_MATCHES_TRACKED} or more` : found.matchCount} places, so this may not be the right one.`
    : '';

  let map: PreparedMap | null;
  try {
    map = await loadMap(found.url, found.content, deps);
  } catch (error) {
    const reason = error instanceof SourceMapError ? error.message : 'its source map could not be read';
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, but ${reason}. The compiled position is the best available.${ambiguityNote}`,
      },
    };
  }

  if (!map) {
    return {
      source: {
        name,
        status: 'compiled-only',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, which ships no source map, so the original file is unknown.${ambiguityNote}`,
      },
    };
  }

  let original: ReturnType<typeof lookupOriginal>;
  try {
    original = lookupOriginal(map, found.line, found.column);
  } catch (error) {
    const reason = error instanceof SourceMapError ? error.message : 'the source map is unusable';
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, but ${reason}.${ambiguityNote}`,
      },
    };
  }

  if (!original) {
    return {
      source: {
        name,
        status: 'map-error',
        via: 'bundle-search',
        compiled,
        ...(ambiguous ? { matchCount: found.matchCount } : {}),
        detail: `Found in the bundle, but its source map has no mapping covering that position.${ambiguityNote}`,
      },
    };
  }

  const dependency = isDependencyPath(original.source);

  return {
    source: {
      name,
      status: ambiguous ? 'ambiguous' : 'resolved',
      via: 'bundle-search',
      source: original.source,
      line: original.line,
      column: original.column,
      ...(isAbsolutePath(original.source) ? { absolutePath: original.source } : {}),
      ...(dependency ? { dependency: true } : {}),
      compiled,
      ...(ambiguous ? { matchCount: found.matchCount } : {}),
      ...(ambiguous
        ? { detail: `Matched in ${found.matchCount} places; this is the first. The path may be the wrong one.` }
        : {}),
    },
  };
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** Components this pass should attempt, in a stable order. */
function selectPending(input: ResolveInput): string[] {
  const ids: string[] = [];

  for (const [id, needle] of Object.entries(input.needles)) {
    const entry = input.components[id];
    if (!entry) continue;

    if (entry.status === 'pending') {
      ids.push(id);
      continue;
    }

    // A component that was not found is worth searching again only once the
    // page has loaded scripts it has not already been searched against —
    // otherwise every pass would redo the same fruitless scan of every bundle.
    if (entry.status === 'not-found' || entry.status === 'unfetchable') {
      const available = scriptsForPage(input.scripts, needle.pageUrl).length;
      if (available > (needle.searched ?? 0)) ids.push(id);
    }
  }

  return ids.sort();
}

/**
 * Resolves everything pending, or as much of it as the budget allows.
 *
 * The deadline is per pass rather than per flow. Cumulative time across passes
 * cannot be tracked without persisting it through worker deaths, and it does not
 * need to be: a pass only ever retries a component when the inventory has grown
 * under it, so the work is bounded by what the page actually loads.
 */
export async function resolvePending(
  input: ResolveInput,
  deps: ResolveDeps = defaultDeps,
): Promise<ResolveOutput> {
  const components = { ...input.components };
  const needles = { ...input.needles };

  const ids = input.disabled ? [] : selectPending(input);
  if (ids.length === 0) {
    return finish(components, needles, input, false);
  }

  const deadline = deps.now() + MAX_RESOLVE_MS_PER_FLOW;
  let changed = false;
  let next = 0;

  const workers = Array.from({ length: Math.min(RESOLVE_CONCURRENCY, ids.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      if (deps.now() > deadline) return;

      const id = ids[index];
      const needle = needles[id];
      const entry = components[id];
      if (!needle || !entry) continue;

      const urls = scriptsForPage(input.scripts, needle.pageUrl);

      let outcome: { source: ComponentSource; retryAfter?: number };
      try {
        outcome = await resolveOne(entry, needle, urls, deps, deadline);
      } catch (error) {
        // A bug in here must cost one component its path, not the whole pass.
        outcome = {
          source: {
            name: entry.name,
            status: 'map-error' as const,
            detail: `Resolution failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }

      components[id] = outcome.source;
      changed = true;

      if (outcome.retryAfter === undefined) {
        // A terminal answer. The needle is 200 characters of the site's own
        // source and has now done its only job, so it goes.
        delete needles[id];
      } else {
        // `searched` records the inventory size this answer was reached with, so
        // the next pass can tell "already looked everywhere" from "the page has
        // loaded more since". Zero means retry unconditionally.
        needles[id] = { ...needle, searched: outcome.retryAfter };
      }
    }
  });

  await Promise.all(workers);

  return finish(components, needles, input, changed);
}

/**
 * On the last pass, says plainly what was left over.
 *
 * A component still reading `pending` after the flow has been sent is a lie by
 * omission — nothing is going to happen next. `skipped` plus a sentence tells
 * whoever reads the flow that the name is all there is and why.
 */
function finish(
  components: Record<string, ComponentSource>,
  needles: Record<string, ComponentNeedle>,
  input: ResolveInput,
  changed: boolean,
): ResolveOutput {
  if (!input.final) return { components, needles, changed };

  let touched = changed;

  const detail = input.disabled
    ? 'Finding source files is switched off in FlowSnap settings.'
    : 'The flow finished before this component could be looked up.';

  for (const [id, entry] of Object.entries(components)) {
    if (entry.status !== 'pending') continue;
    components[id] = {
      name: entry.name,
      status: 'skipped',
      detail,
    };
    delete needles[id];
    touched = true;
  }

  return { components, needles, changed: touched };
}
