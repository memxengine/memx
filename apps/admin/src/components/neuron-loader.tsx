/**
 * NeuronLoader — themed loading animation for long-running LLM actions.
 *
 * Five nodes (Neurons) arranged in a tight cluster, pulsing at staggered
 * intervals. Synapse lines between them appear to "draw in" and fade,
 * suggesting new connections forming — exactly what auto-link-sources is
 * doing semantically: the LLM is proposing new references between an
 * orphan Neuron and the Sources its claims came from.
 *
 * Pure SVG + inline CSS keyframes. No deps, no runtime JS. The `<style>`
 * tag lives next to the markup so every import pulls the animation
 * ruleset with it (scoped by the `neuron-loader` class prefix to avoid
 * leaking rules into the global sheet).
 *
 * Colour follows the active accent via `currentColor` — renders correctly
 * in dark, light, and any future themes without per-theme overrides.
 * Respects `prefers-reduced-motion`: users with that preference set get
 * a static frame instead of the animation loop.
 */
import { useId } from 'preact/hooks';

interface Props {
  /** Pixel size of the loader (square). Defaults to 20px — fits inside a button row. */
  size?: number;
  /** Optional label rendered next to the animation. */
  label?: string;
}

export function NeuronLoader({ size = 20, label }: Props) {
  // One stable unique id per loader instance. When two buttons animate
  // on the same row we need distinct CSS class names so the staggered
  // timings don't collide (preact re-uses identical class names across
  // siblings otherwise).
  const uid = useId().replace(/:/g, '');
  const scope = `nl-${uid}`;

  return (
    <span class="inline-flex items-center gap-2 align-middle">
      <svg
        viewBox="0 0 64 64"
        width={size}
        height={size}
        class={`${scope} shrink-0`}
        aria-label="loading"
        role="img"
      >
        <style>{css(scope)}</style>
        {/* Synapses — thin muted lines between neurons. Dasharray animation
            makes them look like they're being drawn in fresh, then retracing. */}
        <g class={`${scope}-syn`} stroke="currentColor" stroke-width="0.8" fill="none" stroke-linecap="round">
          <line x1="32" y1="12" x2="12" y2="32" class={`${scope}-s1`} />
          <line x1="32" y1="12" x2="52" y2="32" class={`${scope}-s2`} />
          <line x1="12" y1="32" x2="22" y2="52" class={`${scope}-s3`} />
          <line x1="52" y1="32" x2="42" y2="52" class={`${scope}-s4`} />
          <line x1="22" y1="52" x2="42" y2="52" class={`${scope}-s5`} />
          <line x1="32" y1="12" x2="22" y2="52" class={`${scope}-s6`} opacity="0.35" />
          <line x1="32" y1="12" x2="42" y2="52" class={`${scope}-s7`} opacity="0.35" />
        </g>
        {/* Neurons — pulsing nodes. */}
        <g fill="currentColor">
          <circle cx="32" cy="12" r="3" class={`${scope}-n ${scope}-n1`} />
          <circle cx="12" cy="32" r="3" class={`${scope}-n ${scope}-n2`} />
          <circle cx="52" cy="32" r="3" class={`${scope}-n ${scope}-n3`} />
          <circle cx="22" cy="52" r="3" class={`${scope}-n ${scope}-n4`} />
          <circle cx="42" cy="52" r="3" class={`${scope}-n ${scope}-n5`} />
        </g>
      </svg>
      {label ? <span class="text-xs">{label}</span> : null}
    </span>
  );
}

function css(s: string): string {
  return `
    .${s}-n { transform-box: fill-box; transform-origin: center; animation: ${s}-pulse 1.4s ease-in-out infinite; }
    .${s}-n1 { animation-delay: 0s; }
    .${s}-n2 { animation-delay: 0.18s; }
    .${s}-n3 { animation-delay: 0.36s; }
    .${s}-n4 { animation-delay: 0.54s; }
    .${s}-n5 { animation-delay: 0.72s; }
    @keyframes ${s}-pulse {
      0%, 100% { transform: scale(0.75); opacity: 0.7; }
      50% { transform: scale(1.25); opacity: 1; filter: drop-shadow(0 0 3px currentColor); }
    }
    .${s}-syn line { stroke-dasharray: 50; stroke-dashoffset: 50; animation: ${s}-draw 2.4s ease-in-out infinite; }
    .${s}-s1 { animation-delay: 0s; }
    .${s}-s2 { animation-delay: 0.2s; }
    .${s}-s3 { animation-delay: 0.6s; }
    .${s}-s4 { animation-delay: 0.8s; }
    .${s}-s5 { animation-delay: 1.1s; }
    .${s}-s6 { animation-delay: 1.3s; }
    .${s}-s7 { animation-delay: 1.5s; }
    @keyframes ${s}-draw {
      0% { stroke-dashoffset: 50; opacity: 0.35; }
      40% { stroke-dashoffset: 0; opacity: 0.9; }
      70% { stroke-dashoffset: 0; opacity: 0.9; }
      100% { stroke-dashoffset: -50; opacity: 0.35; }
    }
    @media (prefers-reduced-motion: reduce) {
      .${s}-n, .${s}-syn line { animation: none; }
      .${s}-n { opacity: 0.8; }
      .${s}-syn line { stroke-dashoffset: 0; opacity: 0.5; }
    }
  `;
}
