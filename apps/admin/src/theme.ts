/**
 * Theme store — applies `data-theme="light|dark"` to <html> and persists the
 * mode to localStorage. Two modes only (no "follow system") — the toggle has
 * no label so adding a third state the user has to infer is bad UX.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'trail.admin.theme';
const DEFAULT: Theme = 'light';

const listeners = new Set<(theme: Theme) => void>();

function readStored(): Theme {
  if (typeof localStorage === 'undefined') return DEFAULT;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'dark' ? 'dark' : 'light';
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

export function toggleTheme(): Theme {
  setTheme(current === 'light' ? 'dark' : 'light');
  return current;
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
