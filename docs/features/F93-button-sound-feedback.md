# F93 — Button Sound Feedback

> Optional, opt-in audible click feedback in the admin UI. Subtle, synthesized via the Web Audio API (no asset bundle), with per-action variants (neutral / success / danger), a header toggle next to the theme toggle, and respect for `prefers-reduced-motion`.

## Problem

The admin is keyboard- and mouse-heavy: curators bulk-approve queue candidates, toggle tags, save Neurons, switch Trails. The visual feedback today is a `transition active:scale-[0.98]` on `ModalButton` plus the surrounding processing-indicator. That's enough for most flows, but in two recurring situations curators have asked whether the click "took":

1. **Bulk actions on the queue panel** — multiple rapid clicks across rows; the pending-count badge updates via SSE (F87) but with a perceptible debounce.
2. **Save in the Neuron editor (F91)** — the dirty-state guard and optimistic-concurrency check happen on the server; the local UI commits silently before the round-trip.

A short, deliberate audible cue closes the loop without competing with the visuals. Same reason a mechanical keyboard switch has a tactile click: the affirmation is *separate* from the result.

## Solution

A tiny `playClick(variant)` helper backed by an `AudioContext` lazily created on first user gesture (browsers require this). Three short tones — `neutral` (~180 Hz triangle, 40 ms), `success` (rising 440→660 Hz, 60 ms), `danger` (falling 440→220 Hz, 60 ms) — synthesized via `OscillatorNode` + `GainNode` envelope. No audio assets shipped; zero bundle weight beyond the helper module.

Opt-in: stored in `localStorage.trail.admin.sound` (off by default). When `prefers-reduced-motion: reduce` is set and the user has never explicitly toggled, default stays off. Toggle button in the header next to the theme toggle. Volume fixed at a quiet but audible level (gain `0.08`); a slider is out of scope for v1 — too many controls for a feature this small.

Wired into the existing `ModalButton` (single chokepoint for primary/secondary/danger button styling) so every modal footer button gets the right cue with zero per-callsite changes. Plain `<button>` callsites that want feedback opt in via the new `useClickSound()` hook or by attaching `data-sound="…"` (handled by a single delegated listener on the document).

## Technical Design

### `apps/admin/src/lib/sound.ts` (new)

```ts
export type SoundVariant = 'neutral' | 'success' | 'danger';

export interface SoundPref {
  enabled: boolean;
  // 'unset' = honour prefers-reduced-motion; 'on'/'off' = explicit user choice
  source: 'unset' | 'user';
}

export function getSoundPref(): SoundPref;
export function setSoundEnabled(enabled: boolean): void;       // marks source='user'
export function onSoundPrefChange(cb: (pref: SoundPref) => void): () => void;

/**
 * Play a short click. No-ops when disabled, when no user gesture has fired
 * yet (AudioContext can't start), or when the document is hidden.
 */
export function playClick(variant?: SoundVariant): void;
```

Internals:
- Lazy-init a single shared `AudioContext` on the first call after a user gesture; bail silently if `window.AudioContext` is undefined.
- `playClick` builds an `OscillatorNode` + `GainNode` per call (cheap), schedules a 5 ms attack / 35-55 ms decay envelope to avoid click-on-click artefacts, disconnects in `onended`.
- Pref store mirrors `theme.ts` exactly — same listener pattern, same `STORAGE_KEY` convention (`trail.admin.sound`).

### `useClickSound()` Preact hook

```ts
export function useClickSound(): (variant?: SoundVariant) => void;
```

Thin subscription to `getSoundPref()`; returns a no-op when disabled so the call site doesn't need to branch.

### Global delegated listener

Mounted once in `app.tsx`. Listens for `pointerdown` on `document`, walks up to the nearest `<button>` or `[data-sound]`, reads `data-sound` (defaults to `neutral`), and calls `playClick`. `pointerdown` (not `click`) so the cue lands on the press, not the release — matches the `active:scale-[0.98]` timing already in the design system. Buttons that should stay silent set `data-sound="off"`. Disabled buttons are skipped.

### `ModalButton` (modified)

Adds `data-sound` derived from `variant`:
- `primary` → `success`
- `danger` → `danger`
- `secondary` → `neutral`

No new prop, no callsite churn. Every modal footer in `panels/queue.tsx`, `panels/sources.tsx`, `panels/neuron-editor.tsx`, `panels/chat.tsx` gets the right cue automatically.

### Header toggle

Sits next to the existing theme toggle in `app.tsx`. Reuses the same icon-button styling. Icon: a small speaker / speaker-with-slash, chosen from Lucide-equivalent inline SVG (the admin doesn't pull a Lucide package; existing inline-SVG pattern in `trail-nav.tsx` and `app.tsx`). Aria-label + `t('nav.sound.toggle')`.

### i18n

Add to `apps/admin/src/locales/{en,da}.json` under `nav.sound`:
- `toggle` — "Toggle sound" / "Lyd til/fra"
- `on` — "Sound on" / "Lyd til"
- `off` — "Sound off" / "Lyd fra"

## Impact Analysis

### Files affected

**New:**
- `apps/admin/src/lib/sound.ts` — pref store + `playClick` + `useClickSound`

**Modified:**
- `apps/admin/src/app.tsx` — mount global delegated `pointerdown` listener; render the header sound toggle next to the theme toggle
- `apps/admin/src/components/modal.tsx` — `ModalButton` adds `data-sound={variant→sound}` mapping
- `apps/admin/src/locales/en.json` — add `nav.sound.{toggle,on,off}`
- `apps/admin/src/locales/da.json` — add `nav.sound.{toggle,on,off}`

**Not modified (intentional):**
- The 13 button-bearing files identified by `Grep` (`panels/queue.tsx`, `panels/sources.tsx`, `panels/neuron-editor.tsx`, `panels/chat.tsx`, `components/dynamic-actions.tsx`, `components/tag-chips.tsx`, `components/copy-id.tsx`, `components/upload-dropzone.tsx`, `panels/search.tsx`, `panels/wiki-tree.tsx`, `panels/kbs.tsx`, `app.tsx` non-modal buttons) — covered by the global delegated listener; opt-out per button is `data-sound="off"`.
- `apps/server/**` — feature is admin-only; no server-side change.
- `packages/**` — same; no shared package touched.

### Downstream dependents

**`apps/admin/src/components/modal.tsx`** is imported by 4 files (Grep `from.*components/modal`):
- `apps/admin/src/panels/sources.tsx` — unaffected, `ModalButton` API unchanged (no new prop)
- `apps/admin/src/panels/neuron-editor.tsx` — unaffected
- `apps/admin/src/panels/queue.tsx` — unaffected
- `apps/admin/src/panels/chat.tsx` — unaffected

**`apps/admin/src/app.tsx`** — leaf app shell, not imported by other admin code (only by `main.tsx` as the route wrapper). No downstream dependents.

**`apps/admin/src/locales/en.json` / `da.json`** are imported only by `apps/admin/src/lib/i18n.ts`. New keys are additive — existing `t('…')` calls keep resolving. No downstream changes needed.

**`apps/admin/src/lib/sound.ts`** is new. Initial consumers: `app.tsx` (toggle + listener) and `modal.tsx` (variant mapping is data-only — no import needed if we go pure-`data-sound`). Hook + helper are exported for future opt-in use cases (e.g. F31 reader feedback button).

### Blast radius

- **AudioContext + browser autoplay policy** — Chrome / Safari refuse to start an `AudioContext` before a user gesture. Lazy-init guarded by `try/catch` + `state === 'suspended'` resume on first `pointerdown`. If init fails, `playClick` is a permanent no-op for the session.
- **Hidden-tab playback** — guarded by `document.hidden` check; otherwise an SSE-driven UI re-render after `candidate_approved` would chirp from a backgrounded tab.
- **Disabled buttons** — listener skips when `target.closest('button')?.disabled === true`. Otherwise rapid-firing on a debounced approve button would still chirp.
- **Bulk approve cascade** — F87 SSE re-fires events; we only play on local `pointerdown`, never on SSE-driven re-renders. The cue is bound to user intent, not to UI updates.
- **Modal close on outside click** — `Modal`'s outside-click backdrop calls `onClose` from a `<div>`, not a `<button>`. The delegated listener won't fire there. Fine; closing a modal by clicking outside it is intentionally silent.
- **Keyboard activation** — `pointerdown` doesn't fire on Space/Enter. Add a parallel `keydown` listener that fires only when `(e.key === ' ' || e.key === 'Enter') && document.activeElement?.tagName === 'BUTTON'`. Keeps keyboard parity with mouse.
- **Touch / mobile** — `pointerdown` covers touch. iOS may still need a single ambient `Audio()` unlock on first gesture; tested in v1.
- **`prefers-reduced-motion`** — used as the *default* signal only when the user hasn't explicitly toggled. Once toggled, user choice wins.
- **Test environment (jsdom)** — `AudioContext` undefined; helper detects and no-ops. Vitest runs unaffected.

### Breaking changes

None. The `ModalButton` API is unchanged. The new `data-sound` attribute on `<button>` is a custom data attribute — invisible to existing tests, layout, and other code. Default behaviour with the toggle off is identical to today.

### Test plan

- [ ] TypeScript compiles: `npx tsc --noEmit` (run from `apps/admin/`)
- [ ] With sound off (default): clicking any admin button produces no sound — verify in Chrome with system volume up
- [ ] Toggle sound on via the header toggle: clicking primary/danger/secondary `ModalButton` instances in queue and sources modals plays the matching cue
- [ ] Bulk-approve 5 queue rows in quick succession: each click chirps once; SSE re-render does not produce extra chirps
- [ ] Disabled button (e.g. "Approve" while a request is in flight): no sound
- [ ] Keyboard: focus a button, press Enter — sound plays once; press Space — sound plays once
- [ ] Background the tab, trigger an SSE-driven badge update: no sound
- [ ] Page-load with `prefers-reduced-motion: reduce` set in DevTools rendering tab: toggle reads as off without the user ever interacting; explicit toggle-on overrides on next reload
- [ ] Sound preference persists across reload (localStorage `trail.admin.sound`)
- [ ] Regression — F87 event stream: queue badge still updates live, no console errors
- [ ] Regression — F91 Neuron editor: save still works, beforeunload guard still fires, optimistic-concurrency 409 still surfaces
- [ ] Regression — Modal: ESC closes, outside-click closes, focus traps as before

## Implementation Steps

1. Write `apps/admin/src/lib/sound.ts` (pref store + `playClick` + `useClickSound` + autoplay guards).
2. Mount global `pointerdown` + `keydown` listeners and render the header toggle in `apps/admin/src/app.tsx`.
3. Add `data-sound` mapping to `ModalButton` in `apps/admin/src/components/modal.tsx`.
4. Add `nav.sound.*` keys to `apps/admin/src/locales/{en,da}.json`.
5. Manual verification against the test plan in Chrome (sound on / off, prefers-reduced-motion, bulk approve, keyboard).
6. Commit: `feat(admin): F93 — opt-in button sound feedback (Web Audio, header toggle)`.

## Dependencies

- F18 — Curator UI shell (header is where the toggle lives)
- F87 — Event stream (the bulk-approve race the cue was designed for)

## Effort Estimate

**Small** — ~½ day. One new module, one component edit, two locale entries, one app-shell wiring. No server, no schema, no migrations.
