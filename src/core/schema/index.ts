/**
 * Body compaction.
 *
 * A recorded flow can carry megabytes of JSON response bodies. An AI reading the
 * flow needs the *shape* of a response, not 400 rows of it, so bodies over the
 * threshold are replaced with an inferred schema. The viewer keeps the raw body
 * and offers a "Show raw" toggle.
 */

import { SCHEMA_THRESHOLD } from '../../shared/constants.js';

/** Fields shown per object before the rest are summarised as a count. */
const MAX_FIELDS = 25;

/** Sibling values sampled when guessing whether a string field is an enum. */
const ENUM_SAMPLE = 15;

/** A string this long or shorter can be shown literally instead of as `string`. */
const SHORT_STRING = 30;

/**
 * Infer a compact type string for one value. `siblings` holds the same key's
 * values from a parent array, which is what makes enum detection possible.
 */
export function inferType(val: unknown, depth: number, siblings: unknown[] | null): string {
  if (val === null || val === undefined) return 'null';

  const t = typeof val;
  if (t === 'boolean') return 'boolean';
  if (t === 'number') return Number.isInteger(val) ? 'integer' : 'number';

  if (typeof val === 'string') {
    if (siblings?.length) {
      const unique = [
        ...new Set(siblings.filter((v): v is string => typeof v === 'string' && v.length <= SHORT_STRING)),
      ];
      if (unique.length >= 2 && unique.length <= 5) {
        return unique.map((v) => JSON.stringify(v)).join(' | ');
      }
    }
    return val.length <= SHORT_STRING ? JSON.stringify(val) : 'string';
  }

  if (Array.isArray(val)) {
    if (!val.length) return 'Array(0)';
    const first: unknown = val[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first) && depth > 0) {
      return `Array(${val.length}) of ${inferObjectSchema(first as Record<string, unknown>, val, depth - 1)}`;
    }
    return `Array(${val.length}) of ${inferType(first, depth - 1, null)}`;
  }

  if (t === 'object') {
    return depth > 0 ? inferObjectSchema(val as Record<string, unknown>, null, depth) : '{...}';
  }

  return t;
}

/** Infer a schema for one object. `parentArr` supplies siblings for enums. */
export function inferObjectSchema(
  obj: Record<string, unknown>,
  parentArr: unknown[] | null,
  depth: number,
): string {
  if (depth <= 0) return '{...}';

  const entries = Object.entries(obj);
  if (!entries.length) return '{}';

  const shown = entries.slice(0, MAX_FIELDS);
  const omitted = entries.length - shown.length;

  const fields = shown.map(([key, value]) => {
    const siblings = parentArr
      ? parentArr
          .slice(0, ENUM_SAMPLE)
          .map((item) => (item as Record<string, unknown> | null)?.[key])
          .filter((x) => typeof x === 'string')
      : null;
    return `  ${key}: ${inferType(value, depth - 1, siblings)}`;
  });

  if (omitted > 0) fields.push(`  // +${omitted} more fields`);
  return `{\n${fields.join(',\n')}\n}`;
}

/** Produce the schema string for an already-parsed JSON value. */
export function buildSchema(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    if (!parsed.length) return 'Array(0)';
    const first: unknown = parsed[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      return `Array(${parsed.length}) of ${inferObjectSchema(first as Record<string, unknown>, parsed, 3)}`;
    }
    return `Array(${parsed.length}) of ${inferType(first, 2, null)}`;
  }
  return inferType(parsed, 3, null);
}

/**
 * Replace a large body with its schema. Returns the original when it is under
 * the threshold, and falls back to truncation when it is not JSON.
 */
export function compactBody(bodyStr: string | null | undefined): string | null | undefined {
  if (!bodyStr || typeof bodyStr !== 'string') return bodyStr;
  if (bodyStr.length <= SCHEMA_THRESHOLD) return bodyStr;

  const trimmed = bodyStr.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const schema = buildSchema(JSON.parse(trimmed));
      return `[schema — ${(bodyStr.length / 1024).toFixed(1)}KB raw]\n${schema}`;
    } catch {
      // Not valid JSON after all — fall through to truncation.
    }
  }

  return `${trimmed.slice(0, 300)}\n\n[non-JSON · ${(bodyStr.length / 1024).toFixed(1)}KB · truncated]`;
}
