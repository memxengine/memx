/**
 * Neuron-constellation background, ported verbatim from the landing site
 * (examples/static/trail/dist/index.html). A fixed canvas covering the
 * viewport: since it's viewport-bound not document-bound, scrolling long
 * pages shows the stars as continuous — "infinitely downward" — which is
 * the effect we want without computing per-scroll.
 *
 * Colours are read from CSS variables so light/dark themes both look
 * right without swapping canvas code.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseRadius: number;
  isAccent: boolean;
}

export function mountConstellation(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let particles: Particle[] = [];
  let frame = 0;
  const mouse: { x: number | null; y: number | null } = { x: null, y: null };

  function readVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function initParticles(): void {
    particles = [];
    const count = Math.floor((window.innerWidth * window.innerHeight) / 15000);
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
    const nodeColor = readVar('--graph-node', '#1a1715');
    const accentColor = readVar('--graph-accent', '#e8a87c');
    const lineRgb = readVar('--graph-line', '26, 23, 21');
    const accentLineRgb = readVar('--graph-accent-line', '232, 168, 124');

    ctx!.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      // Only flip velocity when the particle is moving FURTHER out of bounds.
      // A bare `x < 0 || x > w` check flip-flops every frame when a particle
      // has drifted past the edge (e.g. after a mouse-push or a window
      // resize) — the velocity inverts, but the position is still outside,
      // so next frame the check fires again. Net motion becomes zero and
      // the constellation looks frozen. Bounding by intent fixes it.
      if ((p.x < 0 && p.vx < 0) || (p.x > window.innerWidth && p.vx > 0)) p.vx = -p.vx;
      if ((p.y < 0 && p.vy < 0) || (p.y > window.innerHeight && p.vy > 0)) p.vy = -p.vy;
      if (mouse.x !== null && mouse.y !== null) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < 100) { p.x -= dx * 0.01; p.y -= dy * 0.01; }
      }
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, p.baseRadius, 0, Math.PI * 2);
      ctx!.fillStyle = p.isAccent ? accentColor : nodeColor;
      ctx!.shadowBlur = p.isAccent ? 10 : 0;
      ctx!.shadowColor = p.isAccent ? accentColor : 'transparent';
      ctx!.fill();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i]!;
        const b = particles[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d >= 160) continue;
        const opacity = 1 - d / 160;
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

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseout', onMouseOut);
  };
}
