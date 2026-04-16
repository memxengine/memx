import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { api } from './api';

interface Me {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantPlan: string;
}

export function App({ children }: { children: ComponentChildren }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const location = useLocation();

  useEffect(() => {
    api<Me>('/api/v1/me')
      .then((data) => {
        setMe(data);
        setLoading(false);
      })
      .catch(() => {
        // Not authed — redirect to engine's OAuth start
        window.location.href = `/api/auth/google?redirect=${encodeURIComponent(window.location.href)}`;
      });
  }, []);

  if (loading) return <div class="p-8 text-[color:var(--color-fg-muted)]">Loading…</div>;

  return (
    <div class="min-h-screen flex flex-col">
      <header class="border-b border-[color:var(--color-border)] px-6 py-3 flex items-center gap-4 bg-[color:var(--color-bg-card)]">
        <a href="/" class="flex items-center gap-2 font-mono text-lg font-semibold tracking-tight">
          <span class="inline-block w-6 h-6 rounded-full border-2 border-[color:var(--color-accent)] relative">
            <span class="absolute inset-[3px] rounded-full bg-[color:var(--color-accent)]"></span>
          </span>
          trail
        </a>
        <span class="text-[color:var(--color-fg-subtle)] text-sm">admin</span>
        <div class="ml-auto flex items-center gap-3 text-sm">
          {me ? (
            <>
              <span class="text-[color:var(--color-fg-muted)]">{me.tenantName}</span>
              <span class="text-[color:var(--color-fg-subtle)]">·</span>
              <span>{me.displayName}</span>
            </>
          ) : null}
        </div>
      </header>
      <main class="flex-1">{children}</main>
    </div>
  );
}
