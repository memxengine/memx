import { useEffect, useState } from 'preact/hooks';
import { loadingMessages } from '../lib/loading-messages';

/**
 * Live visual for a document stuck in `status='processing'`. Rotates through
 * Christian's loading-messages catalogue every few seconds and ticks an
 * elapsed timer so the curator can feel how long the pipeline has been
 * running. Purely cosmetic — does not control the pipeline or cancel it.
 *
 * The message index is randomised per row on mount so two rows processing
 * at the same time don't show the same message lock-step. Each row starts
 * at a different offset and they drift independently.
 */
export function ProcessingIndicator({ startedAt }: { startedAt: string | null }) {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * loadingMessages.length));
  const [elapsed, setElapsed] = useState<number>(() => computeElapsed(startedAt));

  // Rotate messages every 3.2 s. Prime-ish interval so concurrent rows stay
  // out of sync without an explicit stagger.
  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % loadingMessages.length);
    }, 3200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setElapsed(computeElapsed(startedAt));
    const t = setInterval(() => setElapsed(computeElapsed(startedAt)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  return (
    <div class="mt-2 flex items-center gap-2 text-[11px] font-mono text-[color:var(--color-accent)]">
      <Dot />
      <span class="italic text-[color:var(--color-fg-muted)]">{loadingMessages[idx]}…</span>
      <span class="ml-auto text-[color:var(--color-fg-subtle)]">{formatElapsed(elapsed)}</span>
    </div>
  );
}

function Dot() {
  // Three-stage CSS keyframe pulse painted with SVG so the colour tracks
  // the accent variable cleanly across light/dark themes.
  return (
    <span
      class="inline-block w-2 h-2 rounded-full bg-[color:var(--color-accent)]"
      style={{ animation: 'pulse-dot 1.4s ease-in-out infinite' }}
    />
  );
}

function computeElapsed(iso: string | null): number {
  if (!iso) return 0;
  const started = new Date(iso.replace(' ', 'T') + (iso.includes('Z') || iso.includes('+') ? '' : 'Z')).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Date.now() - started);
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
