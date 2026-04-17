/**
 * Neuron-constellation background.
 *
 * A fixed canvas covering the viewport; since it's viewport-bound not
 * document-bound, scrolling shows continuous stars without per-scroll
 * computation. Colors come from CSS custom properties so both themes
 * render correctly without swapping canvas code.
 *
 * Hardened for long-running dev sessions:
 *   - Singleton via globalThis so HMR reloads don't accumulate rAF loops
 *     running in parallel (was the symptom: browser CPU ramped up every
 *     time the module hot-reloaded — multiple animations on one canvas).
 *   - Paused when `document.visibilityState !== 'visible'` — a background
 *     tab shouldn't burn CPU redrawing a canvas nobody sees.
 *   - Squared-distance pair-check avoids a sqrt() per pair; CSS vars are
 *     resolved once per frame instead of once per particle.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseRadius: number;
  isAccent: boolean;
}

interface Runtime {
  canvas: HTMLCanvasElement;
  dispose: () => void;
}

const GLOBAL_KEY = '__trailConstellation__' as const;
type GlobalWithRuntime = { [GLOBAL_KEY]?: Runtime };

export function mountConstellation(canvas: HTMLCanvasElement): () => void {
  const g = globalThis as unknown as GlobalWithRuntime;

  // HMR guard: if a previous module-load already mounted a runtime, dispose
  // it before starting a fresh one. Without this, old rAF loops keep
  // running after each HMR reload and the browser eventually melts.
  const existing = g[GLOBAL_KEY];
  if (existing) {
    existing.dispose();
    delete g[GLOBAL_KEY];
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const LINK_RADIUS = 160;
  const LINK_RADIUS_SQ = LINK_RADIUS * LINK_RADIUS;
  let particles: Particle[] = [];
  let frame = 0;
  let disposed = false;
  const mouse: { x: number | null; y: number | null } = { x: null, y: null };

  function readVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function initParticles(): void {
    particles = [];
    // Density capped so a 4K monitor doesn't explode the pair-loop: 1 particle
    // per 18k pixels + absolute ceiling of 150. 150² / 2 = 11 250 pair checks
    // per frame — plenty for an associative-graph aesthetic, nothing near a
    // CPU bottleneck on M1.
    const raw = Math.floor((window.innerWidth * window.innerHeight) / 18_000);
    const count = Math.min(raw, 150);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        baseRadius: Math.random() > 0.95 ? 3 : 1.5,
        isAccent: Math.random() > 0.98,
      });
    }
  }

  function resize(): void {
    canvas.width = window.innerWidth * DPR;
    canvas.height = window.innerHeight * DPR;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    initParticles();
  }

  function draw(): void {
    if (disposed) return;

    // Skip the whole frame when the tab is hidden. rAF already throttles to
    // ~1 Hz in background tabs, but we were still doing pair-checks per
    // scheduled frame. Zero work beats throttled work.
    if (document.visibilityState !== 'visible') {
      frame = requestAnimationFrame(draw);
      return;
    }

    const nodeColor = readVar('--graph-node', '#1a1715');
    const accentColor = readVar('--graph-accent', '#e8a87c');
    const lineRgb = readVar('--graph-line', '26, 23, 21');
    const accentLineRgb = readVar('--graph-accent-line', '232, 168, 124');
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    ctx!.clearRect(0, 0, vw, vh);

    // Particle update + draw. Reflection check bounces only when the
    // velocity is actively pushing the particle further out of bounds —
    // a bare `x < 0 || x > w` would flip-flop particles that drifted past
    // the edge (e.g. after a resize) and freeze them there.
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if ((p.x < 0 && p.vx < 0) || (p.x > vw && p.vx > 0)) p.vx = -p.vx;
      if ((p.y < 0 && p.vy < 0) || (p.y > vh && p.vy > 0)) p.vy = -p.vy;

      if (mouse.x !== null && mouse.y !== null) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < 10_000) {
          p.x -= dx * 0.01;
          p.y -= dy * 0.01;
        }
      }

      ctx!.beginPath();
      ctx!.arc(p.x, p.y, p.baseRadius, 0, Math.PI * 2);
      ctx!.fillStyle = p.isAccent ? accentColor : nodeColor;
      ctx!.fill();
    }

    // Pair-drawing with squared-distance early bail. sqrt is only needed
    // when we actually render the line (to compute opacity) — can also
    // approximate via dSq/LINK_RADIUS_SQ but the single sqrt per visible
    // line is cheap compared to the bail savings.
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i]!;
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dSq = dx * dx + dy * dy;
        if (dSq >= LINK_RADIUS_SQ) continue;
        const d = Math.sqrt(dSq);
        const opacity = 1 - d / LINK_RADIUS;
        ctx!.beginPath();
        ctx!.strokeStyle =
          a.isAccent || b.isAccent
            ? `rgba(${accentLineRgb}, ${opacity * 0.5})`
            : `rgba(${lineRgb}, ${opacity * 0.18})`;
        ctx!.lineWidth = 0.6;
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }
    }

    frame = requestAnimationFrame(draw);
  }

  function onMouseMove(e: MouseEvent): void {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
  function onMouseOut(): void {
    mouse.x = null;
    mouse.y = null;
  }

  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseout', onMouseOut);

  resize();
  draw();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseout', onMouseOut);
    if (g[GLOBAL_KEY] === runtime) delete g[GLOBAL_KEY];
  };

  const runtime: Runtime = { canvas, dispose };
  g[GLOBAL_KEY] = runtime;
  return dispose;
}
