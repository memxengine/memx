import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { CandidateAction, QueueCandidate, QueueCandidateStatus } from '@trail/shared';
import {
  listQueue,
  resolveCandidate,
  bulkQueue,
  ApiError,
  type QueueListResponse,
} from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { Modal, ModalButton } from '../components/modal';
import { DynamicActionButtons } from '../components/dynamic-actions';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { t, useLocale } from '../lib/i18n';

type FilterStatus = QueueCandidateStatus | 'all';

// Status tabs. Labels resolve via t() at render time so they switch
// language without remounting — keeping the value list as a const here
// + a translateStatus(value) helper at the call sites.
const STATUS_TABS: Array<{ value: FilterStatus }> = [
  { value: 'pending' },
  { value: 'approved' },
  { value: 'rejected' },
  { value: 'all' },
];

function statusLabel(v: FilterStatus): string {
  return t(`queue.tabs.${v}`);
}

/**
 * Parsed shape of `candidate.metadata` JSON — mirrors @trail/core CandidateOp.
 * Used read-only here so curators can see what the approval will commit.
 */
interface CandidateOpMeta {
  op?: 'create' | 'update' | 'archive';
  targetDocumentId?: string;
  filename?: string;
  path?: string;
  tags?: string | null;
}

function parseMetadata(raw: string | null): CandidateOpMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CandidateOpMeta;
  } catch {
    return null;
  }
}

export function QueuePanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  // Re-render on locale change so tab labels + button text follow the
  // active language.
  useLocale();
  const [status, setStatus] = useState<FilterStatus>('pending');
  const [data, setData] = useState<QueueListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<QueueCandidate | null>(null);
  // The actionId behind the open reject modal — defaults to 'reject' for
  // legacy candidates, but a contradiction-alert's reject-effect action
  // might be called 'dismiss', so the confirm handler uses this to send
  // the right id up to /resolve.
  const [rejectTargetActionId, setRejectTargetActionId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkReject, setBulkReject] = useState<{ ids: string[]; reason: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    listQueue({
      knowledgeBaseId: kbId,
      status: status === 'all' ? undefined : status,
      limit: 100,
    })
      .then(setData)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId, status]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(reload, [reload]);

  // Event-driven refresh. Any candidate_* event for this KB triggers a
  // re-fetch of the current filter. Debounced so a bulk action that emits
  // 22 rejects in a burst coalesces into a single refetch once the burst
  // ends — otherwise out-of-order HTTP responses can leave stale state.
  useEvents((e) => {
    if (e.kbId !== kbId) return;
    if (
      e.type === 'candidate_created' ||
      e.type === 'candidate_approved' ||
      e.type === 'candidate_resolved'
    ) {
      reloadDebounced();
    }
  });
  useEffect(() => onStreamOpen(reload), [reload]);
  useEffect(() => onFocusRefresh(reload), [reload]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set((data?.items ?? []).map((c) => c.id)));
  }, [data]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Any filter change wipes the selection — otherwise we'd silently carry
  // IDs that aren't on screen into the next bulk action.
  useEffect(() => {
    setSelected(new Set());
  }, [status]);

  async function onBulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await bulkQueue({ actionId: 'approve', ids });
      setToast({
        kind: r.failed.length === 0 ? 'success' : 'error',
        text:
          t('queue.bulk.approvedToast', { ok: r.succeeded.length, total: r.requested }) +
          (r.failed.length ? t('queue.bulk.failureSuffix', { n: r.failed.length }) : ''),
      });
      clearSelection();
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBulkBusy(false);
    }
  }

  function openBulkReject() {
    setBulkReject({ ids: Array.from(selected), reason: '' });
  }

  async function confirmBulkReject() {
    if (!bulkReject) return;
    const { ids, reason } = bulkReject;
    setBulkBusy(true);
    setBulkReject(null);
    try {
      const r = await bulkQueue({ actionId: 'reject', ids, reason: reason.trim() || undefined });
      setToast({
        kind: r.failed.length === 0 ? 'success' : 'error',
        text:
          t('queue.bulk.rejectedToast', { ok: r.succeeded.length, total: r.requested }) +
          (r.failed.length ? t('queue.bulk.failureSuffix', { n: r.failed.length }) : ''),
      });
      clearSelection();
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setBulkBusy(false);
    }
  }

  /**
   * Central resolution dispatcher — every action button (approve, reject,
   * retire-neuron, flag-source, acknowledge, etc.) routes through here so
   * the HTTP call + toast + reload is consistent. Reject actions open a
   * modal so the curator can type a reason first; everything else is a
   * one-click commit.
   */
  async function onResolve(c: QueueCandidate, action: CandidateAction) {
    if (action.effect === 'reject') {
      // Open the modal, pre-populated with the pending action id so the
      // confirm handler knows which action-id to POST (not always 'reject').
      setRejectTarget(c);
      setRejectTargetActionId(action.id);
      setRejectReason('');
      return;
    }

    setActingOn(c.id);
    try {
      const result = await resolveCandidate(c.id, {
        actionId: action.id,
        args: action.args,
      });
      setToast({
        kind: 'success',
        text:
          result.documentId && result.effect === 'approve'
            ? t('queue.item.approveSuccess', { docId: result.documentId.slice(0, 12) })
            : t('queue.item.approveSuccessNoDoc'),
      });
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setActingOn(null);
    }
  }

  async function confirmReject() {
    const c = rejectTarget;
    if (!c) return;
    const reason = rejectReason.trim();
    const actionId = rejectTargetActionId ?? 'reject';
    setActingOn(c.id);
    setRejectTarget(null);
    setRejectTargetActionId(null);
    try {
      await resolveCandidate(c.id, { actionId, reason: reason || undefined });
      setToast({ kind: 'success', text: t('queue.item.rejectSuccess') });
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setActingOn(null);
    }
  }

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('queue.title')}</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {data ? (
            t(data.count === 1 ? 'queue.summary' : 'queue.summaryPlural', {
              n: data.count,
              status: statusLabel(status).toLowerCase(),
            })
          ) : (
            <span class="loading-delayed inline-block">{t('common.loading')}</span>
          )}
        </p>
      </header>

      <nav class="flex gap-1 mb-5 border-b border-[color:var(--color-border)]">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatus(tab.value)}
            class={
              'px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
              (status === tab.value
                ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
            }
          >
            {statusLabel(tab.value)}
          </button>
        ))}
      </nav>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {error}
        </div>
      ) : null}

      {data && data.items.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          {status === 'all' ? t('queue.emptyAll') : t('queue.empty', { status: statusLabel(status).toLowerCase() })}
        </div>
      ) : null}

      {data && data.items.length > 0 ? (
        <div class="flex items-center justify-between gap-3 mb-3 text-[11px] font-mono">
          <div class="flex items-center gap-3">
            <label class="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                class="accent-[color:var(--color-accent)]"
                checked={selected.size > 0 && selected.size === data.items.length}
                onChange={(e) => {
                  if ((e.currentTarget as HTMLInputElement).checked) selectAll();
                  else clearSelection();
                }}
              />
              <span class="text-[color:var(--color-fg-muted)]">
                {selected.size === 0
                  ? t('common.selectAll', { n: data.items.length })
                  : t('common.selected', { n: selected.size })}
              </span>
            </label>
            {selected.size > 0 ? (
              <button
                onClick={clearSelection}
                class="text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
              >
                {t('common.cancel').toLowerCase()}
              </button>
            ) : null}
          </div>
          {selected.size > 0 ? (
            <div class="flex items-center gap-2">
              {status === 'pending' ? (
                <button
                  disabled={bulkBusy}
                  onClick={onBulkApprove}
                  class="px-3 py-1.5 text-[11px] rounded-md bg-[color:var(--color-fg)] text-[color:var(--color-bg)] font-medium hover:bg-[color:var(--color-fg)]/90 disabled:opacity-50 transition"
                >
                  {t('common.approve')} {selected.size}
                </button>
              ) : null}
              {status === 'pending' ? (
                <button
                  disabled={bulkBusy}
                  onClick={openBulkReject}
                  class="px-3 py-1.5 text-[11px] rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] disabled:opacity-50 transition"
                >
                  {t('common.reject')} {selected.size}…
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <ul class="space-y-2">
        {data?.items.map((c) => (
          <CandidateRow
            key={c.id}
            candidate={c}
            kbId={kbId}
            isExpanded={expanded.has(c.id)}
            onToggle={() => toggleExpanded(c.id)}
            busy={actingOn === c.id}
            onResolve={onResolve}
            selected={selected.has(c.id)}
            onToggleSelected={() => toggleSelected(c.id)}
            showCheckbox={status === 'pending'}
          />
        ))}
      </ul>

      {toast ? (
        <div
          class={
            'fixed bottom-6 right-6 px-4 py-3 rounded-md border text-sm shadow-lg ' +
            (toast.kind === 'success'
              ? 'border-[color:var(--color-success)]/30 bg-[color:var(--color-success)]/10 text-[color:var(--color-fg)]'
              : 'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10 text-[color:var(--color-fg)]')
          }
        >
          {toast.text}
        </div>
      ) : null}

      <Modal
        open={rejectTarget !== null}
        title={t('queue.item.rejectTitle')}
        onClose={() => {
          setRejectTarget(null);
          setRejectTargetActionId(null);
        }}
        footer={
          <>
            <ModalButton
              onClick={() => {
                setRejectTarget(null);
                setRejectTargetActionId(null);
              }}
            >
              {t('common.cancel')}
            </ModalButton>
            <ModalButton variant="danger" onClick={confirmReject}>
              {t('common.reject')}
            </ModalButton>
          </>
        }
      >
        {rejectTarget ? (
          <div class="space-y-3">
            <div>
              <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
                {rejectTarget.kind}
              </div>
              <div class="text-sm font-medium truncate">{rejectTarget.title}</div>
              {rejectTarget.confidence !== null ? (
                <div class="text-[10px] font-mono text-[color:var(--color-fg-subtle)] mt-1.5">
                  conf {rejectTarget.confidence.toFixed(2)}
                </div>
              ) : null}
            </div>
            <div>
              <label
                for="reject-reason"
                class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]"
              >
                {t('common.reason')} <span class="normal-case">({t('common.optional')})</span>
              </label>
              <textarea
                id="reject-reason"
                rows={3}
                placeholder={t('queue.item.rejectPrompt')}
                value={rejectReason}
                onInput={(e) => setRejectReason((e.currentTarget as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    confirmReject();
                  }
                }}
                class="mt-1 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 px-3 py-2 text-sm focus:outline-none focus:border-[color:var(--color-accent)] transition resize-none"
              />
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={bulkReject !== null}
        title={t('queue.bulk.rejectTitle', { n: bulkReject?.ids.length ?? 0 })}
        onClose={() => setBulkReject(null)}
        maxWidth="md"
        footer={
          <>
            <ModalButton onClick={() => setBulkReject(null)} disabled={bulkBusy}>
              {t('common.cancel')}
            </ModalButton>
            <ModalButton variant="danger" onClick={confirmBulkReject} disabled={bulkBusy}>
              {bulkBusy ? '…' : t('queue.bulk.confirmReject', { n: bulkReject?.ids.length ?? 0 })}
            </ModalButton>
          </>
        }
      >
        {bulkReject ? (
          <div class="space-y-3">
            <div>
              <label
                for="bulk-reject-reason"
                class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]"
              >
                {t('queue.bulk.rejectPrompt')}
              </label>
              <textarea
                id="bulk-reject-reason"
                rows={3}
                value={bulkReject.reason}
                onInput={(e) =>
                  setBulkReject((prev) =>
                    prev ? { ...prev, reason: (e.currentTarget as HTMLTextAreaElement).value } : prev,
                  )
                }
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    confirmBulkReject();
                  }
                }}
                class="mt-1 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 px-3 py-2 text-sm focus:outline-none focus:border-[color:var(--color-accent)] transition resize-none"
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

interface RowProps {
  candidate: QueueCandidate;
  kbId: string;
  isExpanded: boolean;
  onToggle: () => void;
  busy: boolean;
  onResolve: (c: QueueCandidate, action: CandidateAction) => void;
  selected: boolean;
  onToggleSelected: () => void;
  showCheckbox: boolean;
}

function CandidateRow({
  candidate: c,
  kbId,
  isExpanded,
  onToggle,
  busy,
  onResolve,
  selected,
  onToggleSelected,
  showCheckbox,
}: RowProps) {
  const meta = parseMetadata(c.metadata);
  const preview =
    c.content.length > 200 ? c.content.slice(0, 200).replace(/\s+/g, ' ').trim() + '…' : c.content;

  return (
    <li
      class={
        'border rounded-md bg-[color:var(--color-bg-card)] transition ' +
        (selected
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5'
          : 'border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)]')
      }
    >
      <div class="p-4 flex items-start gap-4">
        {showCheckbox ? (
          <label class="pt-1 cursor-pointer select-none" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              class="accent-[color:var(--color-accent)]"
              checked={selected}
              onChange={onToggleSelected}
              aria-label={`Select "${c.title}"`}
            />
          </label>
        ) : null}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]">
              {t(`queue.kinds.${c.kind}`)}
            </span>
            <StatusBadge status={c.status} auto={!!c.autoApprovedAt} />
            {meta?.op ? (
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
                {t('queue.op.label')}: {t(`queue.op.${meta.op}`)}
              </span>
            ) : null}
            {c.confidence !== null ? (
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">
                {t('queue.conf', { n: c.confidence.toFixed(2) })}
              </span>
            ) : null}
          </div>
          <div class="font-medium">{c.title}</div>
          {!isExpanded ? (
            <p class="text-sm text-[color:var(--color-fg-muted)] mt-1 line-clamp-3">{preview}</p>
          ) : null}
          <div class="mt-2 text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
            {formatTs(c.createdAt)}
            {' · '}
            {c.createdBy ? t('queue.byAuthor', { who: c.createdBy }) : t('queue.byPipeline')}
          </div>
        </div>
        {c.status === 'pending' ? (
          <DynamicActionButtons
            candidate={c}
            busy={busy}
            onResolve={(action) => onResolve(c, action)}
          />
        ) : null}
      </div>

      <button
        onClick={onToggle}
        class="w-full text-left px-4 pb-3 text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition"
      >
        {isExpanded ? `▲ ${t('queue.item.hideContent')}` : `▼ ${t('queue.item.showContent')}`}
      </button>

      {isExpanded ? <ExpandedContent candidate={c} meta={meta} kbId={kbId} /> : null}
    </li>
  );
}

function ExpandedContent({
  candidate: c,
  meta,
  kbId,
}: {
  candidate: QueueCandidate;
  meta: CandidateOpMeta | null;
  kbId: string;
}) {
  // Render markdown content. Trust the candidate content — it comes from
  // either an authenticated user (chat-answer) or our own pipelines
  // (ingest-*, reader-feedback will need sanitisation once F31 lands).
  // Rewrite `[[wiki-link]]` before marked.parse so cross-Neuron references
  // become real anchors here too, not just in the reader.
  const html = marked.parse(rewriteWikiLinks(c.content, kbId), { async: false }) as string;

  return (
    <div class="border-t border-[color:var(--color-border)] px-4 py-4 bg-[color:var(--color-bg)]">
      {meta ? (
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px] font-mono mb-4 text-[color:var(--color-fg-muted)]">
          {meta.op ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">{t('queue.meta.op')}</dt>
              <dd>{t(`queue.op.${meta.op}`)}</dd>
            </>
          ) : null}
          {meta.filename ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">{t('queue.meta.filename')}</dt>
              <dd>{meta.filename}</dd>
            </>
          ) : null}
          {meta.path ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">{t('queue.meta.path')}</dt>
              <dd>{displayPath(meta.path)}</dd>
            </>
          ) : null}
          {meta.targetDocumentId ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">{t('queue.meta.targetDoc')}</dt>
              <dd class="text-[color:var(--color-accent)]">{meta.targetDocumentId}</dd>
            </>
          ) : null}
          {meta.tags ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">{t('queue.meta.tags')}</dt>
              <dd>{meta.tags}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div
        class="prose-body text-sm leading-relaxed"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function StatusBadge({ status, auto }: { status: QueueCandidateStatus; auto: boolean }) {
  const label = t(
    status === 'approved' && auto ? 'queue.status.autoApproved' : `queue.status.${status}`,
  );
  const tone =
    status === 'approved'
      ? 'bg-[color:var(--color-success)]/10 text-[color:var(--color-success)]'
      : status === 'rejected'
      ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
      : 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]';
  return (
    <span
      class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}

function formatTs(iso: string): string {
  try {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString();
  } catch {
    return iso;
  }
}
