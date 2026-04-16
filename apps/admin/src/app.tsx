import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api } from './api';
import { cycleTheme, getTheme, onThemeChange, type Theme } from './theme';

interface Me {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantPlan: string;
}

export function App({ children }: { children: ComponentChildren }) {
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const location = useLocation();

  useEffect(() => onThemeChange(setTheme), []);

  useEffect(() => {
    api<Me>('/api/v1/me')
      .then((data) => setMe(data))
      .catch(() => {
        // Not authed. In dev we bypass Google OAuth and hit the engine's
        // dev-login shortcut, which sets a pre-seeded session cookie and
        // redirects back here. In prod we go through OAuth.
        const target = import.meta.env.DEV
          ? '/api/auth/dev-login?session=dev'
          : `/api/auth/google?redirect=${encodeURIComponent(window.location.href)}`;
        window.location.href = target;
      });
  }, []);

  // Render the chrome immediately (no "Loading…" flash for the ~50-200ms
  // auth round-trip). Main content stays hidden until `me` resolves — a
  // brief blank area is less jarring than a flash of placeholder text.
  return (
    <div class="min-h-screen flex flex-col">
      <header class="border-b border-[color:var(--color-border)] px-6 py-3 flex items-center gap-4 bg-[color:var(--color-bg-card)]">
        <a href="/" class="flex items-center gap-2 font-mono text-lg font-semibold tracking-tight">
          <span class="inline-block w-6 h-6 rounded-full border-2 border-[color:var(--color-accent)] relative">
            <span class="absolute inset-[3px] rounded-full bg-[color:var(--color-accent)]"></span>
          </span>
          trail
        </a>
        <span class="text-[color:var(--color-fg-subtle)] text-sm">admin</span>
        <div class="ml-auto flex items-center gap-3 text-sm">
          {me ? (
            <>
              <span class="text-[color:var(--color-fg-muted)]">{me.tenantName}</span>
              <span class="text-[color:var(--color-fg-subtle)]">·</span>
              <span>{me.displayName}</span>
            </>
          ) : null}
          <ThemeToggle theme={theme} />
        </div>
      </header>
      <main class="flex-1">{me ? children : null}</main>
    </div>
  );
}

/**
 * Theme cycle: light → dark → auto → light.
 *
 * Icon reflects the *current* mode:
 *   light → sun
 *   dark  → moon
 *   auto  → half-moon (sun+moon overlapped)
 *
 * Tooltip names the next state so clicking feels predictable.
 */
function ThemeToggle({ theme }: { theme: Theme }) {
  const nextLabel =
    theme === 'light' ? 'Switch to dark' : theme === 'dark' ? 'Follow system' : 'Switch to light';
  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={nextLabel}
      aria-label={nextLabel}
      class="inline-flex items-center justify-center w-8 h-8 rounded-md border border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] transition text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
    >
      {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <AutoIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" />
    </svg>
  );
}
