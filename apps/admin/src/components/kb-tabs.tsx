import { useLocation } from 'preact-iso';
import { useKb } from '../lib/kb-cache';

/**
 * Per-Trail header: name of the current Trail + the secondary tab bar
 * (Queue | Neurons | Sources). Shown at the top of every per-KB panel so
 * the curator always knows which Trail they're curating.
 */
export function KbTabs({ kbId }: { kbId: string | undefined }) {
  const { path } = useLocation();
  const kb = useKb(kbId ?? '');
  if (!kbId) return null;
  const tabs = [
    { href: `/kb/${kbId}/queue`, label: 'Queue', match: '/queue' },
    { href: `/kb/${kbId}/neurons`, label: 'Neurons', match: '/neurons' },
    { href: `/kb/${kbId}/sources`, label: 'Sources', match: '/sources' },
  ];
  return (
    <div class="mb-6">
      <div class="flex items-baseline gap-3 mb-3">
        <span class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
          Trail
        </span>
        <span class="text-sm font-medium text-[color:var(--color-fg)]">
          {kb ? kb.name : <span class="loading-delayed inline-block">…</span>}
        </span>
        {kb ? (
          <code class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">{kb.slug}</code>
        ) : null}
      </div>
      <nav class="flex gap-1 border-b border-[color:var(--color-border)]">
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
    </div>
  );
}
