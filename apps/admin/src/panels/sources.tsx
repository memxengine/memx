import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { Document } from '@trail/shared';
import {
  listSources,
  archiveDocument,
  restoreDocument,
  retryDocument,
  getDocumentContent,
  ApiError,
} from '../api';
import { displayPath } from '../lib/display-path';
import { UploadDropzone } from '../components/upload-dropzone';
import { ProcessingIndicator } from '../components/processing-indicator';
import { Modal, ModalButton } from '../components/modal';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { t, useLocale } from '../lib/i18n';

/**
 * Sources panel — the original documents uploaded into a Trail. Sources
 * render the same way Queue candidates do: a compact row with metadata,
 * a `▼ Show full content` toggle that inline-expands the compiled
 * markdown below. Same visual grammar across the admin — one way to read
 * a compiled document regardless of where it lives in the curation flow.
 *
 * Supports drag-and-drop upload for .md / .pdf / .docx (and everything
 * else in the engine's whitelist). Uploaded docs trigger the ingest
 * pipeline; when it finishes, Neurons appear in the queue for approval.
 */
type FilterStatus = 'active' | 'archived' | 'all';

const FILTER_TABS: ReadonlyArray<{ value: FilterStatus }> = [
  { value: 'active' },
  { value: 'archived' },
  { value: 'all' },
];

export function SourcesPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  useLocale();
  const [filter, setFilter] = useState<FilterStatus>('active');
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Custom modal for archive confirmation — no native window.confirm.
  const [archiveTarget, setArchiveTarget] = useState<Document | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  const reload = useCallback(() => {
    if (!kbId) return;
    listSources(kbId, filter)
      .then((list) => setDocs(list.slice().sort((a, b) => a.filename.localeCompare(b.filename))))
      .catch((err: ApiError) => setError(err.message));
  }, [kbId, filter]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

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
  useEffect(() => onFocusRefresh(reload), [reload]);

  const onUploaded = useCallback(
    (doc: Document) => {
      setDocs((prev) => (prev ? [doc, ...prev.filter((d) => d.id !== doc.id)] : [doc]));
      reload();
    },
    [reload],
  );

  // Open the archive-confirmation modal. The actual mutation fires from
  // the modal's confirm handler so the curator has a chance to back out.
  const onArchive = useCallback((doc: Document) => {
    setArchiveTarget(doc);
  }, []);

  const confirmArchive = useCallback(async () => {
    const doc = archiveTarget;
    if (!doc) return;
    setArchiveBusy(true);
    try {
      await archiveDocument(doc.id);
      // Optimistic remove only when the Archived / All filters wouldn't
      // have kept the row on screen — otherwise reload so it re-appears
      // correctly styled in the Archived view.
      if (filter === 'active') {
        setDocs((prev) => (prev ? prev.filter((d) => d.id !== doc.id) : prev));
      } else {
        reload();
      }
      setArchiveTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveTarget, filter, reload]);

  // Restore an archived source back to active. No confirmation modal —
  // restore is a pure undo, zero data loss, so a one-click action is the
  // right UX weight.
  const onRestore = useCallback(
    async (doc: Document) => {
      try {
        await restoreDocument(doc.id);
        if (filter === 'archived') {
          setDocs((prev) => (prev ? prev.filter((d) => d.id !== doc.id) : prev));
        } else {
          reload();
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [filter, reload],
  );

  const onRetry = useCallback(async (doc: Document) => {
    try {
      await retryDocument(doc.id);
      setDocs((prev) =>
        prev
          ? prev.map((d) =>
              d.id === doc.id ? { ...d, status: 'processing', errorMessage: null } : d,
            )
          : prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('sources.title')}</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {docs ? (
            t(docs.length === 1 ? 'sources.summary' : 'sources.summaryPlural', { n: docs.length })
          ) : (
            <span class="loading-delayed inline-block">{t('common.loading')}</span>
          )}
        </p>
      </header>

      <section class="mb-8">
        <UploadDropzone kbId={kbId} onUploaded={onUploaded} />
      </section>

      {/* Filter strip — same grammar as Queue's status tabs. Active is
          default; Archived shows soft-deleted sources with a Restore
          button on each row so an accidental archive is one-click reversible. */}
      <nav class="flex gap-1 mb-5 border-b border-[color:var(--color-border)]">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            class={
              'px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
              (filter === tab.value
                ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
            }
          >
            {t(`sources.filter.${tab.value}`)}
          </button>
        ))}
      </nav>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm mb-4">
          {error}
        </div>
      ) : null}

      {docs && docs.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          {filter === 'archived' ? t('sources.emptyArchived') : t('sources.empty')}
        </div>
      ) : null}

      <ul class="space-y-2">
        {docs?.map((doc) => (
          <SourceRow
            key={doc.id}
            doc={doc}
            isExpanded={expanded.has(doc.id)}
            onToggle={() => toggleExpanded(doc.id)}
            onArchive={onArchive}
            onRestore={onRestore}
            onRetry={onRetry}
          />
        ))}
      </ul>

      <Modal
        open={archiveTarget !== null}
        title={t('sources.archiveTitle')}
        onClose={() => setArchiveTarget(null)}
        footer={
          <>
            <ModalButton onClick={() => setArchiveTarget(null)} disabled={archiveBusy}>
              {t('common.cancel')}
            </ModalButton>
            <ModalButton variant="danger" onClick={confirmArchive} disabled={archiveBusy}>
              {archiveBusy ? '…' : t('sources.archive')}
            </ModalButton>
          </>
        }
      >
        {archiveTarget ? (
          <div class="space-y-3">
            <div>
              <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
                {t('sources.title').toLowerCase()}
              </div>
              <div class="text-sm font-medium break-all">{archiveTarget.filename}</div>
            </div>
            <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
              {t('sources.archiveBody')}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

interface RowProps {
  doc: Document;
  isExpanded: boolean;
  onToggle: () => void;
  onArchive: (d: Document) => void;
  onRestore: (d: Document) => void;
  onRetry: (d: Document) => void;
}

function SourceRow({ doc, isExpanded, onToggle, onArchive, onRestore, onRetry }: RowProps) {
  const canExpand = doc.status === 'ready' || doc.status === 'failed' || doc.archived;
  const isArchived = doc.archived;
  return (
    <li
      class={
        'border rounded-md transition ' +
        (isArchived
          ? 'border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/40 opacity-70'
          : doc.status === 'failed'
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
          <div class="font-medium">{doc.title ?? doc.filename}</div>
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
        {/* Row actions. Logic by state:
            - Archived rows → Restore only (one-click undo, no modal).
            - Failed rows → Retry (when binary) + Archive.
            - Ready rows → Archive.
            - Processing/pending → no actions (no races during ingest). */}
        {isArchived ? (
          <div class="flex items-center gap-3 shrink-0">
            <button
              onClick={() => onRestore(doc)}
              class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] transition"
              title={t('sources.restoreHint')}
            >
              {t('sources.restore')}
            </button>
          </div>
        ) : doc.status === 'failed' || doc.status === 'ready' ? (
          <div class="flex items-center gap-3 shrink-0">
            {doc.status === 'failed' && (doc.fileType === 'pdf' || doc.fileType === 'docx') ? (
              <button
                onClick={() => onRetry(doc)}
                class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] transition"
                title={t('sources.retryHint')}
              >
                {t('sources.retry').toLowerCase()}
              </button>
            ) : null}
            <button
              onClick={() => onArchive(doc)}
              class="text-[11px] font-mono text-[color:var(--color-danger)] hover:text-[color:var(--color-fg)] transition"
              title={t('sources.archiveHint')}
            >
              {t('sources.archive').toLowerCase()}
            </button>
          </div>
        ) : null}
      </div>

      {canExpand ? (
        <button
          onClick={onToggle}
          class="w-full text-left px-4 pb-3 text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition"
        >
          {isExpanded ? `▲ ${t('sources.hideContent')}` : `▼ ${t('sources.showContent')}`}
        </button>
      ) : null}

      {isExpanded ? <ExpandedSource doc={doc} /> : null}
    </li>
  );
}

function ExpandedSource({ doc }: { doc: Document }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDocumentContent(doc.id)
      .then((r) => {
        if (!cancelled) setContent(r.content ?? '');
      })
      .catch((err: ApiError) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  const html =
    content === null || content.trim() === ''
      ? ''
      : (marked.parse(content, { async: false }) as string);

  return (
    <div class="border-t border-[color:var(--color-border)] px-4 py-4 bg-[color:var(--color-bg)]">
      {error ? (
        <div class="text-[11px] font-mono text-[color:var(--color-danger)]">{error}</div>
      ) : content === null ? (
        <div class="loading-delayed text-[color:var(--color-fg-muted)] text-sm">
          Loading content…
        </div>
      ) : content.trim() === '' ? (
        <div class="text-[color:var(--color-fg-subtle)] text-sm italic">
          No compiled content yet. If this Source just uploaded, the pipeline is still running.
          If it has been a while, retry or check the error on the row.
        </div>
      ) : (
        <div
          class="prose-body text-sm leading-relaxed"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
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
