import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';

export function App({ children }: { children: ComponentChildren }) {
  const { path } = useLocation();
  return (
    <div class="min-h-screen flex flex-col">
      <header class="border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]">
        <div class="max-w-7xl mx-auto px-6 py-4 flex items-center gap-6">
          <a href="/" class="flex items-center gap-2.5 no-underline">
            <span class="font-mono font-semibold text-lg text-[color:var(--color-fg)]" style="letter-spacing: -0.02em;">
              trail
            </span>
            <span class="text-[color:var(--color-fg-muted)] text-sm">model lab</span>
          </a>
          <nav class="flex items-center gap-4 text-sm ml-8">
            <a href="/" class={`no-underline transition ${path === '/' ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'}`}>
              Runs
            </a>
            <a href="/compare" class={`no-underline transition ${path === '/compare' ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'}`}>
              Compare
            </a>
            <a href="/runs/new" class="no-underline text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] transition">
              + New Run
            </a>
          </nav>
        </div>
      </header>
      <main class="flex-1 max-w-7xl mx-auto px-6 py-6 w-full">
        {children}
      </main>
    </div>
  );
}
