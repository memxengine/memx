export function NotFound() {
  return (
    <div class="max-w-3xl mx-auto py-16 px-6 text-center">
      <h1 class="text-4xl font-semibold tracking-tight mb-2">404</h1>
      <p class="text-[color:var(--color-fg-muted)]">Page not found.</p>
      <a
        href="/"
        class="inline-block mt-6 px-4 py-2 rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-card)] transition text-sm"
      >
        ← Back to Trails
      </a>
    </div>
  );
}
