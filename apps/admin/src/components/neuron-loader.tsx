/**
 * NeuronLoader — themed loading animation for long-running LLM actions.
 *
 * Procedural: neuron count auto-scales with `size` so the animation reads
 * well at any dimension. At 20px (button inline) you get 5 calm dots; at
 * 320px (hero splash) you get ~50 in a brain-like constellation. Each
 * neuron pulses on its own period; when it hits peak-glow it fires a
 * one-shot synapse to a random other neuron whose current target queue
 * isn't booked. Positions follow a golden-angle spiral so placement is
 * dense-but-organic and scales to any N without overlap.
 *
 * The JS scheduler emits firings synchronised to CSS pulse peaks. CSS
 * handles the breathing animation (inline animation-duration/-delay per
 * circle), JS handles which neuron fires to whom (state-driven <line>
 * elements with a one-shot keyframe).
 *
 * Colour follows the surrounding text via `currentColor` on the ring.
 * Each neuron carries a deterministic accent-shade. Respects
 * `prefers-reduced-motion`.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';

interface Props {
  /** Pixel size of the loader (square). */
  size?: number;
  /** Optional label rendered next to the animation. */
  label?: string;
  /**
   * Explicit neuron count. Overrides the size-based auto-density curve.
   * Use for /play showcase sliders or any caller that wants to tune.
   */
  count?: number;
}

interface NeuronDef {
  id: number;
  x: number;
  y: number;
  /** SVG circle radius (viewBox units). Smaller at higher densities so
   *  neighbours don't overlap. */
  r: number;
  /** CSS animation-duration in ms — cycle period. */
  period: number;
  /** CSS animation-delay in ms — phase shift at mount. */
  phase: number;
  /** Colour-mix expression from the trail accent family. */
  colour: string;
}

// 8 deterministic shades of var(--color-accent). Every neuron picks from
// the same family so the cluster reads as one continuous gradient rather
// than a rainbow. Order rotates through white-tinted and black-tinted
// variants for contrast.
const ACCENT_SHADES: readonly string[] = [
  'var(--color-accent)',
  'color-mix(in srgb, var(--color-accent) 90%, white 10%)',
  'color-mix(in srgb, var(--color-accent) 80%, white 20%)',
  'color-mix(in srgb, var(--color-accent) 75%, white 25%)',
  'color-mix(in srgb, var(--color-accent) 85%, black 15%)',
  'color-mix(in srgb, var(--color-accent) 70%, black 30%)',
  'color-mix(in srgb, var(--color-accent) 60%, black 40%)',
  'color-mix(in srgb, var(--color-accent) 92%, black 8%)',
];

// Golden angle (~137.5°). Using it as the step between successive
// spiral points gives a phyllotactic (sunflower-seed) distribution —
// dense, visually irregular, no overlap for reasonable point counts.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Map display size → neuron count. Tuned so a button-size loader reads
 * as "waiting" and a hero-size loader reads as "thinking network".
 *
 *   ≤ 32px → 5       compact, unmistakably a progress indicator
 *   ≤ 80px → 10      balanced, default button+label scale
 *   ≤ 160px → 20     medium, richer network feel
 *   ≤ 240px → 32     dense, anchor for a waiting card
 *   > 240px → 50     hero, full brain constellation
 */
function densityForSize(size: number): number {
  if (size <= 32) return 5;
  if (size <= 80) return 10;
  if (size <= 160) return 20;
  if (size <= 240) return 32;
  return 50;
}

/**
 * Place `count` neurons on a golden-angle spiral centred on the 80×80
 * viewBox. Deterministic — same count always yields same positions, so
 * re-renders don't reflow. Each neuron gets a period+phase varied by its
 * index so no two fire in lockstep.
 */
function generateNeurons(count: number): NeuronDef[] {
  const center = 40;
  // Radius shrinks with density so circles don't touch.
  const neuronRadius =
    count <= 5 ? 4 : count <= 10 ? 3.2 : count <= 20 ? 2.5 : count <= 35 ? 2.0 : 1.6;
  // Target: outermost neuron edge lands ~3.7 viewBox units inside the
  // min-scale ring inner edge (≈36.7). At 320 px render that's ~15 px
  // clearance — reads as "contained" without the big doughnut of empty
  // space we had before. Peak-pulse (1.65×) briefly crosses on large
  // neurons but clears visibly on the 50-count hero where it matters.
  const maxDistance = 33 - neuronRadius;
  // Spiral constant: last neuron (i=count-1) lands ~at maxDistance.
  const c = count <= 1 ? 0 : maxDistance / Math.sqrt(count - 1);

  const neurons: NeuronDef[] = [];
  for (let i = 0; i < count; i++) {
    const angle = i * GOLDEN_ANGLE;
    const distance = c * Math.sqrt(i);
    neurons.push({
      id: i + 1,
      x: center + distance * Math.cos(angle),
      y: center + distance * Math.sin(angle),
      r: neuronRadius,
      // Periods 1200-1999ms, varied per index via prime multiplier so
      // adjacent neurons don't share a cadence.
      period: 1200 + (i * 73) % 800,
      // Phases spread across 2000ms window so the initial firing storm
      // isn't synchronised.
      phase: (i * 271) % 2000,
      colour: ACCENT_SHADES[i % ACCENT_SHADES.length]!,
    });
  }
  return neurons;
}

interface Firing {
  key: number;
  fromId: number;
  toId: number;
  duration: number;
  colour: string;
}

export function NeuronLoader({ size = 20, label, count }: Props) {
  const uid = useId().replace(/:/g, '');
  const scope = `nl-${uid}`;
  // Count is auto-derived from size unless the caller overrides. Memoed
  // so we don't regenerate positions every render.
  const neurons = useMemo(
    () => generateNeurons(count ?? densityForSize(size)),
    [count, size],
  );
  const [firings, setFirings] = useState<Firing[]>([]);
  const firingsRef = useRef<Firing[]>([]);
  const keyCounter = useRef(0);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const fireFrom = (n: NeuronDef): void => {
      // Pick a random OTHER neuron as target, preferring those not
      // currently being targeted by an active firing so two synapses
      // don't converge. Falls back to the full pool when every other
      // neuron is already a target.
      const occupied = new Set(firingsRef.current.map((f) => f.toId));
      const others = neurons.filter((m) => m.id !== n.id);
      const available = others.filter((o) => !occupied.has(o.id));
      const pool = available.length > 0 ? available : others;
      if (pool.length === 0) return;
      const target = pool[Math.floor(Math.random() * pool.length)]!;

      const key = ++keyCounter.current;
      const next: Firing = {
        key,
        fromId: n.id,
        toId: target.id,
        duration: n.period,
        colour: n.colour,
      };

      firingsRef.current = [...firingsRef.current, next];
      setFirings(firingsRef.current);

      timers.push(
        setTimeout(() => {
          firingsRef.current = firingsRef.current.filter((f) => f.key !== key);
          setFirings(firingsRef.current);
        }, n.period + 50),
      );
    };

    neurons.forEach((n) => {
      timers.push(
        setTimeout(() => {
          fireFrom(n);
          const interval = setInterval(() => fireFrom(n), n.period);
          timers.push(interval as ReturnType<typeof setTimeout>);
        }, n.phase),
      );
    });

    return () => {
      timers.forEach((t) => {
        clearTimeout(t);
        clearInterval(t);
      });
      firingsRef.current = [];
      setFirings([]);
    };
  }, [neurons]);

  // Synapse stroke thickness scales inversely with density so a
  // 50-neuron constellation doesn't drown in lines. Matches neuron
  // radius roughly: denser cluster → thinner lines.
  const synapseStroke = neurons[0]?.r ?? 3;

  return (
    <span class="inline-flex items-center gap-2 align-middle">
      <svg
        viewBox="0 0 80 80"
        width={size}
        height={size}
        overflow="visible"
        class={`${scope} shrink-0 overflow-visible`}
        aria-label="loading"
        role="img"
      >
        <style>{css(scope)}</style>
        {/* Pulse ring — CMS-matched proportion. See earlier comment
            history for the 1.143 ratio derivation. */}
        <circle
          cx="40"
          cy="40"
          r="45.75"
          fill="none"
          stroke="currentColor"
          stroke-width="4.3"
          class={`${scope}-ring`}
        />
        {/* Synapses — dynamically rendered per active firing. */}
        <g fill="none" stroke-width={synapseStroke * 0.45} stroke-linecap="round">
          {firings.map((f) => {
            const from = neurons.find((n) => n.id === f.fromId);
            const to = neurons.find((n) => n.id === f.toId);
            if (!from || !to) return null;
            return (
              <line
                key={f.key}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={f.colour}
                class={`${scope}-fire`}
                style={`animation-duration: ${f.duration}ms`}
              />
            );
          })}
        </g>
        {/* Neurons — pulsing nodes. Per-neuron animation-duration +
            animation-delay inline so we don't need a generated CSS
            class per neuron. */}
        <g>
          {neurons.map((n) => (
            <circle
              key={n.id}
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={n.colour}
              class={`${scope}-n`}
              style={`color: ${n.colour}; animation-duration: ${n.period}ms; animation-delay: ${n.phase}ms`}
            />
          ))}
        </g>
      </svg>
      {label ? <span class="text-xs">{label}</span> : null}
    </span>
  );
}

function css(s: string): string {
  return `
    .${s}-ring {
      transform-box: fill-box;
      transform-origin: center;
      animation: ${s}-ring-pulse 2.4s ease-in-out infinite;
    }
    @keyframes ${s}-ring-pulse {
      0%, 100% { transform: scale(0.85); opacity: 0.15; }
      50%      { transform: scale(1.1);  opacity: 0.05; }
    }

    /* Neurons — one shared keyframe, per-neuron animation-duration +
       animation-delay set inline via style. transform-box:fill-box
       lets scale() act on the circle's own box. */
    .${s}-n {
      transform-box: fill-box;
      transform-origin: center;
      animation-name: ${s}-pulse;
      animation-timing-function: ease-in-out;
      animation-iteration-count: infinite;
    }
    @keyframes ${s}-pulse {
      0%, 100% { transform: scale(0.75); opacity: 0.6; filter: none; }
      50% { transform: scale(1.65); opacity: 1; filter: drop-shadow(0 0 7px currentColor) drop-shadow(0 0 16px currentColor); }
    }

    .${s}-fire {
      stroke-dasharray: 50;
      stroke-dashoffset: 50;
      opacity: 0.25;
      animation-name: ${s}-fire-kf;
      animation-iteration-count: 1;
      animation-timing-function: ease-out;
      animation-fill-mode: forwards;
    }
    @keyframes ${s}-fire-kf {
      0%    { stroke-dashoffset: 50;  opacity: 0.25; }
      40%   { stroke-dashoffset: 10;  opacity: 0.6; }
      50%   { stroke-dashoffset: 0;   opacity: 1; }
      65%   { stroke-dashoffset: -25; opacity: 0.85; }
      100%  { stroke-dashoffset: -50; opacity: 0.25; }
    }

    @media (prefers-reduced-motion: reduce) {
      .${s}-n { animation: none; opacity: 0.8; }
      .${s}-ring { animation: none; opacity: 0.1; }
    }
  `;
}
