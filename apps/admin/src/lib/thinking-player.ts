/**
 * F94 — Thinking-cue player. Plays a random short percussive sound layered
 * on top of the ambient loop while the engine is doing work (ingest,
 * candidate resolution, link, compile, etc.). The cue makes engine activity
 * audible to the curator without ever being misread as a notification —
 * it's "the engine is thinking", same metaphor as the visual
 * ProcessingIndicator.
 *
 * Architecture:
 *  - Owns a *separate* AudioContext from <AmbientProvider>. Two contexts
 *    play in parallel; the OS mixer combines them at the device. This keeps
 *    the modules decoupled — no shared state, no singleton bus to maintain.
 *  - Gated on `ambientEnabled` from the store: silent when the user has
 *    ambient off (per Christian: "kun hvis det er tændt").
 *  - Throttled: at most one cue per THROTTLE_MS, so a bulk-resolve burst
 *    (22 candidates approved at once) doesn't overlap-spam the speakers.
 *  - User-gesture handling: AudioContext starts suspended; a one-shot
 *    capture listener on `document` resumes it on the first pointerdown
 *    after `init()`. Subsequent calls play instantly.
 *  - Buffer cache: each cue decoded on first play, reused thereafter.
 */
import { ambientEnabled } from './ambient-store';

const POOL: ReadonlyArray<string> = [
  'thinking_01',
  'thinking_02',
  'thinking_03',
  'thinking_04',
  'thinking_05',
  'thinking_06',
  'thinking_07',
];

/**
 * Minimum gap between cue starts. 800 ms covers the common bulk-burst case
 * (queue auto-approval cascades fire many candidate_resolved events in
 * <100 ms windows) while still letting a manual rhythm of approve-clicks
 * sound responsive.
 */
const THROTTLE_MS = 800;

/** Per-cue gain. Tuned by ear against an ambient master at 0.6. */
const CUE_GAIN = 0.55;

let ctx: AudioContext | null = null;
let dest: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer | null>>();
let lastPlayedAt = 0;
let initialized = false;
let gestureHandler: (() => void) | null = null;

function audioCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return (w.AudioContext ?? w.webkitAudioContext) ?? null;
}

function ensureContext(): boolean {
  if (ctx) return true;
  const Ctor = audioCtor();
  if (!Ctor) return false;
  try {
    ctx = new Ctor();
    dest = ctx.createGain();
    dest.gain.value = CUE_GAIN;
    dest.connect(ctx.destination);
    return true;
  } catch {
    ctx = null;
    dest = null;
    return false;
  }
}

async function loadBuffer(key: string): Promise<AudioBuffer | null> {
  if (!ctx) return null;
  const cached = buffers.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const res = await fetch(`/thinking/${key}.opus`);
      if (!res.ok) throw new Error(`${res.status}`);
      const ab = await res.arrayBuffer();
      const buf = await ctx!.decodeAudioData(ab);
      buffers.set(key, buf);
      return buf;
    } catch (err) {
      console.warn(`[thinking] failed to load ${key}.opus`, err);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/**
 * Mount the gesture-listener exactly once. Subsequent calls are no-ops.
 * Must be called from a Preact component effect so React lifecycle owns
 * the cleanup.
 */
export function initThinking(): () => void {
  if (initialized) return () => undefined;
  initialized = true;
  ensureContext();
  gestureHandler = () => {
    if (ctx?.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
  };
  document.addEventListener('pointerdown', gestureHandler, true);
  document.addEventListener('keydown', gestureHandler, true);
  return () => {
    if (gestureHandler) {
      document.removeEventListener('pointerdown', gestureHandler, true);
      document.removeEventListener('keydown', gestureHandler, true);
      gestureHandler = null;
    }
    // Don't close the context on unmount — cues that fire during a
    // hot-reload would otherwise sometimes catch a closed context. The
    // browser reclaims the context at tab-close.
    initialized = false;
  };
}

/**
 * Play one random thinking cue. No-op if ambient is off, if the throttle
 * window is still open, if the AudioContext failed to init, or if the
 * context is still suspended (no user gesture yet).
 */
export function playThinking(): void {
  if (!ambientEnabled.value) return;
  const now = performance.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  if (!ensureContext() || !ctx || !dest) return;
  if (ctx.state !== 'running') return;
  if (typeof document !== 'undefined' && document.hidden) return;
  lastPlayedAt = now;
  const key = POOL[Math.floor(Math.random() * POOL.length)]!;
  void (async () => {
    const buf = await loadBuffer(key);
    if (!buf || !ctx || !dest) return;
    try {
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(dest);
      node.start();
      node.onended = () => {
        try {
          node.disconnect();
        } catch {
          /* already disconnected */
        }
      };
    } catch {
      /* ctx may have closed mid-flight */
    }
  })();
}
