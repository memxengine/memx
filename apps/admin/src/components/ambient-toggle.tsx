/**
 * F94 — Ambient audio toggle. Sits next to the theme toggle in the admin
 * header. Click toggles the master enable; hover/focus reveals an inline
 * volume slider. Mirrors ThemeToggle in size, border treatment, and active
 * scale so the header row reads as one cohesive control cluster.
 */
import { useState } from 'preact/hooks';
import { ambientEnabled, ambientVolume } from '../lib/ambient-store';
import { t } from '../lib/i18n';

export function AmbientToggle() {
  const enabled = ambientEnabled.value;
  const volume = ambientVolume.value;
  const [open, setOpen] = useState(false);

  const label = enabled ? t('nav.ambient.off') : t('nav.ambient.on');

  return (
    <div
      class="relative inline-flex items-center"
      onMouseEnter={() => enabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        title={label}
        onClick={() => {
          ambientEnabled.value = !enabled;
        }}
        onFocus={() => enabled && setOpen(true)}
        onBlur={(e) => {
          // Keep open while focus moves to the slider inside the same wrapper.
          const next = e.relatedTarget as Node | null;
          if (!next || !(e.currentTarget.parentElement?.contains(next))) {
            setOpen(false);
          }
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
      {open ? (
        // Two-div structure on purpose: the outer absolute div is the
        // hover "bridge". Its `pt-1.5` creates visual breathing space
        // above the visible card WITHOUT introducing a DOM gap — so the
        // mouse travelling from the button down to the slider stays
        // inside the wrapper's subtree and mouseleave doesn't fire mid-
        // traverse. Margin-top would break this (the gap would be
        // outside the wrapper's layout).
        <div
          class="absolute top-full right-0 z-20 pt-1.5"
          onMouseEnter={() => setOpen(true)}
        >
          <div class="flex items-center gap-2 px-3 py-2 rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-card)] shadow-lg">
            <span class="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
              {Math.round(volume * 100)}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              aria-label={t('nav.ambient.volume')}
              onInput={(e) => {
                const v = Number((e.currentTarget as HTMLInputElement).value);
                ambientVolume.value = Math.max(0, Math.min(1, v / 100));
              }}
              // Holding pointer-capture across the wrapper keeps the
              // slider open while the user drags, even if they overshoot
              // the wrapper's bounds — otherwise a fast drag closes the
              // popover mid-scrub.
              onPointerDown={(e) => {
                (e.currentTarget as HTMLInputElement).setPointerCapture(e.pointerId);
              }}
              onBlur={(e) => {
                const next = e.relatedTarget as Node | null;
                if (!next || !(e.currentTarget.parentElement?.parentElement?.parentElement?.contains(next))) {
                  setOpen(false);
                }
              }}
              class="w-24 accent-[color:var(--color-accent)]"
            />
          </div>
        </div>
      ) : null}
    </div>
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
