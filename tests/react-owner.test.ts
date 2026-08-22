import { describe, expect, it } from 'vitest';
import { pickOwner } from '../src/core/react/owner.js';
import { classifyComponent, isDependencyPath } from '../src/core/react/classify.js';
import type { ComponentSource } from '../src/shared/types.js';

function resolved(name: string, source: string): ComponentSource {
  return {
    name,
    status: 'resolved',
    via: 'bundle-search',
    source,
    line: 10,
    ...(isDependencyPath(source) ? { dependency: true } : {}),
  };
}

function pending(name: string): ComponentSource {
  return { name, status: 'pending' };
}

describe('pickOwner', () => {
  it('takes the innermost component resolved outside node_modules', () => {
    // Chain is stored outermost first, as it is on the step.
    const table = {
      app: resolved('App', 'src/App.tsx'),
      page: resolved('ProductPage', 'src/routes/ProductPage.tsx'),
      button: resolved('ButtonBase', 'node_modules/@mui/material/ButtonBase.js'),
    };

    expect(pickOwner(['app', 'page', 'button'], table)).toBe('page');
  });

  it('prefers an unresolved component of the user over a resolved dependency', () => {
    // The whole point of the tier order: a path inside node_modules is proof
    // this is not the user's code, and proof beats a resolved-looking answer.
    const table = {
      cart: pending('AddToCartButton'),
      base: resolved('ButtonBase', 'node_modules/@mui/material/ButtonBase.js'),
    };

    expect(pickOwner(['cart', 'base'], table)).toBe('cart');
  });

  it('skips plumbing recognised by name when nothing is resolved', () => {
    const table = {
      router: pending('BrowserRouter'),
      provider: pending('QueryClientProvider'),
      cart: pending('Cart'),
      primitive: pending('Primitive.div'),
    };

    expect(pickOwner(['router', 'provider', 'cart', 'primitive'], table)).toBe('cart');
  });

  it('falls back to the innermost named component rather than nothing', () => {
    const table = {
      router: pending('BrowserRouter'),
      theme: pending('ThemeProvider'),
    };

    // Everything is plumbing, but a step saying "ThemeProvider" still tells the
    // reader more than a step saying nothing at all.
    expect(pickOwner(['router', 'theme'], table)).toBe('theme');
  });

  it('is null when the chain is empty or nothing in it is in the table', () => {
    expect(pickOwner([], {})).toBeNull();
    expect(pickOwner(['gone'], { other: pending('Cart') })).toBeNull();
  });

  it('ignores ids the table no longer has, without losing the rest', () => {
    const table = { cart: resolved('Cart', 'src/Cart.tsx') };
    expect(pickOwner(['pruned', 'cart', 'alsoPruned'], table)).toBe('cart');
  });

  it('does not treat a resolved dependency as plumbing twice over', () => {
    // A dependency that is *not* recognised by name still loses tier 1 on its
    // path, but wins tier 2 — it is the nearest thing to an answer left.
    const table = { widget: resolved('FancyWidget', 'node_modules/fancy/Widget.js') };
    expect(pickOwner(['widget'], table)).toBe('widget');
  });
});

describe('classifyComponent', () => {
  it('lets the name decide before the path', () => {
    // `<Switch>` written in the app's own router file reports the app's file.
    // Trusting that path would exempt every library component an app renders.
    expect(classifyComponent('Switch', 'src/routes/AppRouter.tsx')).toBe('routing');
  });

  it('reads a node_modules path as a dependency when the name says nothing', () => {
    expect(classifyComponent('Widget', 'node_modules/fancy/Widget.js')).toBe('dependency');
  });

  it('never hides an unrecognised component', () => {
    expect(classifyComponent('AddToCartButton', 'src/cart/AddToCartButton.tsx')).toBe('unknown');
    expect(classifyComponent('AddToCartButton')).toBe('unknown');
  });

  it('recognises the wrapper and primitive shapes by pattern', () => {
    expect(classifyComponent('Lazy(Modal)')).toBe('react');
    expect(classifyComponent('Primitive.div')).toBe('styling');
    expect(classifyComponent('CartContext.Provider')).toBe('providers');
  });
});
