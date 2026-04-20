/**
 * F94 — Ambient audio store. Three signals (enabled, volume, route) plus
 * device-local persistence. Hydration runs on module load; mutations write
 * back through `effect()` so the engine, the toggle UI, and the volume
 * slider all observe the same source of truth.
 *
 * Persistence is per-device, per-browser via localStorage. Audio prefs
 * don't belong in the user account — different machines have different
 * speakers, headphones, room acoustics.
 */
import { signal, effect } from '@preact/signals';
import { routeFromPath } from './route-to-ambient';

export type RouteKey = 'landing' | 'neurons' | 'queue' | 'chat' | 'search' | 'sources' | 'idle';

export const ALL_ROUTES: ReadonlyArray<RouteKey> = [
  'landing',
  'neurons',
  'queue',
  'chat',
  'search',
  'sources',
  'idle',
];

const KEY_ENABLED = 'trailmem.ambient.enabled';
const KEY_VOLUME = 'trailmem.ambient.volume';

function readEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(KEY_ENABLED) === 'true';
}

function readVolume(): number {
  if (typeof localStorage === 'undefined') return 0.6;
  const raw = localStorage.getItem(KEY_VOLUME);
  if (raw === null) return 0.6;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(1, n));
}

/**
 * Initial route is derived from the current pathname at module load
 * so a full-page reload on `/kb/.../graph` starts directly on the
 * `neurons` track — no landing-then-neurons swap, no ~100 ms silent
 * gap during the hard cut. SSR-safe: falls back to `landing` when
 * window is undefined.
 */
function initialRouteFromLocation(): RouteKey {
  if (typeof window === 'undefined') return 'landing';
  return routeFromPath(window.location.pathname);
}

export const ambientEnabled = signal<boolean>(readEnabled());
export const ambientVolume = signal<number>(readVolume());
export const ambientRoute = signal<RouteKey>(initialRouteFromLocation());

// Persist on change. effect() runs once eagerly, so we guard the first
// run to avoid writing the hydrated value back into localStorage and
// thrashing on hot-reload.
let hydrated = false;
effect(() => {
  const enabled = ambientEnabled.value;
  const volume = ambientVolume.value;
  if (!hydrated) {
    hydrated = true;
    return;
  }
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY_ENABLED, String(enabled));
  localStorage.setItem(KEY_VOLUME, volume.toFixed(2));
});
