import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api } from './api';
import { getTheme, onThemeChange, toggleTheme, type Theme } from './theme';
import { mountConstellation } from './lib/constellation';
import { TrailNav } from './components/trail-nav';
import { useKb } from './lib/kb-cache';

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { path } = useLocation();
  const kbId = path.match(/^\/kb\/([^/]+)/)?.[1];
  const kb = useKb(kbId ?? '');

  useEffect(() => onThemeChange(setTheme), []);

  // Reflect the current Trail (or the admin home) in the browser tab. Makes
  // "which Trail am I in?" visible even when the tab is backgrounded, and
  // lets the tab bar carry context when several KBs are open across windows.
  // Gated on kbId too — if the URL has no /kb/<id> we show the admin root
  // title, never a stale Trail name from a previous navigation.
  useEffect(() => {
    if (kbId && kb) {
      document.title = `trail: ${kb.name}`;
    } else {
      document.title = 'trail: Admin';
    }
  }, [kbId, kb]);

  useEffect(() => {
    if (!canvasRef.current) return;
    return mountConstellation(canvasRef.current);
  }, []);

  useEffect(() => {
    api<Me>('/api/v1/me')
      .then((data) => setMe(data))
      .catch(() => {
        // Not authed. In dev we hit the engine's dev-login shortcut; in prod
        // we go through Google OAuth.
        const target = import.meta.env.DEV
          ? '/api/auth/dev-login?session=dev'
          : `/api/auth/google?redirect=${encodeURIComponent(window.location.href)}`;
        window.location.href = target;
      });
  }, []);

  return (
    <div class="min-h-screen flex flex-col">
      <canvas ref={canvasRef} id="trail-graph" aria-hidden="true" />
      <header class="relative z-10 bg-[color:var(--color-bg)]/80 backdrop-blur-md">
        <div class="page-shell !py-0">
          <div class="flex items-center gap-4 py-3">
            <a href="/" class="flex items-center gap-2.5">
              <TrailLogo />
              <span class="font-mono text-lg font-semibold tracking-tight text-[color:var(--color-fg)]">
                trail
              </span>
              <span class="text-[color:var(--color-fg-subtle)] text-sm ml-1">admin</span>
            </a>
            <div class="ml-auto flex items-center gap-3 text-sm">
              {me ? (
                <span class="text-[color:var(--color-fg-muted)]">{displayName(me)}</span>
              ) : null}
              <ThemeToggle theme={theme} />
            </div>
          </div>
          {kbId ? <TrailNav kbId={kbId} /> : null}
        </div>
      </header>
      <main class="relative z-10 flex-1">{me ? children : null}</main>
    </div>
  );
}

/** Pick the one most useful name — never both displayName AND tenantName. */
function displayName(me: Me): string {
  if (me.displayName && me.displayName.trim().length > 0) return me.displayName;
  const local = me.email.split('@')[0];
  return local ?? me.email;
}

/** Three concentric circles — same mark as the landing's memx-logo.svg. */
function TrailLogo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2" />
      <circle
        cx="16"
        cy="16"
        r="9"
        fill="none"
        stroke="var(--color-accent)"
        stroke-width="0.9"
        opacity="0.55"
      />
      <circle cx="16" cy="16" r="3.5" fill="var(--color-accent)" />
    </svg>
  );
}

function ThemeToggle({ theme }: { theme: Theme }) {
  const label = theme === 'light' ? 'Switch to dark' : 'Switch to light';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={label}
      aria-label={label}
      class="inline-flex items-center justify-center w-8 h-8 rounded-md border border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-card)] active:scale-95 transition text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
    >
      {theme === 'light' ? <SunIcon /> : <MoonIcon />}
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
