import { useEffect, useState } from 'preact/hooks';

/**
 * Thinking animation — ported from @webhouse/cms packages/cms-admin/src/
 * components/chat/thinking-animation.tsx. Three orbiting dots inside a
 * pulsing ring, plus an optional label and elapsed-time readout that
 * ticks once a second.
 *
 * Colors swapped to trail's tokens: the cms uses --primary (shadcn) and
 * --muted-foreground; trail equivalents are --color-accent (amber) and
 * --color-fg-muted. Works cleanly in both light and dark themes.
 */
export function ThinkingAnimation({
  label,
  startTime,
}: {
  label?: string;
  startTime?: number | null;
}) {
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

  return (
    // paddingInline: the 28x28 animation box contains a pulse ring with
    // `inset: -2px` (32x32 base) that scales to 1.1 → 35.2x35.2 at peak.
    // That overflows the 28x28 container by 3.6px on each side, which
    // gets clipped when the parent (chat column, modal body, etc.) has
    // overflow:hidden. 6px of inline padding gives the ring room to
    // breathe without changing its visual size.
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingInline: '6px' }}>
      <div style={{ position: 'relative', width: '28px', height: '28px', flexShrink: 0 }}>
        <style>{`
          @keyframes chat-orbit {
            0%   { transform: rotate(0deg)   translateX(9px) rotate(0deg);   opacity: 1; }
            33%  { opacity: 0.6; }
            66%  { opacity: 1; }
            100% { transform: rotate(360deg) translateX(9px) rotate(-360deg); opacity: 1; }
          }
          @keyframes chat-pulse-ring {
            0%, 100% { transform: scale(0.85); opacity: 0.15; }
            50%      { transform: scale(1.1);  opacity: 0.05; }
          }
        `}</style>
        {/* Pulse ring */}
        <div
          style={{
            position: 'absolute',
            inset: '-2px',
            borderRadius: '50%',
            border: '1.5px solid var(--color-accent)',
            animation: 'chat-pulse-ring 2.4s ease-in-out infinite',
          }}
        />
        {/* Orbiting dots */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: '5px',
              height: '5px',
              marginTop: '-2.5px',
              marginLeft: '-2.5px',
              borderRadius: '50%',
              backgroundColor: 'var(--color-accent)',
              animation: 'chat-orbit 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite',
              animationDelay: `${i * -0.6}s`,
            }}
          />
        ))}
        {/* Center dot */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: '4px',
            height: '4px',
            marginTop: '-2px',
            marginLeft: '-2px',
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
