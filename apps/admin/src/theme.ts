/**
 * Theme store — applies a `data-theme` attribute to <html> and persists the
 * chosen mode to localStorage. Three modes:
 *
 *   light → Bauhaus palette (warm off-white + warm charcoal + amber)
 *   dark  → warm inversion
 *   auto  → follows prefers-color-scheme
 *
 * Consumers import `initTheme()` once at boot, `getTheme()` to read current,
 * and `setTheme(mode)` to change. `onThemeChange(listener)` subscribes to
 * changes for e.g. re-rendering a toggle button.
 */

export type Theme = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'trail.admin.theme';
const DEFAULT: Theme = 'auto';

const listeners = new Set<(theme: Theme) => void>();

function readStored(): Theme {
  if (typeof localStorage === 'undefined') return DEFAULT;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  return DEFAULT;
}

function apply(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

let current: Theme = DEFAULT;

export function initTheme(): void {
  current = readStored();
  apply(current);
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  apply(theme);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, theme);
  }
  for (const listener of listeners) listener(theme);
}

export function cycleTheme(): Theme {
  // light → dark → auto → light → …
  const next: Theme = current === 'light' ? 'dark' : current === 'dark' ? 'auto' : 'light';
  setTheme(next);
  return next;
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Returns the effective resolved theme for the current moment — useful for
 * code that needs to branch on light vs dark (e.g. choosing an image variant)
 * without caring about whether the user picked auto.
 */
export function resolvedTheme(): 'light' | 'dark' {
  if (current === 'light' || current === 'dark') return current;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}
