import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { COPY, type Lang } from './copy';
import { mountConstellation } from './lib/constellation';
import {
  S1Concept,
  S2Kb,
  S3Template,
  S4Sources,
  S5Team,
  S6Ingest,
  S7Query,
  SDone,
  type OnboardingState,
} from './screens';

const STORAGE_KEY = 'trail.onboarding.v1';
const THEME_KEY = 'trail.onboarding.theme';
type Theme = 'light' | 'dark';

const DEFAULT_STATE: OnboardingState = {
  step: 0,
  lang: 'da',
  kbName: '',
  kbSlug: '',
  kbSlugTouched: false,
  kbDesc: '',
  tpl: 'clinic',
  customSchema: false,
  sources: [],
  connectors: ['mcp'],
  invites: [
    { email: 'linda@klinik.dk', role: 'curator' },
    { email: 'jens@klinik.dk', role: 'reader' },
  ],
  autoApprove: false,
  ingestRun: 0,
};

function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_STATE;
}

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'dark' || raw === 'light') return raw;
  } catch {}
  return 'light';
}

// Three concentric circles — byte-identical with apps/landing/public/uploads/memx-logo.svg
// (the canonical mark). kebab-case `stroke-width` is required because Preact does
// not translate camelCase SVG attributes — `strokeWidth` would silently drop,
// leaving the outer ring at the browser default 1 instead of 2.
function Logo() {
  return (
    <div className="brand">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2" />
        <circle cx="16" cy="16" r="9" fill="none" stroke="#e8a87c" stroke-width="0.9" opacity="0.55" />
        <circle cx="16" cy="16" r="3.5" fill="#e8a87c" />
      </svg>
      <span className="wordmark">trail</span>
      <span className="sub">onboarding</span>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<OnboardingState>(loadState);
  const [theme, setThemeState] = useState<Theme>(loadTheme);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const set = (patch: Partial<OnboardingState>) => setState((s) => ({ ...s, ...patch }));

  const setTheme = (t: Theme) => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {}
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  // Same neuron-constellation background as apps/landing + apps/admin.
  // mountConstellation returns a dispose fn; the module also guards against
  // duplicate mounts via a globalThis singleton so HMR reloads don't stack
  // animation loops.
  useEffect(() => {
    if (!canvasRef.current) return;
    return mountConstellation(canvasRef.current);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state]);

  const t = COPY[state.lang];
  const TOTAL = 7;
  const step = state.step;

  const onNext = () => set({ step: Math.min(step + 1, TOTAL) });
  const onPrev = () => set({ step: Math.max(step - 1, 0) });

  const canAdvance = useMemo(() => {
    if (step === 1) return state.kbName.trim().length >= 2;
    if (step === 2) return Boolean(state.tpl) || state.customSchema;
    return true;
  }, [step, state]);

  const onExit = () => {
    // Send the curator over to the real admin dashboard once onboarding is
    // finished. The admin app lives at /admin in production; in dev this is
    // localhost:3030 but the button is shown post-deploy so the prod path
    // is correct.
    window.location.href = '/admin';
  };

  return (
    <div className="app-shell">
      <canvas id="trail-graph" aria-hidden="true" ref={canvasRef} />
      <div className="topbar">
        <Logo />
        <div className="rail-meta">{t.metaRail}</div>
        <div className="topbar-actions">
          {/* Theme toggle — identical DOM + CSS + icons as apps/landing
              (see .theme-toggle block in styles.css). Both moon and sun
              icons are always in the tree; CSS swaps visibility based on
              html[data-theme] so there's no React re-render flicker and
              the markup matches the static landing 1:1. */}
          <button
            type="button"
            className="theme-toggle"
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          >
            <svg
              className="icon-moon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <svg
              className="icon-sun"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg>
          </button>
          <div className="lang-toggle">
            <button
              className={state.lang === 'da' ? 'active' : ''}
              onClick={() => set({ lang: 'da' as Lang })}
            >
              DA
            </button>
            <button
              className={state.lang === 'en' ? 'active' : ''}
              onClick={() => set({ lang: 'en' as Lang })}
            >
              EN
            </button>
          </div>
          {/* Save & exit navigates back to the landing site. State is already
              persisted to localStorage on every change so the curator can resume
              later — no dialog needed. */}
          <a
            href="/"
            className="btn link"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}
          >
            {t.save}
          </a>
        </div>
      </div>

      <div className="stage">
        <div className="progress">
          {t.steps.map((s, i) => (
            <div
              key={i}
              className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
              onClick={() => set({ step: i })}
            >
              <span className="no">{s.no}</span>
              <span className="label">{s.label}</span>
            </div>
          ))}
        </div>

        <div
          data-screen-label={`${String(step + 1).padStart(2, '0')} ${
            t.steps[step]?.label ?? 'Done'
          }`}
        >
          {step === 0 && <S1Concept t={t} onNext={onNext} />}
          {step === 1 && <S2Kb t={t} state={state} set={set} />}
          {step === 2 && <S3Template t={t} state={state} set={set} />}
          {step === 3 && <S4Sources t={t} state={state} set={set} />}
          {step === 4 && <S5Team t={t} state={state} set={set} />}
          {step === 5 && <S6Ingest t={t} state={state} set={set} />}
          {step === 6 && <S7Query t={t} state={state} lang={state.lang} />}
          {step === 7 && <SDone t={t} onExit={onExit} />}
        </div>

        {step > 0 && step < 7 && (
          <div className="btn-row" style={{ maxWidth: 1280, justifyContent: 'space-between' }}>
            <button className="btn ghost" onClick={onPrev}>
              {t.prev}
            </button>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              {step < 6 && (
                <button
                  className="btn link"
                  onClick={onNext}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                  }}
                >
                  {t.skip}
                </button>
              )}
              <button
                className="btn primary"
                onClick={onNext}
                disabled={!canAdvance}
                style={{
                  opacity: canAdvance ? 1 : 0.4,
                  cursor: canAdvance ? 'pointer' : 'not-allowed',
                }}
              >
                {step === 6 ? t.finish : t.next} {step !== 6 && <span className="arrow"></span>}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="footer-bar">
        <div>
          <span className="dot" />
          {t.footerLive}
        </div>
        <div>{t.footerRight}</div>
      </div>
    </div>
  );
}
