import { useLocation } from 'preact-iso';

/**
 * Secondary navigation shown at the top of every per-KB panel (queue,
 * wiki, sources). Kept stateless — active tab is derived from the
 * current route, not a prop. Consumers just pass the kbId.
 */
export function KbTabs({ kbId }: { kbId: string | undefined }) {
  const { path } = useLocation();
  if (!kbId) return null;
  const tabs = [
    { href: `/kb/${kbId}/queue`, label: 'Queue', match: '/queue' },
    { href: `/kb/${kbId}/neurons`, label: 'Neurons', match: '/neurons' },
  ];
  return (
    <nav class="flex gap-1 mb-5 border-b border-[color:var(--color-border)]">
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
