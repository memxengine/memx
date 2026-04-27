import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api } from './api';
import { getTheme, onThemeChange, toggleTheme, type Theme } from './theme';
import { mountConstellation } from './lib/constellation';
import { TrailNav } from './components/trail-nav';
import { AmbientProvider } from './components/ambient-provider';
import { AmbientToggle } from './components/ambient-toggle';
import { ThinkingSubscriber } from './components/thinking-subscriber';
import { ambientRoute } from './lib/ambient-store';
import { routeFromPath } from './lib/route-to-ambient';
import { useKb } from './lib/kb-cache';
import { t, useLocale, setLocale, SUPPORTED_LOCALES, type Locale } from './lib/i18n';

interface Me {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantPlan: string;
  /** F161 follow-up — operator-set env-flags surfaced to the UI. */
  features?: { visionRerun?: boolean };
}

export function App({ children }: { children: ComponentChildren }) {
  // Subscribe to locale changes so the header glossary link + any
  // other App-owned t() calls re-render on language switch. Without
  // this, the LanguageSwitcher flips its internal state but App
  // itself never re-runs, so "Glossary"/"Ordforklaring" stays stuck
  // at the initial locale.
  useLocale();
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { path, route } = useLocation();
  const kbId = path.match(/^\/kb\/([^/]+)/)?.[1];
  const kb = useKb(kbId ?? '');

  useEffect(() => onThemeChange(setTheme), []);

  // Sync the current pathname into the ambient route signal so
  // <AmbientProvider /> can swap loops on navigation. Belt-and-suspenders:
  // peek() before assigning so navigations *within* the same RouteKey
  // (e.g. /kb/<id>/neurons → /kb/<id>/neurons/<slug>) skip the signal
  // write entirely. Preact signals already no-op same-primitive writes,
  // but reading the user-visible intent off the line — "don't even touch
  // the audio engine when the loop is the same" — beats relying on a
  // library-internal optimisation.
  useEffect(() => {
    const next = routeFromPath(path);
    if (ambientRoute.peek() !== next) {
      ambientRoute.value = next;
    }
  }, [path]);

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

  // Global Cmd+K / Ctrl+K → jump to the current Trail's search panel.
  // The search input has autoFocus so landing there focuses the field.
  // Intercepts even from inside input/textarea because Cmd+K has no
  // text-editing meaning — browsers bind it to the URL bar, which is what
  // the shortcut is stealing here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!kbId) return; // no Trail in scope → nothing to search
      e.preventDefault();
      route(`/kb/${kbId}/search`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kbId, route]);

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
              {/* Live SF Mono wordmark — matches landing nav spec exactly:
                  18px mobile, 22px desktop (≥768px), weight 600, -0.02em. */}
              <span
                class="font-mono font-semibold text-[18px] md:text-[22px] text-[color:var(--color-fg)]"
                style="letter-spacing: -0.02em;"
              >
                trail
              </span>
              <span class="text-[color:var(--color-fg-subtle)] text-sm md:text-base ml-1">admin</span>
            </a>
            <div class="ml-auto flex items-center gap-3 text-sm">
              <a
                href="/glossary"
                class="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] transition"
              >
                {t('nav.glossary')}
              </a>
              {me ? (
                <a
                  href="/settings"
                  class="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] transition"
                  title={t('nav.accountSettings')}
                >
                  {displayName(me)}
                </a>
              ) : null}
              <LanguageSwitcher />
              <AmbientToggle />
              <ThemeToggle theme={theme} />
            </div>
          </div>
          {kbId ? <TrailNav kbId={kbId} /> : null}
        </div>
      </header>
      <main class="relative z-10 flex-1">{me ? children : null}</main>
      <AmbientProvider />
      {me ? <ThinkingSubscriber /> : null}
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
  // Matches landing spec: 32×32 mobile, 40×40 from 768px+. `w-8 md:w-10`
  // (and matching h-) drives both dimensions responsively — `width/height`
  // attributes are omitted so CSS wins over intrinsic SVG sizing.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      class="w-8 h-8 md:w-10 md:h-10"
      aria-hidden="true"
    >
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

/**
 * Language switcher. Tiny pill of buttons — no dropdown or modal because
 * we ship two locales and adding a third doesn't warrant the extra chrome
 * until it happens.
 */
function LanguageSwitcher() {
  const locale = useLocale();
  return (
    <div
      class="inline-flex items-center rounded-md border border-[color:var(--color-border)] overflow-hidden"
      role="group"
      aria-label={t('nav.language')}
    >
      {SUPPORTED_LOCALES.map((l) => {
        const active = l.code === locale;
        return (
          <button
            key={l.code}
            type="button"
            onClick={() => setLocale(l.code as Locale)}
            class={
              'px-2 py-1 text-xs font-mono uppercase tracking-wide transition ' +
              (active
                ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-card)]')
            }
            aria-pressed={active}
          >
            {l.code}
          </button>
        );
      })}
    </div>
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
