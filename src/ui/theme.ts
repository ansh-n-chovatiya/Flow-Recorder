/**
 * Theme preference: read it, apply it, keep every open surface in step.
 *
 * The preference is canonically in `chrome.storage.sync` so it follows the user
 * between machines. That store is asynchronous, though, and an extension page
 * cannot run an inline script to beat first paint — the default MV3 policy is
 * `script-src 'self'`. So the choice is mirrored into `localStorage`, which is
 * synchronous and per-profile, and read from there at import time. Sync remains
 * the authority; the mirror only exists to stop an explicit light choice from
 * flashing dark (or the reverse) on a machine whose OS disagrees.
 */

import { getSync, setSync } from '../chrome/storage.js';
import { THEME_MIRROR_KEY } from '../shared/constants.js';
import type { Result } from '../shared/result.js';
import type { ThemePreference } from '../shared/types.js';

export const DEFAULT_THEME: ThemePreference = 'system';

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Narrow untrusted input — storage outlives the code that wrote it. */
export function asTheme(value: unknown): ThemePreference {
  return THEMES.includes(value as ThemePreference) ? (value as ThemePreference) : DEFAULT_THEME;
}

/**
 * `system` deliberately removes the attribute rather than setting it: the token
 * file resolves an unstamped document through `prefers-color-scheme`, and a
 * stamped one always wins over it.
 */
export function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

function readMirror(): ThemePreference {
  try {
    return asTheme(localStorage.getItem(THEME_MIRROR_KEY));
  } catch {
    // Storage can be unavailable when the profile is locked down. Not worth
    // failing a page load over; the sync read a moment later will correct it.
    return DEFAULT_THEME;
  }
}

function writeMirror(theme: ThemePreference): void {
  try {
    localStorage.setItem(THEME_MIRROR_KEY, theme);
  } catch {
    // Same: the mirror is an optimisation, never the source of truth.
  }
}

/** The stored preference, and the mirror brought back into line with it. */
export async function loadTheme(): Promise<ThemePreference> {
  const stored = await getSync({ theme: DEFAULT_THEME });
  const theme = asTheme(stored.ok ? stored.value.theme : readMirror());
  writeMirror(theme);
  return theme;
}

export async function saveTheme(theme: ThemePreference): Promise<Result<void>> {
  // Mirror first: it is what the next page load reads before sync answers.
  writeMirror(theme);
  applyTheme(theme);
  return setSync({ theme });
}

/**
 * Apply the theme as early as the page can, then reconcile.
 *
 * Call at the top of every entry point, before anything renders. Also watches
 * sync, so changing the setting in one tab repaints the popup and the viewer
 * without either of them being reopened.
 */
export function initTheme(): void {
  applyTheme(readMirror());

  void loadTheme().then(applyTheme);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('theme' in changes)) return;
    const next = asTheme(changes.theme?.newValue);
    writeMirror(next);
    applyTheme(next);
  });
}
