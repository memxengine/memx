# F94 — Ambient Audio System

> Discreet ambient background loops on admin routes. Gives Trail a calming, tactile presence — the auditory equivalent of a design system. Per-route loop, opt-in, device-local preference, hard-cut transitions, lazy-loaded buffers.

## Problem

Trail is a contemplative tool — curation, claim-anchoring, slow knowledge compilation. The UI should *feel* like a thinking space. The visual design system already pushes that direction (warm bg, amber accent, mono caps). Audio is the missing axis.

There's no precedent for ambient sound in any current admin surface. Adding it is purely additive.

**Not goals:**
- Notification sounds
- Action / button feedback (explicitly rejected — see F93 for the dropped attempt)
- Music-player UX (no track names, no playlists, no skip)

**Goal:** a low-volume, seamless, per-route loop that the user controls and that the app remembers across reloads.

## Solution

Six named ambient loops + one `idle` fallback, one per top-level admin area:

| Route key  | Source path           | Loop character                                       |
|------------|-----------------------|------------------------------------------------------|
| `landing`  | `/` (KB list, root)   | Warmest, most inviting — first impression           |
| `neurons`  | `/kb/:id/neurons*`    | Spacious, slow — reflection on the knowledge graph  |
| `queue`    | `/kb/:id/queue*`      | Gentle forward motion — work in progress            |
| `chat`     | `/kb/:id/chat*`       | Soft and present — conversational warmth            |
| `search`   | `/kb/:id/search*`     | Crystalline, alert — attention without tension      |
| `sources`  | `/kb/:id/sources*`    | Grounded, textural — documentary stillness          |
| `idle`     | (any unmatched path)  | Neutral wash — everything else                      |

Single Web Audio engine, single shared `AudioContext`, single master `GainNode`. On route change: `stop()` the current `AudioBufferSourceNode`, `start()` a new one — hard cuts, no crossfades. Buffers decoded on first visit and cached per route in a `Map<RouteKey, AudioBuffer>`.

Opt-in. Off by default. Toggle in the admin header next to the theme toggle. Preference persists in `localStorage.trailmem.ambient.{enabled,volume}` (device-local — correct for audio settings).

## Technical Design

### Audio engine: Web Audio API (not `<audio>` elements)

Sample-accurate gain ramps for the volume slider and clean source-swap on route change. `<audio>` tags click on start/stop and don't expose the timing primitives we need.

### Format: Opus @ 96 kbps, loudnorm to -18 LUFS

Source MP3s in `docs/assets/sound/` (varying bitrates 160–256 kbps, varying lengths 11s–18min) are converted by `scripts/process-ambient.sh` into `.opus` files in `apps/admin/public/ambient/`. Two-pass `loudnorm=I=-18:TP=-2:LRA=7` aligns perceived volume across loops so the hard cut between routes is a *texture* change, not a *level* change. `home.mp3` is renamed to `landing.opus` during conversion (per Christian: home == landing == root).

Loop length is left unchanged from the source unless the source is unusably long — `chat.mp3` is 18 min and gets trimmed to 120 s with a 5 s fade-out at the tail (per-output `TRIM_SEC` + `FADE_OUT_SEC` config in the script). Web Audio's `source.loop = true` handles the rest. Some current sources are short loops (queue/search ~11 s); v1 ships them as-is. The spec's 60 s / seamless-3 s-crossfade target is aspirational; re-mastering is a content task, not an engineering one — flag once we hear it in use.

Source MP3s in `docs/assets/sound/` are gitignored as mastering inputs only; the converted `.opus` outputs in `apps/admin/public/ambient/` are the shipped artefacts and live in git. Re-running the script requires the original MP3s to be present locally.

### State: Preact signals + localStorage

```ts
// apps/admin/src/lib/ambient-store.ts
import { signal } from '@preact/signals';

export type RouteKey = 'landing' | 'neurons' | 'queue' | 'chat' | 'search' | 'sources' | 'idle';

export const ambientEnabled = signal<boolean>(false);
export const ambientVolume  = signal<number>(0.6);   // 0..1 master
export const ambientRoute   = signal<RouteKey>('landing');
```

Hydration on module load reads `localStorage.trailmem.ambient.enabled` ("true"|"false") and `…volume` (string-encoded float). Two `effect()`s write changes back. Signal subscriptions are the only consumer — no Context, no prop drilling.

Note: `@preact/signals` is **not** currently a dependency of `apps/admin`. F94 adds `@preact/signals` to `apps/admin/package.json`. Alternative considered: roll a tiny pub/sub like `apps/admin/src/theme.ts` already does. Rejected because the audio engine has multiple subscribers (volume slider UI, toggle UI, engine itself) and signals beat hand-rolled listener sets at three+ subscribers. The dep is ~6 KB gzipped.

### Route mapping

```ts
// apps/admin/src/lib/route-to-ambient.ts
export function routeFromPath(pathname: string): RouteKey {
  // Per-Trail tabs live under /kb/<id>/<tab>
  if (/^\/kb\/[^/]+\/neurons/.test(pathname)) return 'neurons';
  if (/^\/kb\/[^/]+\/queue/.test(pathname))   return 'queue';
  if (/^\/kb\/[^/]+\/chat/.test(pathname))    return 'chat';
  if (/^\/kb\/[^/]+\/search/.test(pathname))  return 'search';
  if (/^\/kb\/[^/]+\/sources/.test(pathname)) return 'sources';
  if (pathname === '/' || pathname === '')    return 'landing';
  return 'idle';
}
```

`landing` matches root only; `idle` catches glossary, not-found, wiki-reader, neuron-editor, anything that isn't a top-level tab.

### `<AmbientProvider>` — owns the engine

Mounted once at app shell. Owns:
- The single shared `AudioContext`
- The single shared master `GainNode` connected to `ctx.destination`
- `bufferCache: Map<RouteKey, AudioBuffer>`
- `activeSource: AudioBufferSourceNode | null`
- `activeRouteKey: RouteKey | null` (for de-dup vs. effect-double-fire)

Lifecycle:
- **On mount:** hydrate signals from `localStorage`. **Do not** create `AudioContext` (browsers reject pre-gesture).
- **On `ambientEnabled → true`:** capture-once `pointerdown` listener on `document`. First gesture creates the context, calls `ctx.resume()`, kicks off the swap to the current route.
- **On `ambientRoute` change (when enabled):** if `activeRouteKey === newKey`, return early (StrictMode + rapid-nav guard). Otherwise: `activeSource?.stop()`, fetch from cache or `fetch + decodeAudioData` if missing, build a new `AudioBufferSourceNode` with `loop = true`, connect to masterGain, `start()`. Update `activeRouteKey`.
- **On `ambientVolume` change:** `masterGain.gain.linearRampToValueAtTime(volume, now + 0.15)` — 150 ms, fast but not clicky.
- **On `ambientEnabled → false`:** ramp masterGain to 0 over 150 ms, then `activeSource?.stop()` + `ctx.suspend()`. Prevents shutdown click.
- **On unmount:** `activeSource?.stop()`, `ctx.close()`.

All scheduling uses `ctx.currentTime`, never `Date.now()`.

### `<AmbientToggle>` — header UI

Sits next to the existing theme toggle in `apps/admin/src/app.tsx` header. Two icon states (speaker / speaker-off, inline SVG matching the theme-toggle pattern). Click toggles `ambientEnabled.value`. Hover/focus reveals an inline volume slider (range 0–100, two-decimal step). Aria: `role="switch"`, `aria-checked`, `aria-label={t('nav.ambient.toggle')}`.

When `ambientEnabled === true` but the AudioContext is still suspended (no gesture yet), the toggle renders a tiny "tap to resume" affordance via title attribute.

### Buffer fetch strategy

Lazy: only the current route's buffer is fetched on enable. Other routes load on first visit. Audio plays within ~200 ms of toggle-on instead of the 2-3 s a 7-buffer preload would take.

`fetch('/ambient/${routeKey}.opus').then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))`. Errors logged once per route per session — a missing file is non-fatal, just stays silent.

### `scripts/process-ambient.sh`

Already written and run. Two-pass `loudnorm` + libopus VBR @ 96k. Idempotent — re-running overwrites. Inputs: `docs/assets/sound/{home,idle,neurons,queue,chat,search,sources}.mp3`. Outputs: `apps/admin/public/ambient/{landing,idle,neurons,queue,chat,search,sources}.opus`.

## Impact Analysis

### Files affected

**New:**
- `apps/admin/src/lib/ambient-store.ts` — signals + localStorage hydration
- `apps/admin/src/lib/route-to-ambient.ts` — pathname → RouteKey
- `apps/admin/src/components/ambient-provider.tsx` — Web Audio engine
- `apps/admin/src/components/ambient-toggle.tsx` — header button + volume slider
- `apps/admin/public/ambient/{landing,idle,neurons,queue,chat,search,sources}.opus` — converted assets
- `scripts/process-ambient.sh` — MP3 → Opus pipeline (already shipped with this commit)

**Modified:**
- `apps/admin/src/app.tsx` — mount `<AmbientProvider>` at the root, wire `useLocation()` → `ambientRoute.value` via effect, render `<AmbientToggle />` next to the theme toggle
- `apps/admin/package.json` — add `@preact/signals` dep
- `apps/admin/src/locales/en.json` — `nav.ambient.{toggle,volume,on,off}`
- `apps/admin/src/locales/da.json` — same keys, Danish

**Not modified (intentional):**
- No server-side change. Engine is admin-only, Vite serves `public/ambient/*.opus` as static files.
- No package in `packages/**` touched.
- Reader/embed widget (F29) does not get ambient — it's an embeddable component, ambient is a host-app concern.

### Downstream dependents

**`apps/admin/src/app.tsx`** is the route wrapper, imported only by `apps/admin/src/main.tsx`. No further dependents. The added `<AmbientProvider>` wrap is transparent to all child routes.

**`apps/admin/package.json`** — adding `@preact/signals` is additive. No downstream package depends on `@trail/admin` (it's a leaf app).

**`apps/admin/src/locales/{en,da}.json`** are imported only by `apps/admin/src/lib/i18n.ts`. Adding new keys is additive — existing `t('…')` resolutions unchanged. No downstream consumers need updating.

**New files** have no existing dependents (initial consumers: `app.tsx` for `<AmbientProvider>` + `<AmbientToggle>`; the toggle imports the store; the provider imports both store and route-mapping).

### Blast radius

- **AudioContext autoplay policy** (Chrome / Safari / Firefox) — context creation deferred until first `pointerdown` after `enabled === true`. Until then the toggle renders but no audio plays; tooltip explains.
- **Hidden-tab playback** — `document.visibilityState` listener pauses by suspending the context, resumes on visible.
- **Route-change race in StrictMode** — effects double-fire. Engine compares `activeRouteKey.current` to incoming key and returns early on match.
- **Rapid navigation** (clicking tabs fast) — `stop()` *before* `start()` of the new source, single `activeSource` ref. Prior nodes are GC'd via `onended`.
- **Memory** — `AudioBuffer` cache holds decoded PCM. ~10 MB/min at 48 kHz stereo. Current asset set: ~28 min total decoded. Worst case ≈ 270 MB if every route is visited. Acceptable for desktop admin; Sanne's session is hours-long but stays in a few routes. If it bites: add LRU eviction (out of scope v1).
- **Volume zipper noise** — every volume signal change triggers a 150 ms `linearRampToValueAtTime`. Slider drags emit many events; debounce in the UI (50 ms) so the engine sees one ramp per intentful change.
- **iOS Safari** — `decodeAudioData` is promise-based on modern Safari but historically callback-only; use the promise form, fall back to no-op on failure. `AudioContext` requires a fresh user gesture after backgrounding; we resume on next `pointerdown`.
- **`prefers-reduced-motion`** — does *not* gate ambient audio. Reduced-motion is about vestibular/animation; ambient drone is unrelated. (`prefers-reduced-data` would gate the lazy load — we already lazy-load per route, so no extra signal needed.)
- **Bundle size** — `@preact/signals` ~6 KB gzip. Engine + toggle + store ≈ 3 KB gzip. Audio assets are static, served directly by Vite, not in the JS bundle.

### Breaking changes

None. Default state is off; existing UI is byte-identical until the user opts in.

### Test plan

- [ ] TypeScript compiles: `cd apps/admin && pnpm typecheck`
- [ ] Vite build succeeds and copies `public/ambient/*.opus` to `dist/ambient/`
- [ ] Fresh browser, no prior `localStorage` → toggle visible, off, no audio
- [ ] Toggle on → first `pointerdown` resumes context within 500 ms; current route's buffer fetches; audio audible
- [ ] Navigate `/` → `/kb/<id>/queue` → `/kb/<id>/chat` → `/kb/<id>/sources` → `/kb/<id>/neurons` → `/kb/<id>/search`: clean hard cut at each transition, no overlap, no clicks
- [ ] Navigate to `/kb/<id>/glossary` (unmatched) → falls back to `idle.opus`
- [ ] Re-visit a previously-visited route → instant playback (cached buffer, no re-fetch in DevTools Network)
- [ ] Volume slider drag → smooth ramp, no zipper noise
- [ ] Reload page → preference (enabled + volume) restored from `localStorage`; audio off until next gesture
- [ ] Toggle off → 150 ms fade then silence, context suspended (DevTools Memory: source count → 0)
- [ ] Background the tab → audio suspends; foreground → resumes (next gesture if Safari requires)
- [ ] Cross-browser: Chrome / Safari / Firefox desktop; Safari iOS
- [ ] Network: only the active route's `.opus` fetched on enable; others fetched on first visit (DevTools Network)
- [ ] Regression — F87 SSE event stream: badge updates still live; no console errors from `<AmbientProvider>` mount
- [ ] Regression — F91 Neuron editor: save still works, no audio interruption
- [ ] Regression — Modal focus trap (F18 modal.tsx): still works; `<AmbientToggle>` is not in the modal trap

## Implementation Steps

1. ✅ Convert MP3 → Opus via `scripts/process-ambient.sh` (already done with this commit).
2. Add `@preact/signals` to `apps/admin/package.json`.
3. Write `apps/admin/src/lib/ambient-store.ts` (signals + localStorage glue).
4. Write `apps/admin/src/lib/route-to-ambient.ts` (pathname → RouteKey).
5. Write `apps/admin/src/components/ambient-provider.tsx` (Web Audio engine + lifecycle).
6. Write `apps/admin/src/components/ambient-toggle.tsx` (header button + volume slider).
7. Wire into `apps/admin/src/app.tsx`: mount provider, sync `useLocation()` → `ambientRoute`, render toggle.
8. Add `nav.ambient.*` keys to `apps/admin/src/locales/{en,da}.json`.
9. Manual verification against the test plan in Chrome + Safari.
10. Commit: `feat(admin): F94 — ambient audio system per route`.

## Out of scope (v1)

- Re-mastering source assets to consistent 60s loops with seamless 3 s internal crossfades — content task, do once we hear it in use.
- Landing-page (trailmem.com / F34) ambient affordance — admin only in v1.
- Embed widget (F29) ambient — host concern, not Trail's.
- Per-tenant DB-persisted preferences — device-local is correct.
- Analytics on ambient usage — not privacy-worth it.
- LRU buffer eviction — only if memory bites in practice.

## Dependencies

- F18 — Curator UI shell (admin header is where the toggle lives, route map relies on F18's `/kb/<id>/<tab>` layout)

## Effort Estimate

**Small** — ~1 day. New files are small and self-contained; the only existing file with non-trivial wiring is `app.tsx`. Audio assets already converted as part of the plan-doc commit.

## Notes

- F93 (per-click sound feedback) was the wrong interpretation of the original "tilføj lyd-feedback ved knaptryk" prompt. Plan doc kept at `features/F93-button-sound-feedback.md` for reference; nothing implemented from it.
