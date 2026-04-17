import { useLocation } from 'preact-iso';
import { useKb } from '../lib/kb-cache';
import { usePendingCount } from '../lib/event-stream';

/**
 * Per-Trail header row — Trail name as breadcrumb + the Neurons/Queue/Sources
 * tabs. Mounted inside the global <App /> header, shown only when the path
 * contains `/kb/<id>/...`. Order matches how curators actually work: read
 * (Neurons) → approve (Queue) → trace back to raw inputs (Sources).
 *
 * The Queue tab carries a live pending-count badge driven by the F87 event
 * stream (see lib/event-stream.ts). Updates in real time as buddy, lint,
 * and ingest pipelines emit new candidates.
 */
export function TrailNav({ kbId }: { kbId: string }) {
  const { path } = useLocation();
  const kb = useKb(kbId);
  const pending = usePendingCount(kbId);

  const tabs = [
    { href: `/kb/${kbId}/neurons`, label: 'Neurons', match: '/neurons' },
    { href: `/kb/${kbId}/chat`, label: 'Chat', match: '/chat' },
    { href: `/kb/${kbId}/search`, label: 'Search', match: '/search' },
    { href: `/kb/${kbId}/queue`, label: 'Queue', match: '/queue', badge: pending },
    { href: `/kb/${kbId}/sources`, label: 'Sources', match: '/sources' },
  ] as const;

  return (
    <div class="mb-2">
      <div class="flex items-baseline gap-3 mb-3 text-sm">
        <a
          href="/"
          class="text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] transition"
        >
          Trails
        </a>
        <span class="text-[color:var(--color-fg-subtle)]">/</span>
        <span class="font-medium text-[color:var(--color-fg)]">
          {kb ? kb.name : <span class="loading-delayed inline-block">…</span>}
        </span>
      </div>
      <nav class="flex gap-1 border-b border-[color:var(--color-border)]">
        {tabs.map((tab) => {
          const isActive = path.includes(tab.match);
          const showBadge = 'badge' in tab && typeof tab.badge === 'number' && tab.badge > 0;
          return (
            <a
              key={tab.href}
              href={tab.href}
              class={
                'relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
                (isActive
                  ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                  : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
              }
            >
              {tab.label}
              {showBadge ? (
                <span
                  class="inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] px-1 rounded-full text-[10px] font-mono font-semibold bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
                  aria-label={`${tab.badge} pending`}
                >
                  {(tab as { badge: number }).badge}
                </span>
              ) : null}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
