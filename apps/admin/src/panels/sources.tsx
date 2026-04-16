import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { Document } from '@trail/shared';
import { listSources, ApiError } from '../api';
import { KbTabs } from '../components/kb-tabs';
import { displayPath } from '../lib/display-path';

/**
 * Sources panel — lists the original documents (PDFs, plain text, markdown)
 * that were uploaded into a Trail. Sources are read-only here; they're the
 * raw evidence the compiled Neurons cite back to. Uploading and deleting
 * live on other screens (and the API) for now.
 */
export function SourcesPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!kbId) return;
    listSources(kbId)
      .then((list) => setDocs(list.slice().sort((a, b) => a.filename.localeCompare(b.filename))))
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);

  return (
    <div class="page-shell">
      <header class="mb-6">
        <a
          href="/"
          class="text-sm text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
        >
          ← All Trails
        </a>
        <h1 class="text-2xl font-semibold tracking-tight mt-2 mb-1">Sources</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {docs ? `${docs.length} source document${docs.length === 1 ? '' : 's'}` : (
            <span class="loading-delayed inline-block">Loading…</span>
          )}
        </p>
      </header>

      <KbTabs kbId={kbId} />

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {error}
        </div>
      ) : null}

      {docs && docs.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          No Sources yet. Upload PDFs, markdown, or plain text via the engine API to seed this Trail.
        </div>
      ) : null}

      <ul class="space-y-2">
        {docs?.map((doc) => (
          <li
            key={doc.id}
            class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)] transition"
          >
            <div class="px-4 py-3 flex items-baseline justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-0.5">
                  <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]">
                    {doc.fileType || 'doc'}
                  </span>
                  {doc.pageCount ? (
                    <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">
                      {doc.pageCount} page{doc.pageCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                  <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">
                    {formatBytes(doc.fileSize)}
                  </span>
                </div>
                <div class="font-medium truncate">{doc.title ?? doc.filename}</div>
                <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] truncate">
                  {displayPath(doc.path)}{doc.filename}
                </div>
              </div>
              <a
                href={`/api/v1/documents/${encodeURIComponent(doc.id)}/content`}
                class="shrink-0 text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-accent)] transition"
                title="Open raw content"
              >
                open →
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
