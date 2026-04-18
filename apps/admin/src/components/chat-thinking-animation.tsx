/**
 * ChatThinkingAnimation — CMS-core's "thinking" loader, ported to trail.
 *
 * Original lives at `packages/cms-admin/src/components/chat/
 * thinking-animation.tsx` in the webhouse/cms monorepo. Design: 3 dots
 * on a circular orbit (120° apart via -0.6s stagger, 1.8s period) inside
 * a pulsing ring (2.4s ease-in-out), with a static center dot at 40%
 * opacity. No deps beyond preact.
 *
 * Kept as a standalone component (not merged into NeuronLoader) so we
 * can render both side-by-side on /play and let Christian compare the
 * two visual languages at the same size. Colour maps:
 *   cms: var(--primary)            → trail: var(--color-accent)
 *   cms: var(--muted-foreground)   → trail: var(--color-fg-muted)
 *
 * Scales from the original 28px reference by computing every inner
 * dimension as a ratio of `size`. The component renders at any scale
 * without the orbit or pulse cadence changing — only geometry scales.
 */
import { useEffect, useId, useState } from 'preact/hooks';

interface Props {
  /** Pixel size of the container (square). Original cms size is 28. */
  size?: number;
  /** Optional label shown beside the animation. */
  label?: string;
  /** Optional start timestamp (ms). When present, shows elapsed m:ss. */
  startTime?: number | null;
}

export function ChatThinkingAnimation({ size = 28, label, startTime = null }: Props) {
  // Unique class prefix so multiple instances on the same page don't
  // share keyframe names. Keyframe rules are scoped via the prefix.
  const uid = useId().replace(/:/g, '');
  const scope = `cta-${uid}`;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startTime) {
      setElapsed(0);
      return;
    }
    setElapsed(Math.floor((Date.now() - startTime) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${String(seconds).padStart(2, '0')}`;

  // All inner dimensions derived from the 28px reference. Keep ratios
  // identical to the original so the visual identity travels at any size.
  const orbitRadius = size * (9 / 28);
  const dotSize = size * (5 / 28);
  const centerSize = size * (4 / 28);
  const ringBorder = Math.max(1, size * (1.5 / 28));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div
        class={scope}
        style={{ position: 'relative', width: `${size}px`, height: `${size}px` }}
      >
        <style>{`
          @keyframes ${scope}-orbit {
            0%   { transform: rotate(0deg)   translateX(${orbitRadius}px) rotate(0deg);   opacity: 1; }
            33%  { opacity: 0.6; }
            66%  { opacity: 1; }
            100% { transform: rotate(360deg) translateX(${orbitRadius}px) rotate(-360deg); opacity: 1; }
          }
          @keyframes ${scope}-pulse-ring {
            0%, 100% { transform: scale(0.85); opacity: 0.15; }
            50%      { transform: scale(1.1);  opacity: 0.05; }
          }
          .${scope} > .${scope}-ring {
            animation: ${scope}-pulse-ring 2.4s ease-in-out infinite;
          }
          .${scope} > .${scope}-dot {
            animation: ${scope}-orbit 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .${scope} > .${scope}-ring,
            .${scope} > .${scope}-dot { animation: none; }
          }
        `}</style>

        {/* Pulse ring */}
        <div
          class={`${scope}-ring`}
          style={{
            position: 'absolute',
            inset: `-${Math.round(size * (2 / 28))}px`,
            borderRadius: '50%',
            border: `${ringBorder}px solid var(--color-accent)`,
          }}
        />

        {/* Three orbiting dots — 120° apart via -0.6s stagger */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            class={`${scope}-dot`}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: `${dotSize}px`,
              height: `${dotSize}px`,
              marginTop: `-${dotSize / 2}px`,
              marginLeft: `-${dotSize / 2}px`,
              borderRadius: '50%',
              backgroundColor: 'var(--color-accent)',
              animationDelay: `${i * -0.6}s`,
            }}
          />
        ))}

        {/* Static center dot */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: `${centerSize}px`,
            height: `${centerSize}px`,
            marginTop: `-${centerSize / 2}px`,
            marginLeft: `-${centerSize / 2}px`,
            borderRadius: '50%',
            backgroundColor: 'var(--color-accent)',
            opacity: 0.4,
          }}
        />
      </div>

      {label ? (
        <span
          style={{
            fontSize: '0.8rem',
            color: 'var(--color-fg-muted)',
            fontStyle: 'italic',
          }}
        >
          {label}
        </span>
      ) : null}
      {startTime && elapsed > 0 ? (
        <span
          style={{
            fontSize: '0.75rem',
            color: 'var(--color-fg-muted)',
            opacity: 0.6,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {timeStr}
        </span>
      ) : null}
    </div>
  );
}
