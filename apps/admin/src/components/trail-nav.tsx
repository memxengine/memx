import { useLocation } from 'preact-iso';
import { useKb } from '../lib/kb-cache';

/**
 * Per-Trail header row — Trail name as breadcrumb + the Neurons/Queue/Sources
 * tabs. Mounted inside the global <App /> header, shown only when the path
 * contains `/kb/<id>/...`. Order matches how curators actually work: read
 * (Neurons) → approve (Queue) → trace back to raw inputs (Sources).
 */
export function TrailNav({ kbId }: { kbId: string }) {
  const { path } = useLocation();
  const kb = useKb(kbId);
  const tabs = [
    { href: `/kb/${kbId}/neurons`, label: 'Neurons', match: '/neurons' },
    { href: `/kb/${kbId}/queue`, label: 'Queue', match: '/queue' },
    { href: `/kb/${kbId}/sources`, label: 'Sources', match: '/sources' },
  ];
  return (
    <nav class="flex items-center gap-1 -mt-px border-t border-[color:var(--color-border)] pt-2 pb-0">
      <div class="flex items-baseline gap-2 mr-4 text-sm">
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
      {tabs.map((tab) => {
        const isActive = path.includes(tab.match);
        return (
          <a
            key={tab.href}
            href={tab.href}
            class={
              'px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
              (isActive
                ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
            }
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
