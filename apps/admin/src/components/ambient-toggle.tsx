/**
 * F94 — Ambient audio toggle. Sits next to the theme toggle in the admin
 * header. Click toggles the master enable. Mirrors ThemeToggle in size,
 * border treatment, and active scale so the header row reads as one
 * cohesive control cluster.
 *
 * The hover-popover volume slider was removed: the hover-bridge + grace-
 * period + pointer-capture stack still raced badly enough that the slider
 * was un-grabbable in practice. A header-mounted slider is the wrong
 * pattern for a control that's used rarely; revive it as a settings-panel
 * row when one exists. Volume defaults to 0.6 in `lib/ambient-store.ts`
 * and persists per-device via localStorage — adjust there or via a future
 * settings UI, not in the header.
 */
import { ambientEnabled } from '../lib/ambient-store';
import { t } from '../lib/i18n';

export function AmbientToggle() {
  const enabled = ambientEnabled.value;
  const label = enabled ? t('nav.ambient.off') : t('nav.ambient.on');

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      onClick={() => {
        ambientEnabled.value = !enabled;
      }}
      class={
        'inline-flex items-center justify-center w-8 h-8 rounded-md border active:scale-95 transition ' +
        (enabled
          ? 'ambient-on border-[color:var(--color-accent)] text-[color:var(--color-accent)] hover:bg-[color:var(--color-bg-card)]'
          : 'border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-card)] hover:text-[color:var(--color-fg)]')
      }
    >
      {enabled ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
    </button>
  );
}

function SpeakerOnIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}
