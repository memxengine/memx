import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { Document } from '@trail/shared';
import {
  listSources,
  archiveDocument,
  restoreDocument,
  retryDocument,
  reingestDocument,
  rerunVisionForDocument,
  getDocumentContent,
  api,
  ApiError,
} from '../api';
import { displayPath } from '../lib/display-path';
import { UploadDropzone } from '../components/upload-dropzone';
import { ProcessingIndicator } from '../components/processing-indicator';
import { Modal, ModalButton } from '../components/modal';
import { useKbEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';
import { CopyId } from '../components/copy-id';
import { ConnectorBadge } from '../components/connector-badge';

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
type FilterStatus = 'active' | 'extracted' | 'success' | 'failed' | 'archived' | 'all';

const FILTER_TABS: ReadonlyArray<{ value: FilterStatus }> = [
  { value: 'active' },
  { value: 'extracted' },
  { value: 'success' },
  { value: 'failed' },
  { value: 'archived' },
  { value: 'all' },
];

// We fetch `archived=all` once and narrow client-side for every tab.
// One round-trip funds all 6 tabs' lists AND their count badges, and
// switching tabs is instant (no refetch). The tradeoff — a slightly
// bigger payload that includes archived rows — is negligible at the
// scale Trail operates (single-tenant, hundreds of sources at most).
function narrowByFilter(docs: Document[], f: FilterStatus): Document[] {
  if (f === 'all') return docs;
  if (f === 'archived') return docs.filter((d) => d.archived);
  // Non-archived scope for the 4 status-based filters.
  const pool = docs.filter((d) => !d.archived);
  return pool.filter((d) => {
    const neuronCount = (d as Document & { neuronCount?: number }).neuronCount ?? 0;
    switch (f) {
      case 'active':
        return d.status === 'processing' || d.status === 'pending';
      case 'extracted':
        return d.status === 'ready' && neuronCount === 0;
      case 'success':
        return d.status === 'ready' && neuronCount > 0;
      case 'failed':
        return d.status === 'failed';
    }
  });
}

export function SourcesPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  useLocale();
  const [filter, setFilter] = useState<FilterStatus>('active');
  // Always the full unfiltered list (archived=all). The displayed list
  // and the tab counts are both derived from it via narrowByFilter.
  const [allDocs, setAllDocs] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'retry' | 'reingest' | 'archive'>(null);
  const [bulkToast, setBulkToast] = useState<string | null>(null);
  // Custom modal for archive confirmation — no native window.confirm.
  const [archiveTarget, setArchiveTarget] = useState<Document | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  // Re-ingest confirmation modal. Re-ingest is non-destructive (output
  // replaces existing Neurons, idempotent server-side) but costs LLM
  // tokens + takes 1-2 min per source, so a user-forced re-ingest
  // should be an intentional click, not a drive-by.
  const [reingestTarget, setReingestTarget] = useState<Document | null>(null);
  const [reingestBusy, setReingestBusy] = useState(false);
  // F161 follow-up — operator-only "Run Vision" button. Hidden unless
  // engine has TRAIL_VISION_RERUN_UI=1 set (read from /me.features).
  const [visionRerunEnabled, setVisionRerunEnabled] = useState(false);
  const [visionBusyDocId, setVisionBusyDocId] = useState<string | null>(null);
  const [visionToast, setVisionToast] = useState<string | null>(null);

  useEffect(() => {
    api<{ features?: { visionRerun?: boolean } }>('/api/v1/me')
      .then((m) => setVisionRerunEnabled(!!m.features?.visionRerun))
      .catch(() => setVisionRerunEnabled(false));
  }, []);

  useEffect(() => {
    if (!visionToast) return;
    const t = setTimeout(() => setVisionToast(null), 5000);
    return () => clearTimeout(t);
  }, [visionToast]);

  const onRunVision = useCallback(async (doc: Document) => {
    if (visionBusyDocId) return;
    setVisionBusyDocId(doc.id);
    try {
      const result = await rerunVisionForDocument(doc.id);
      setVisionToast(
        `Vision: ${result.described} described, ${result.skipped} skipped of ${result.rowsScanned} (${result.model})`,
      );
    } catch (err) {
      setVisionToast(
        err instanceof ApiError ? `Vision failed: ${err.message}` : `Vision failed: ${String(err)}`,
      );
    } finally {
      setVisionBusyDocId(null);
    }
  }, [visionBusyDocId]);

  const reload = useCallback(() => {
    if (!kbId) return;
    listSources(kbId, 'all')
      .then((list) => {
        setAllDocs(list.slice().sort((a, b) => a.filename.localeCompare(b.filename)));
      })
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);

  // Derived list for the current tab + per-tab counts. Both flow from
  // `allDocs` so they stay consistent — the count in the tab badge
  // always matches the row-count the user sees after the click.
  const docs = useMemo(
    () => (allDocs ? narrowByFilter(allDocs, filter) : null),
    [allDocs, filter],
  );
  const tabCounts = useMemo(() => {
    if (!allDocs) return null;
    return {
      active: narrowByFilter(allDocs, 'active').length,
      extracted: narrowByFilter(allDocs, 'extracted').length,
      success: narrowByFilter(allDocs, 'success').length,
      failed: narrowByFilter(allDocs, 'failed').length,
      archived: narrowByFilter(allDocs, 'archived').length,
      all: allDocs.length,
    };
  }, [allDocs]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  useKbEvents(kbId, (e) => {
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

  // All optimistic updates mutate `allDocs` (the unfiltered list) and let
  // narrowByFilter re-derive both the visible rows and the tab counts.
  // No handler needs to think about which tab is active — a state flip
  // like archived→true or status→processing automatically moves the row
  // to the correct tab and updates every badge.
  const onUploaded = useCallback(
    (doc: Document) => {
      setAllDocs((prev) => (prev ? [doc, ...prev.filter((d) => d.id !== doc.id)] : [doc]));
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
      setAllDocs((prev) =>
        prev?.map((d) => (d.id === doc.id ? { ...d, archived: true } : d)) ?? prev,
      );
      setArchiveTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveTarget]);

  // Restore an archived source back to active. No confirmation modal —
  // restore is a pure undo, zero data loss, so a one-click action is the
  // right UX weight.
  const onRestore = useCallback(async (doc: Document) => {
    try {
      await restoreDocument(doc.id);
      setAllDocs((prev) =>
        prev?.map((d) => (d.id === doc.id ? { ...d, archived: false } : d)) ?? prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const onRetry = useCallback(async (doc: Document) => {
    try {
      await retryDocument(doc.id);
      setAllDocs((prev) =>
        prev?.map((d) =>
          d.id === doc.id ? { ...d, status: 'processing' as const, errorMessage: null } : d,
        ) ?? prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  // Open the re-ingest confirmation modal. Actual mutation fires from
  // confirmReingest so the curator has a chance to back out — LLM work
  // is expensive enough that a mis-click shouldn't immediately burn
  // tokens. (retry has no modal because it's usually invoked on a row
  // that's already in a failed state; re-ingest is also offered on
  // ready rows where accidental clicks are more likely.)
  const onReingest = useCallback((doc: Document) => {
    setReingestTarget(doc);
  }, []);

  const confirmReingest = useCallback(async () => {
    const doc = reingestTarget;
    if (!doc) return;
    setReingestBusy(true);
    try {
      const result = await reingestDocument(doc.id);
      if (!result.alreadyRunning) {
        setAllDocs((prev) =>
          prev?.map((d) =>
            d.id === doc.id ? { ...d, status: 'processing' as const, errorMessage: null } : d,
          ) ?? prev,
        );
      }
      setReingestTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setReingestBusy(false);
    }
  }, [reingestTarget]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Bulk-selection helpers. Select-all scopes to the currently-visible
  // doc list; changing filter tab clears the selection so we never
  // act on rows the curator can't see.
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => {
    if (!docs) return;
    setSelected(new Set(docs.map((d) => d.id)));
  }, [docs]);
  const clearSelected = useCallback(() => setSelected(new Set()), []);
  // Reset selection when the filter tab changes (active/archived/all) —
  // a curator clicking Archive with rows selected on the Active tab
  // shouldn't accidentally act on archived rows they can't see.
  useEffect(() => {
    setSelected(new Set());
  }, [filter]);

  // Bulk actions just loop through existing single-doc endpoints. Not
  // the most efficient (one HTTP request per doc) but keeps server-
  // side logic untouched and guarantees identical semantics to the
  // per-row buttons. Promise.all for parallelism; await all before
  // refreshing the list.
  const runBulk = useCallback(
    async (kind: 'retry' | 'reingest' | 'archive'): Promise<void> => {
      if (selected.size === 0 || !docs) return;
      setBulkBusy(kind);
      const ids = Array.from(selected);
      const fn =
        kind === 'retry'
          ? retryDocument
          : kind === 'reingest'
          ? reingestDocument
          : archiveDocument;
      const results = await Promise.allSettled(ids.map((id) => fn(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      setBulkToast(
        failed === 0
          ? t('sources.bulkDoneToast', { kind: t(`sources.bulk.${kind}` as never), ok })
          : t('sources.bulkPartialToast', {
              kind: t(`sources.bulk.${kind}` as never),
              ok,
              failed,
            }),
      );
      setSelected(new Set());
      setBulkBusy(null);
      reload();
      setTimeout(() => setBulkToast(null), 4000);
    },
    [docs, reload, selected],
  );

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
        {FILTER_TABS.map((tab) => {
          const count = tabCounts?.[tab.value];
          return (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              class={
                'inline-flex items-baseline gap-1.5 px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
                (filter === tab.value
                  ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                  : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
              }
            >
              {t(`sources.filter.${tab.value}`)}
              {count !== undefined ? (
                <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
                  ({count})
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm mb-4">
          {error}
        </div>
      ) : null}

      {!docs && !error ? <CenteredLoader /> : null}

      {docs && docs.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          {t(`sources.empty.${filter}` as never)}
        </div>
      ) : null}

      {docs && docs.length > 0 ? (
        <div class="flex items-center justify-between gap-4 mb-3 text-xs font-mono text-[color:var(--color-fg-muted)]">
          <label class="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              class="cursor-pointer accent-[color:var(--color-accent)]"
              checked={selected.size > 0 && selected.size === docs.length}
              // indeterminate = partial selection — the DOM attr has to
              // be set imperatively on the element; ref-callback does it.
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && selected.size < docs.length;
              }}
              onChange={() => (selected.size === docs.length ? clearSelected() : selectAll())}
            />
            <span>
              {selected.size > 0
                ? t('common.selected', { n: selected.size })
                : t('common.selectAll', { n: docs.length })}
            </span>
          </label>
          {selected.size > 0 ? (
            <div class="flex items-center gap-3">
              <button
                type="button"
                onClick={() => runBulk('retry')}
                disabled={bulkBusy !== null}
                class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] disabled:opacity-50 transition"
                title={t('sources.retryHint')}
              >
                {bulkBusy === 'retry' ? '…' : t('sources.bulkRetry', { n: selected.size })}
              </button>
              <button
                type="button"
                onClick={() => runBulk('reingest')}
                disabled={bulkBusy !== null}
                class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] disabled:opacity-50 transition"
                title={t('sources.reingestHint')}
              >
                {bulkBusy === 'reingest' ? '…' : t('sources.bulkReingest', { n: selected.size })}
              </button>
              <button
                type="button"
                onClick={() => runBulk('archive')}
                disabled={bulkBusy !== null}
                class="text-[11px] font-mono text-[color:var(--color-danger)] hover:opacity-80 disabled:opacity-50 transition"
              >
                {bulkBusy === 'archive' ? '…' : t('sources.bulkArchive', { n: selected.size })}
              </button>
              <button
                type="button"
                onClick={clearSelected}
                disabled={bulkBusy !== null}
                class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
              >
                {t('common.clear')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {bulkToast ? (
        <div class="mb-3 px-3 py-2 rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success)]/5 text-[color:var(--color-success)] text-xs font-mono">
          {bulkToast}
        </div>
      ) : null}

      {visionToast ? (
        <div class="mb-3 px-3 py-2 rounded-md border border-[color:var(--color-accent)]/30 bg-[color:var(--color-accent)]/5 text-[color:var(--color-accent)] text-xs font-mono">
          {visionToast}
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
            onReingest={onReingest}
            onRunVision={visionRerunEnabled ? onRunVision : undefined}
            visionBusyDocId={visionBusyDocId}
            isSelected={selected.has(doc.id)}
            onToggleSelected={toggleSelected}
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

      <Modal
        open={reingestTarget !== null}
        title={t('sources.reingestTitle')}
        onClose={() => setReingestTarget(null)}
        footer={
          <>
            <ModalButton onClick={() => setReingestTarget(null)} disabled={reingestBusy}>
              {t('common.cancel')}
            </ModalButton>
            <ModalButton onClick={confirmReingest} disabled={reingestBusy}>
              {reingestBusy ? '…' : t('sources.reingest')}
            </ModalButton>
          </>
        }
      >
        {reingestTarget ? (
          <div class="space-y-3">
            <div>
              <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
                {t('sources.title').toLowerCase()}
              </div>
              <div class="text-sm font-medium break-all">{reingestTarget.filename}</div>
            </div>
            <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
              {t('sources.reingestBody')}
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
  onReingest: (d: Document) => void;
  /** F161 — only set when TRAIL_VISION_RERUN_UI=1 on engine. */
  onRunVision?: (d: Document) => void;
  visionBusyDocId?: string | null;
  isSelected: boolean;
  onToggleSelected: (id: string) => void;
}

function SourceRow({
  doc,
  isExpanded,
  onToggle,
  onArchive,
  onRestore,
  onRetry,
  onReingest,
  onRunVision,
  visionBusyDocId,
  isSelected,
  onToggleSelected,
}: RowProps) {
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
        <div class="min-w-0 flex items-baseline gap-3">
          <input
            type="checkbox"
            class="mt-[3px] shrink-0 cursor-pointer accent-[color:var(--color-accent)]"
            checked={isSelected}
            onChange={() => onToggleSelected(doc.id)}
            aria-label={t('common.selectRow', { name: doc.filename })}
          />
          <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-0.5">
            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]">
              {doc.fileType || 'doc'}
            </span>
            {(() => {
              const connector = getConnector(doc.metadata);
              return connector && connector !== 'upload'
                ? <ConnectorBadge variant="tag" connector={connector} />
                : null;
            })()}
            <StatusBadge
              status={doc.status}
              neuronCount={
                (doc as Document & { neuronCount?: number }).neuronCount ?? null
              }
            />
            {doc.pageCount ? (
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">
                {doc.pageCount} page{doc.pageCount === 1 ? '' : 's'}
              </span>
            ) : null}
            <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">
              {formatBytes(doc.fileSize)}
            </span>
            {/* Neuron count — number of Neurons that cite this Source.
                Zero is worth showing explicitly (not suppressed to
                null) because "0 Neurons" on a ready Source is the
                thing that tells the curator this row needs re-ingest,
                even if the badge already hints at it. Tone amber for
                zero so it's visually tied to the EXTRACTED badge. */}
            {doc.status === 'ready' ? (
              (() => {
                const n =
                  (doc as Document & { neuronCount?: number }).neuronCount ?? 0;
                const key = n === 0 ? 'sources.neuronCountZero' : n === 1 ? 'sources.neuronCountOne' : 'sources.neuronCount';
                const cls =
                  n === 0
                    ? 'text-[10px] font-mono text-[color:var(--color-warning,#f59e0b)]'
                    : 'text-[10px] font-mono text-[color:var(--color-fg-subtle)]';
                return <span class={cls}>{t(key, { n })}</span>;
              })()
            ) : null}
          </div>
          <div class="font-medium">{doc.title ?? doc.filename}</div>
          <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] truncate">
            {displayPath(doc.path)}{doc.filename}
          </div>
          {doc.status === 'failed' && doc.errorMessage ? (
            <div class="mt-2 space-y-2">
              <div class="text-[11px] font-mono text-[color:var(--color-danger)] whitespace-pre-wrap break-words">
                {doc.errorMessage}
              </div>
              <CopyId id={doc.id} label="Copy ID" />
            </div>
          ) : null}
          {doc.status === 'processing' || doc.status === 'pending' ? (
            <ProcessingIndicator startedAt={doc.updatedAt} />
          ) : null}
          </div>
        </div>
        {/* Row actions. Logic by state:
            - Archived rows → Restore only (one-click undo, no modal).
            - Failed rows → Retry (when binary) + Reingest + Archive.
            - Ready rows → Reingest + Archive.
            - Processing/pending → no actions (no races during ingest).
            Reingest skips the file-format extract step and re-runs only
            the LLM wiki-compile — cheap alternative to full reprocess
            when extract already produced good markdown. */}
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
            {(doc.fileType === 'pdf' ||
              doc.fileType === 'docx' ||
              doc.fileType === 'md' ||
              doc.fileType === 'txt' ||
              doc.fileType === 'html') ? (
              <button
                onClick={() => onReingest(doc)}
                class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] transition"
                title={t('sources.reingestHint')}
              >
                {t('sources.reingest').toLowerCase()}
              </button>
            ) : null}
            {onRunVision && doc.kind === 'source' && doc.status === 'ready' ? (
              <button
                onClick={() => onRunVision(doc)}
                disabled={visionBusyDocId === doc.id}
                class="text-[11px] font-mono text-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] disabled:opacity-50 transition"
                title={t('sources.runVisionHint')}
              >
                {visionBusyDocId === doc.id ? '…' : t('sources.runVision').toLowerCase()}
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

function StatusBadge({
  status,
  neuronCount,
}: {
  status: Document['status'];
  neuronCount?: number | null;
}) {
  // Differentiate "extract done but compile yielded nothing" from
  // "extract done AND at least one Neuron cites this Source". Both
  // are technically `status='ready'`, but SUCCESS reads as "the
  // pipeline did its job" — misleading when 0 Neurons were written.
  // EXTRACTED (neutral amber) signals "file is here, LLM compile
  // produced nothing — re-ingest to retry".
  const extractedButEmpty = status === 'ready' && (neuronCount ?? 0) === 0;
  const tone =
    status === 'failed'
      ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
      : status === 'processing'
      ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]'
      : extractedButEmpty
      ? 'bg-[color:var(--color-warning,#f59e0b)]/15 text-[color:var(--color-warning,#f59e0b)]'
      : status === 'ready'
      ? 'bg-[color:var(--color-success)]/15 text-[color:var(--color-success)]'
      : 'bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]';
  const label = extractedButEmpty
    ? 'extracted'
    : status === 'ready'
    ? 'success'
    : status;
  const title = extractedButEmpty
    ? 'Extracted successfully, but the LLM compile produced no Neurons. Click re-ingest to try again.'
    : undefined;
  return (
    <span
      class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${tone}`}
      title={title}
    >
      {label}
    </span>
  );
}

function getConnector(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as { connector?: unknown };
    return typeof m.connector === 'string' ? m.connector : null;
  } catch { return null; }
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
