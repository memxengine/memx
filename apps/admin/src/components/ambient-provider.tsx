/**
 * F94 — Ambient audio engine. Owns the single shared AudioContext and master
 * GainNode. Subscribes to the three signals in `lib/ambient-store.ts` and
 * reacts:
 *
 *   ambientEnabled true  → resume context on next user gesture, start
 *                          current route's source
 *   ambientEnabled false → fade master to 0, stop active source, suspend ctx
 *   ambientRoute change  → stop active source, start the new one (hard cut)
 *   ambientVolume change → 150 ms linear ramp on the master gain
 *
 * Buffers are decoded on first visit and cached per route. Returning to a
 * previously-visited route reuses the buffer — no re-fetch, no re-decode.
 *
 * Browsers block AudioContext until a user gesture. We never auto-start;
 * the toggle reflects intent (`enabled === true`) and the engine resumes
 * on the first `pointerdown` after toggle-on. While suspended, the toggle's
 * tooltip explains "tap to resume".
 */
import { useEffect, useRef } from 'preact/hooks';
import { effect } from '@preact/signals';
import {
  ambientEnabled,
  ambientRoute,
  ambientVolume,
  type RouteKey,
} from '../lib/ambient-store';

const RAMP_SEC = 0.15;

type Refs = {
  ctx: AudioContext | null;
  master: GainNode | null;
  buffers: Map<RouteKey, AudioBuffer>;
  inflight: Map<RouteKey, Promise<AudioBuffer | null>>;
  source: AudioBufferSourceNode | null;
  activeKey: RouteKey | null;
  pendingGestureSwap: boolean;
};

function audioCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return (w.AudioContext ?? w.webkitAudioContext) ?? null;
}

function ensureContext(refs: Refs): boolean {
  if (refs.ctx) return true;
  const Ctor = audioCtor();
  if (!Ctor) return false;
  try {
    refs.ctx = new Ctor();
    refs.master = refs.ctx.createGain();
    refs.master.gain.value = ambientVolume.value;
    refs.master.connect(refs.ctx.destination);
    return true;
  } catch {
    refs.ctx = null;
    refs.master = null;
    return false;
  }
}

async function loadBuffer(refs: Refs, key: RouteKey): Promise<AudioBuffer | null> {
  if (!refs.ctx) return null;
  const cached = refs.buffers.get(key);
  if (cached) return cached;
  const inflight = refs.inflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const res = await fetch(`/ambient/${key}.opus`);
      if (!res.ok) throw new Error(`${res.status}`);
      const ab = await res.arrayBuffer();
      const buf = await refs.ctx!.decodeAudioData(ab);
      refs.buffers.set(key, buf);
      return buf;
    } catch (err) {
      console.warn(`[ambient] failed to load ${key}.opus`, err);
      return null;
    } finally {
      refs.inflight.delete(key);
    }
  })();
  refs.inflight.set(key, promise);
  return promise;
}

function stopActive(refs: Refs): void {
  const src = refs.source;
  refs.source = null;
  refs.activeKey = null;
  if (!src) return;
  try {
    src.stop();
    src.disconnect();
  } catch {
    /* already stopped */
  }
}

async function swapTo(refs: Refs, key: RouteKey): Promise<void> {
  if (!refs.ctx || !refs.master) return;
  if (refs.activeKey === key && refs.source) return;
  const buf = await loadBuffer(refs, key);
  if (!buf || !refs.ctx || !refs.master) return;
  if (!ambientEnabled.value) return; // toggled off mid-load
  stopActive(refs);
  const node = refs.ctx.createBufferSource();
  node.buffer = buf;
  node.loop = true;
  node.connect(refs.master);
  node.start();
  refs.source = node;
  refs.activeKey = key;
}

/**
 * Mounted once near the app root. Renders nothing — pure side-effects.
 */
export function AmbientProvider() {
  const refs = useRef<Refs>({
    ctx: null,
    master: null,
    buffers: new Map(),
    inflight: new Map(),
    source: null,
    activeKey: null,
    pendingGestureSwap: false,
  });

  useEffect(() => {
    const r = refs.current;

    const tryGestureSwap = () => {
      if (!ambientEnabled.value) return;
      if (!ensureContext(r)) return;
      if (r.ctx?.state === 'suspended') {
        r.ctx.resume().catch(() => {
          /* user denied / not yet allowed */
        });
      }
      if (r.pendingGestureSwap) {
        r.pendingGestureSwap = false;
        void swapTo(r, ambientRoute.value);
      }
    };
    document.addEventListener('pointerdown', tryGestureSwap, true);
    document.addEventListener('keydown', tryGestureSwap, true);

    const onVisibility = () => {
      if (!r.ctx) return;
      if (document.hidden) {
        r.ctx.suspend().catch(() => undefined);
      } else if (ambientEnabled.value) {
        r.ctx.resume().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const stopEnabled = effect(() => {
      const enabled = ambientEnabled.value;
      if (enabled) {
        if (!ensureContext(r) || !r.ctx || !r.master) return;
        // Restore master gain in case it was ramped to 0 on the previous off.
        const now = r.ctx.currentTime;
        r.master.gain.cancelScheduledValues(now);
        r.master.gain.setValueAtTime(r.master.gain.value, now);
        r.master.gain.linearRampToValueAtTime(ambientVolume.value, now + RAMP_SEC);
        if (r.ctx.state === 'suspended') {
          r.pendingGestureSwap = true;
          r.ctx.resume().catch(() => undefined);
        } else {
          void swapTo(r, ambientRoute.value);
        }
      } else if (r.ctx && r.master) {
        const now = r.ctx.currentTime;
        const targetMaster = r.master;
        r.master.gain.cancelScheduledValues(now);
        r.master.gain.setValueAtTime(r.master.gain.value, now);
        r.master.gain.linearRampToValueAtTime(0, now + RAMP_SEC);
        const delay = Math.ceil(RAMP_SEC * 1000) + 20;
        setTimeout(() => {
          stopActive(r);
          r.ctx?.suspend().catch(() => undefined);
          // Reset gain back to user volume so the next enable doesn't start at 0.
          if (r.ctx && targetMaster) {
            targetMaster.gain.setValueAtTime(ambientVolume.value, r.ctx.currentTime);
          }
        }, delay);
      }
    });

    const stopRoute = effect(() => {
      const key = ambientRoute.value;
      if (!ambientEnabled.value) return;
      if (!r.ctx || r.ctx.state !== 'running') return;
      void swapTo(r, key);
    });

    const stopVolume = effect(() => {
      const v = ambientVolume.value;
      if (!r.ctx || !r.master) return;
      if (!ambientEnabled.value) return;
      const now = r.ctx.currentTime;
      r.master.gain.cancelScheduledValues(now);
      r.master.gain.setValueAtTime(r.master.gain.value, now);
      r.master.gain.linearRampToValueAtTime(v, now + RAMP_SEC);
    });

    return () => {
      document.removeEventListener('pointerdown', tryGestureSwap, true);
      document.removeEventListener('keydown', tryGestureSwap, true);
      document.removeEventListener('visibilitychange', onVisibility);
      stopEnabled();
      stopRoute();
      stopVolume();
      stopActive(r);
      r.ctx?.close().catch(() => undefined);
      r.ctx = null;
      r.master = null;
      r.buffers.clear();
      r.inflight.clear();
    };
  }, []);

  return null;
}
