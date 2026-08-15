import { describe, expect, it } from 'vitest';
import { buildSchema, compactBody, inferType } from '../src/core/schema/index.js';
import { SCHEMA_THRESHOLD } from '../src/shared/constants.js';

describe('inferType', () => {
  it('distinguishes integers from floats', () => {
    expect(inferType(3, 2, null)).toBe('integer');
    expect(inferType(3.5, 2, null)).toBe('number');
  });

  it('shows short strings literally and long ones as a type', () => {
    expect(inferType('ok', 2, null)).toBe('"ok"');
    expect(inferType('x'.repeat(31), 2, null)).toBe('string');
  });

  it('collapses a small set of sibling values into a union', () => {
    const siblings = ['open', 'closed', 'open', 'pending'];
    expect(inferType('open', 2, siblings)).toBe('"open" | "closed" | "pending"');
  });

  it('gives up on a union once the sibling set is too wide to be an enum', () => {
    const siblings = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(inferType('a', 2, siblings)).toBe('"a"');
  });

  it('does not treat long sibling values as enum members', () => {
    const siblings = ['x'.repeat(40), 'y'.repeat(40)];
    expect(inferType('x'.repeat(40), 2, siblings)).toBe('string');
  });

  it('reports array length and element type', () => {
    expect(inferType([1, 2, 3], 2, null)).toBe('Array(3) of integer');
    expect(inferType([], 2, null)).toBe('Array(0)');
  });

  it('stops recursing at the depth limit', () => {
    expect(inferType({ a: 1 }, 0, null)).toBe('{...}');
  });
});

describe('buildSchema', () => {
  it('describes an array of objects from its first element', () => {
    const schema = buildSchema([
      { id: 1, status: 'open' },
      { id: 2, status: 'closed' },
    ]);
    expect(schema).toContain('Array(2) of');
    expect(schema).toContain('id: integer');
    expect(schema).toContain('status: "open" | "closed"');
  });

  it('summarises the tail of a wide object', () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(buildSchema(wide)).toContain('// +5 more fields');
  });
});

describe('compactBody', () => {
  it('passes through anything under the threshold', () => {
    const small = JSON.stringify({ a: 1 });
    expect(compactBody(small)).toBe(small);
  });

  it('replaces a large JSON body with a schema', () => {
    const big = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row ${i}` })));
    expect(big.length).toBeGreaterThan(SCHEMA_THRESHOLD);

    const out = compactBody(big) ?? '';
    expect(out).toContain('[schema —');
    expect(out).toContain('id: integer');
    expect(out.length).toBeLessThan(big.length);
  });

  it('truncates a large non-JSON body rather than dropping it', () => {
    const out = compactBody('x'.repeat(SCHEMA_THRESHOLD + 1)) ?? '';
    expect(out).toContain('[non-JSON');
    expect(out).toContain('truncated]');
  });

  it('truncates when the body only looks like JSON', () => {
    const out = compactBody(`{not really json${'!'.repeat(SCHEMA_THRESHOLD)}`) ?? '';
    expect(out).toContain('[non-JSON');
  });

  it('leaves empty and missing bodies alone', () => {
    expect(compactBody('')).toBe('');
    expect(compactBody(null)).toBeNull();
    expect(compactBody(undefined)).toBeUndefined();
  });
});
