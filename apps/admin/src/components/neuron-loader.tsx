/**
 * NeuronLoader — themed loading animation for long-running LLM actions.
 *
 * Five nodes (Neurons) arranged in a tight cluster, each pulsing at its
 * own cadence. When a neuron reaches peak glow it fires a synapse to ONE
 * other neuron, picked at random from those not currently being targeted
 * by another firing. The target rotates each cycle — the graph is alive,
 * not a fixed wiring diagram.
 *
 * Pure SVG + CSS keyframes for the neuron pulses. Synapses are JS-driven
 * state so targets can change every firing without re-running CSS
 * animations. Line-level animation (`animation-iteration-count: 1`)
 * plays once per firing and the entry is garbage-collected from state
 * after its duration expires.
 *
 * Colour follows the surrounding text via `currentColor`. Respects
 * `prefers-reduced-motion`: users with that preference get a static
 * neuron layout and the synapse scheduler is halted.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks';

interface Props {
  /** Pixel size of the loader (square). Defaults to 20px — fits inside a button row. */
  size?: number;
  /** Optional label rendered next to the animation. */
  label?: string;
}

interface NeuronDef {
  id: number;
  x: number;
  y: number;
  /** CSS animation-duration in ms — cycle period. */
  period: number;
  /** CSS animation-delay in ms — phase shift at mount. */
  phase: number;
  /**
   * Bauhaus-palette colour for this neuron. Red / Yellow / Blue are the
   * canonical primaries; orange + teal fill the 5-slot requirement
   * with tints that sit on the Itten colour wheel between the primaries
   * rather than introducing an unrelated accent. Synapses originating
   * from this neuron inherit its colour so you can see a red pulse
   * propagate as a red line, etc.
   */
  colour: string;
}

// Neuron positions live in an 80×80 coord system centred on (40,40).
// The larger viewBox (vs the previous 64×64) gives the pulse ring room
// to breathe — with r=36 centred on (40,40), there's 14 units of clear
// air between the farthest neuron and the ring instead of 8.
const NEURONS: NeuronDef[] = [
  // Seven shades, all rooted in var(--color-accent). color-mix keeps
  // them in the trail warm-amber family — lighter tints blend with
  // white, darker ones with black. Same hue family, different
  // lightness. A firing from neuron N uses its own shade as stroke
  // colour so the pulse propagates the tint along the line.
  //
  // Positions: top/left/right/bottom-left/bottom-right on the original
  // pentagonal cluster, plus two upper-flank neurons at (26,28) and
  // (54,28) that fill the upper side-gaps without exiting the ring
  // clearance. All 7 neurons stay within 22.36 distance from centre.
  { id: 1, x: 40, y: 16,   period: 1400, phase: 0,    colour: 'var(--color-accent)' },
  { id: 2, x: 16, y: 40,   period: 1700, phase: 350,  colour: 'color-mix(in srgb, var(--color-accent) 85%, white 15%)' },
  { id: 3, x: 64, y: 40,   period: 1250, phase: 800,  colour: 'color-mix(in srgb, var(--color-accent) 75%, black 25%)' },
  { id: 4, x: 28, y: 64,   period: 1850, phase: 1100, colour: 'color-mix(in srgb, var(--color-accent) 90%, white 10%)' },
  { id: 5, x: 52, y: 64,   period: 1550, phase: 550,  colour: 'color-mix(in srgb, var(--color-accent) 65%, black 35%)' },
  { id: 6, x: 23, y: 26,   period: 1600, phase: 200,  colour: 'color-mix(in srgb, var(--color-accent) 80%, white 20%)' },
  { id: 7, x: 57, y: 26,   period: 1350, phase: 900,  colour: 'color-mix(in srgb, var(--color-accent) 70%, black 30%)' },
  { id: 8, x: 23, y: 54,   period: 1900, phase: 1250, colour: 'color-mix(in srgb, var(--color-accent) 75%, white 25%)' },
  { id: 9, x: 57, y: 54,   period: 1300, phase: 450,  colour: 'color-mix(in srgb, var(--color-accent) 60%, black 40%)' },
  // Centre neuron — visually anchors the cluster. Slightly richer
  // accent so it reads as "the nucleus" even when surrounded by its
  // 9 satellite siblings. Its firings radiate outward in every
  // direction over time since all 9 others are valid targets.
  { id: 10, x: 40, y: 40, period: 1750, phase: 700, colour: 'color-mix(in srgb, var(--color-accent) 92%, black 8%)' },
];

interface Firing {
  /** Unique key for React/Preact reconciliation. */
  key: number;
  fromId: number;
  toId: number;
  /** Matches source neuron's period — firing's 50% = neuron's peak. */
  duration: number;
  /** Source neuron's colour — the firing propagates that tint along the line. */
  colour: string;
}

export function NeuronLoader({ size = 20, label }: Props) {
  const uid = useId().replace(/:/g, '');
  const scope = `nl-${uid}`;
  const [firings, setFirings] = useState<Firing[]>([]);
  const firingsRef = useRef<Firing[]>([]);
  const keyCounter = useRef(0);

  useEffect(() => {
    // Honour reduced-motion: skip the scheduler entirely, static layout only.
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const fireFrom = (n: NeuronDef): void => {
      // Pick a random OTHER neuron as target. Avoid neurons that are
      // currently being targeted by an active firing so two synapses
      // don't converge on the same node at the same moment. Fall back
      // to the full pool when every other neuron is already booked.
      const occupied = new Set(firingsRef.current.map((f) => f.toId));
      const others = NEURONS.filter((m) => m.id !== n.id);
      const available = others.filter((o) => !occupied.has(o.id));
      const pool = available.length > 0 ? available : others;
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

      // Clean up when the one-shot animation finishes. Keeps the state
      // array bounded — always ≤ number of active firings.
      timers.push(
        setTimeout(() => {
          firingsRef.current = firingsRef.current.filter((f) => f.key !== key);
          setFirings(firingsRef.current);
        }, n.period + 50),
      );
    };

    // Schedule each neuron's first firing at its cycle-start (phase), so
    // the firing's 50%-mark lands on the neuron's peak (phase + period/2),
    // which matches the CSS pulse keyframe's 50% max-glow. Each subsequent
    // firing is one period later — locked to the visual cadence.
    NEURONS.forEach((n) => {
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
    };
  }, []);

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
        {/* Pulse ring — SAME diameter as cms-core's ThinkingAnimation at
            any matching `size` prop. CMS: container 28, ring diameter 32
            (inset -2 on each side) → ring/size ratio = 32/28 = 1.143.
            Our viewBox is 80; to get ring_diameter/size = 1.143 at any
            display size, ring_diameter in viewBox must be 80 * 1.143 =
            91.5 → r=45.75. Stroke 4.3 = same 4.7% of ring-diameter
            ratio cms uses (1.5/32). Ring extends beyond viewBox; the
            SVG's overflow="visible" lets it render out to the full
            cms-matching size. At peak pulse (1.1), the ring still
            clears the peak-neuron extent (26.56) by ~23 units —
            guaranteed never to touch a neuron. */}
        <circle
          cx="40"
          cy="40"
          r="45.75"
          fill="none"
          stroke="currentColor"
          stroke-width="4.3"
          class={`${scope}-ring`}
        />
        {/* Synapses — dynamically rendered from state. Each line's stroke
            is its source neuron's colour so the pulse propagates the tint
            outward. One-shot animation tied to the source's period. */}
        <g fill="none" stroke-width="1.2" stroke-linecap="round">
          {firings.map((f) => {
            const from = NEURONS.find((n) => n.id === f.fromId)!;
            const to = NEURONS.find((n) => n.id === f.toId)!;
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
        {/* Neurons — pulsing nodes. Per-neuron fill + drop-shadow glow
            use its Bauhaus colour via inline style: `color` drives the
            currentColor chain (for drop-shadow) while `fill` paints the
            circle body. Both reference the same hex. */}
        <g>
          {NEURONS.map((n) => (
            <circle
              key={n.id}
              cx={n.x}
              cy={n.y}
              r="3"
              fill={n.colour}
              class={`${scope}-n ${scope}-n${n.id}`}
              style={`color: ${n.colour}`}
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
    /* Pulse ring — same keyframe as cms-core's ThinkingAnimation, a
       quiet container circle. Matches our logo structure (3 concentric
       rings + center dot) so the animation feels like the trail mark
       breathing. transform-box + fill-box make scale work on <circle>. */
    .${s}-ring {
      transform-box: fill-box;
      transform-origin: center;
      animation: ${s}-ring-pulse 2.4s ease-in-out infinite;
    }
    @keyframes ${s}-ring-pulse {
      0%, 100% { transform: scale(0.85); opacity: 0.15; }
      50%      { transform: scale(1.1);  opacity: 0.05; }
    }

    /* Neurons — each its own duration so pulses drift out of sync over
       time. 50% of cycle = peak glow = moment the JS scheduler has
       spawned an outgoing firing whose 50% also hits peak. Colour and
       drop-shadow tint come from each circle's inline color style
       which sets currentColor — the drop-shadow picks that up. */
    .${s}-n { transform-box: fill-box; transform-origin: center; animation-name: ${s}-pulse; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
    .${s}-n1 { animation-duration: 1.40s; animation-delay: 0.00s; }
    .${s}-n2 { animation-duration: 1.70s; animation-delay: 0.35s; }
    .${s}-n3 { animation-duration: 1.25s; animation-delay: 0.80s; }
    .${s}-n4 { animation-duration: 1.85s; animation-delay: 1.10s; }
    .${s}-n5 { animation-duration: 1.55s; animation-delay: 0.55s; }
    .${s}-n6 { animation-duration: 1.60s; animation-delay: 0.20s; }
    .${s}-n7 { animation-duration: 1.35s; animation-delay: 0.90s; }
    .${s}-n8  { animation-duration: 1.90s; animation-delay: 1.25s; }
    .${s}-n9  { animation-duration: 1.30s; animation-delay: 0.45s; }
    .${s}-n10 { animation-duration: 1.75s; animation-delay: 0.70s; }
    @keyframes ${s}-pulse {
      0%, 100% { transform: scale(0.75); opacity: 0.6; filter: none; }
      50% { transform: scale(1.65); opacity: 1; filter: drop-shadow(0 0 7px currentColor) drop-shadow(0 0 16px currentColor); }
    }

    /* Synapse firing — plays ONCE. Peak at 50% of the line's own
       duration, which matches the source neuron's pulse peak because the
       JS scheduler spawns the firing at cycle-start (phase) with the
       source neuron's period as its duration. */
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
    }
  `;
}
