/**
 * Stable identity for a component, so the same one clicked forty times is
 * resolved once.
 *
 * The id is a hash of the display name and the head of the component's compiled
 * source. Both matter: source alone collides across components a bundler
 * emitted identically, and the name alone is worthless on a minified build
 * where every component is called `e`.
 *
 * Pure — no DOM, no Chrome.
 */

/** How much of the function source feeds the hash. Matches the head needle. */
const HASH_SOURCE_LEN = 200;

const FNV_PRIME = 0x01000193;
const SEED_A = 0x811c9dc5;
/** A second, unrelated seed. Two 32-bit passes give 40 usable bits (see below). */
const SEED_B = 0x7f4a7c15;

/** FNV-1a, 32-bit, seeded. */
export function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A 40-bit id, as 10 hex characters.
 *
 * 32 bits would be the obvious choice and is *probably* fine, but a collision
 * here is not a cosmetic bug — two different components would share one
 * resolution and the flow would name the wrong file, which is worse than naming
 * none. A second seeded pass costs one more sweep of 200 characters and drops
 * the odds across a whole flow from roughly one in a million to one in a
 * hundred million.
 */
export function componentId(name: string, fnSource: string): string {
  const material = `${name}|${fnSource.slice(0, HASH_SOURCE_LEN)}`;
  const a = fnv1a(material, SEED_A);
  const b = fnv1a(material, SEED_B);
  return a.toString(16).padStart(8, '0') + (b & 0xff).toString(16).padStart(2, '0');
}

/**
 * Id for a component whose source could not be read at all — an unsettled lazy
 * component, or a native function. Name-only, and marked so it is never mistaken
 * for something the resolver could have found and failed to.
 */
export function nameOnlyId(name: string): string {
  return `n${fnv1a(name, SEED_A).toString(16).padStart(8, '0')}`;
}

/** True for an id produced by `nameOnlyId` — there is no needle to resolve. */
export function isNameOnly(id: string): boolean {
  return id.startsWith('n');
}
