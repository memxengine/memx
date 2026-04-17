import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { Document } from '@trail/shared';
import { listSources, archiveDocument, retryDocument, ApiError } from '../api';
import { displayPath } from '../lib/display-path';
import { UploadDropzone } from '../components/upload-dropzone';
import { ProcessingIndicator } from '../components/processing-indicator';
import { useEvents, onStreamOpen, debounce } from '../lib/event-stream';

/**
 * Sources panel — the original documents uploaded into a Trail. Supports
 * drag-and-drop upload for .md / .pdf / .docx (and everything else in the
 * engine's whitelist). Uploaded docs trigger the ingest pipeline; when it
 * finishes, Neurons appear in the queue for approval.
 */
export function SourcesPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!kbId) return;
    listSources(kbId)
      .then((list) => setDocs(list.slice().sort((a, b) => a.filename.localeCompare(b.filename))))
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Replace the old 3s poller with event-driven updates. Any ingest lifecycle
  // event on this KB means a source row's status changed — refetch. Debounced
  // so a batch upload that fires N ingest events in a burst coalesces into
  // one refetch.
  useEvents((e) => {
    if (e.kbId !== kbId) return;
    if (
      e.type === 'ingest_started' ||
      e.type === 'ingest_completed' ||
      e.type === 'ingest_failed'
    ) {
      reloadDebounced();
    }
  });
  useEffect(() => onStreamOpen(reload), [reload]);

  const onUploaded = useCallback(
    (doc: Document) => {
      // Prepend optimistically + reload in the background to catch any
      // server-side transforms (status, generated title, page count).
      setDocs((prev) => (prev ? [doc, ...prev.filter((d) => d.id !== doc.id)] : [doc]));
      reload();
    },
    [reload],
  );

  const onArchive = useCallback(
    async (doc: Document) => {
      const ok = window.confirm(`Archive "${doc.filename}"? This soft-deletes the source — its rows stay in the DB, just hidden from the list.`);
      if (!ok) return;
      try {
        await archiveDocument(doc.id);
        setDocs((prev) => (prev ? prev.filter((d) => d.id !== doc.id) : prev));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [],
  );

  const onRetry = useCallback(
    async (doc: Document) => {
      try {
        await retryDocument(doc.id);
        // Optimistic status flip — the engine already persisted 'processing'
        // synchronously and will emit ingest events from there. Reload picks
        // up the authoritative state.
        setDocs((prev) =>
          prev
            ? prev.map((d) => (d.id === doc.id ? { ...d, status: 'processing', errorMessage: null } : d))
            : prev,
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [],
  );

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Sources</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {docs ? `${docs.length} source document${docs.length === 1 ? '' : 's'}` : (
            <span class="loading-delayed inline-block">Loading…</span>
          )}
        </p>
      </header>

      <section class="mb-8">
        <UploadDropzone kbId={kbId} onUploaded={onUploaded} />
      </section>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm mb-4">
          {error}
        </div>
      ) : null}

      {docs && docs.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          No Sources yet. Drop a file above — PDFs, Word docs, or markdown will compile into Neurons automatically.
        </div>
      ) : null}

      <ul class="space-y-2">
        {docs?.map((doc) => (
          <li
            key={doc.id}
            class={
              'border rounded-md transition ' +
              (doc.status === 'failed'
                ? 'border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/5'
                : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)]')
            }
          >
            <div class="px-4 py-3 flex items-baseline justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-0.5">
                  <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]">
                    {doc.fileType || 'doc'}
                  </span>
                  <StatusBadge status={doc.status} />
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
                {doc.status === 'failed' && doc.errorMessage ? (
                  <div class="mt-2 text-[11px] font-mono text-[color:var(--color-danger)] whitespace-pre-wrap break-words">
                    {doc.errorMessage}
                  </div>
                ) : null}
                {doc.status === 'processing' || doc.status === 'pending' ? (
                  <ProcessingIndicator startedAt={doc.updatedAt} />
                ) : null}
              </div>
              <div class="flex items-center gap-3 shrink-0">
                {doc.status === 'failed' ? (
                  <>
                    {doc.fileType === 'pdf' || doc.fileType === 'docx' ? (
                      <button
                        onClick={() => onRetry(doc)}
                        class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] transition"
                        title="Re-run the ingest pipeline against the uploaded bytes"
                      >
                        retry
                      </button>
                    ) : null}
                    <button
                      onClick={() => onArchive(doc)}
                      class="text-[11px] font-mono text-[color:var(--color-danger)] hover:text-[color:var(--color-fg)] transition"
                      title="Archive this source — soft-deletes, audit trail intact"
                    >
                      archive
                    </button>
                  </>
                ) : null}
              <a
                href={`/api/v1/documents/${encodeURIComponent(doc.id)}/content`}
                target="_blank"
                rel="noopener noreferrer"
                class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-accent)] transition"
                title="Open raw content in a new tab"
              >
                open →
              </a>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: Document['status'] }) {
  if (status === 'ready') return null;
  const tone =
    status === 'failed'
      ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
      : status === 'processing'
      ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]'
      : 'bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]';
  return (
    <span
      class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${tone}`}
    >
      {status}
    </span>
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
