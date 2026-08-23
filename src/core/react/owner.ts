/**
 * Choosing which component in a chain a click actually belongs to.
 *
 * The nearest component fiber is usually not the one anybody means. Clicking a
 * MUI button lands on `ButtonBase`; clicking a Radix item lands on
 * `Primitive.div`. The useful answer is the nearest component the *user owns*.
 *
 * Two signals say so, and they arrive at different times: the name is known at
 * capture and is a heuristic that says nothing on a minified build, while a
 * resolved path inside `node_modules` is definitive and only exists after the
 * resolver has run. So this is a pure function over the finished table, called
 * at export time — storing an owner on the step would freeze a decision made
 * before the evidence for it existed.
 *
 * Pure — no DOM, no Chrome.
 */

import type { ComponentSource } from '../../shared/types.js';
import { classifyComponent } from './classify.js';

/**
 * The component id a step should be attributed to, or null.
 *
 * `chain` is outermost first, as stored, so this walks it backwards: the
 * innermost component that qualifies wins at every tier.
 *
 * Tiers, in order:
 *
 *   1. Resolved to a file outside `node_modules` — the real answer, and the only
 *      one backed by evidence rather than by a name.
 *   2. Not recognisable as plumbing by name. Weaker, but it is all there is
 *      before the resolver has finished, and all there is on a bundle with no
 *      source maps.
 *   3. Anything named at all, so a chain of nothing but providers still says
 *      *something* about where the click landed.
 *   4. Null. Rendering nothing beats rendering something wrong.
 */
export function pickOwner(
  chain: string[],
  components: Record<string, ComponentSource>,
): string | null {
  let notPlumbing: string | null = null;
  let anyNamed: string | null = null;

  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i];
    const component = components[id];
    if (!component) continue;

    if (component.status === 'resolved' && component.dependency !== true) return id;

    if (notPlumbing === null) {
      const category = classifyComponent(component.name, component.source);
      if (category === 'unknown') notPlumbing = id;
    }

    if (anyNamed === null && component.name) anyNamed = id;
  }

  return notPlumbing ?? anyNamed;
}
