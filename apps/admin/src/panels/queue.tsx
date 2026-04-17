import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { QueueCandidate, QueueCandidateStatus } from '@trail/shared';
import {
  listQueue,
  approveCandidate,
  rejectCandidate,
  bulkQueue,
  ApiError,
  type QueueListResponse,
} from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { Modal, ModalButton } from '../components/modal';
import { useEvents, onStreamOpen, debounce } from '../lib/event-stream';

type FilterStatus = QueueCandidateStatus | 'all';

const STATUS_TABS: Array<{ value: FilterStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

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
  const [status, setStatus] = useState<FilterStatus>('pending');
  const [data, setData] = useState<QueueListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [rejectTarget, setRejectTarget] = useState<QueueCandidate | null>(null);
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
      e.type === 'candidate_rejected'
    ) {
      reloadDebounced();
    }
  });
  useEffect(() => onStreamOpen(reload), [reload]);

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
      const r = await bulkQueue({ action: 'approve', ids });
      setToast({
        kind: r.failed.length === 0 ? 'success' : 'error',
        text: `Approved ${r.succeeded.length}/${r.requested}${r.failed.length ? ` — ${r.failed.length} failed` : ''}`,
      });
      clearSelection();
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Bulk approve failed' });
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
      const r = await bulkQueue({ action: 'reject', ids, reason: reason.trim() || undefined });
      setToast({
        kind: r.failed.length === 0 ? 'success' : 'error',
        text: `Rejected ${r.succeeded.length}/${r.requested}${r.failed.length ? ` — ${r.failed.length} failed` : ''}`,
      });
      clearSelection();
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Bulk reject failed' });
    } finally {
      setBulkBusy(false);
    }
  }

  async function onApprove(c: QueueCandidate) {
    setActingOn(c.id);
    try {
      const result = await approveCandidate(c.id);
      setToast({
        kind: 'success',
        text: `Approved — wiki page ${result.documentId.slice(0, 12)}… created.`,
      });
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Approval failed' });
    } finally {
      setActingOn(null);
    }
  }

  function openRejectDialog(c: QueueCandidate) {
    setRejectTarget(c);
    setRejectReason('');
  }

  async function confirmReject() {
    const c = rejectTarget;
    if (!c) return;
    const reason = rejectReason.trim();
    setActingOn(c.id);
    setRejectTarget(null);
    try {
      await rejectCandidate(c.id, reason ? { reason } : {});
      setToast({ kind: 'success', text: 'Rejected.' });
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Reject failed' });
    } finally {
      setActingOn(null);
    }
  }

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Curator queue</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {data ? (
            `${data.count} ${STATUS_TABS.find((t) => t.value === status)?.label.toLowerCase()} candidate${data.count === 1 ? '' : 's'}`
          ) : (
            <span class="loading-delayed inline-block">Loading…</span>
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
            {tab.label}
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
          No {status === 'all' ? '' : status} candidates.
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
                  ? `Select all (${data.items.length})`
                  : `${selected.size} selected`}
              </span>
            </label>
            {selected.size > 0 ? (
              <button
                onClick={clearSelection}
                class="text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
              >
                clear
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
                  Approve {selected.size}
                </button>
              ) : null}
              {status === 'pending' ? (
                <button
                  disabled={bulkBusy}
                  onClick={openBulkReject}
                  class="px-3 py-1.5 text-[11px] rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] disabled:opacity-50 transition"
                >
                  Reject {selected.size}…
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
            onApprove={onApprove}
            onReject={openRejectDialog}
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
        title="Reject candidate"
        onClose={() => setRejectTarget(null)}
        footer={
          <>
            <ModalButton onClick={() => setRejectTarget(null)}>Cancel</ModalButton>
            <ModalButton variant="danger" onClick={confirmReject}>
              Reject
            </ModalButton>
          </>
        }
      >
        {rejectTarget ? (
          <div class="space-y-3">
            <div>
              <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
                Candidate
              </div>
              <div class="text-sm font-medium truncate">{rejectTarget.title}</div>
              <div class="flex items-center gap-2 mt-1.5 text-[10px] font-mono uppercase tracking-wider">
                <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]">
                  {rejectTarget.kind}
                </span>
                {rejectTarget.confidence !== null ? (
                  <span class="text-[color:var(--color-fg-subtle)]">
                    conf {rejectTarget.confidence.toFixed(2)}
                  </span>
                ) : (
                  <span class="text-[color:var(--color-fg-subtle)]">no confidence</span>
                )}
              </div>
            </div>
            <div>
              <label
                for="reject-reason"
                class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]"
              >
                Reason <span class="normal-case">(optional)</span>
              </label>
              <textarea
                id="reject-reason"
                rows={3}
                placeholder="Why is this not fit for the Trail? Stored on the candidate — curators can see it later."
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
              <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] mt-1">
                ⌘+Enter to reject · Esc to cancel
              </div>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={bulkReject !== null}
        title={`Reject ${bulkReject?.ids.length ?? 0} candidates`}
        onClose={() => setBulkReject(null)}
        maxWidth="md"
        footer={
          <>
            <ModalButton onClick={() => setBulkReject(null)} disabled={bulkBusy}>
              Cancel
            </ModalButton>
            <ModalButton variant="danger" onClick={confirmBulkReject} disabled={bulkBusy}>
              {bulkBusy ? '…' : `Reject ${bulkReject?.ids.length ?? 0}`}
            </ModalButton>
          </>
        }
      >
        {bulkReject ? (
          <div class="space-y-3">
            <div class="text-sm text-[color:var(--color-fg-muted)]">
              About to reject <strong class="text-[color:var(--color-fg)]">{bulkReject.ids.length}</strong>{' '}
              candidates. Reason is stored on every one so you can trace why they were dropped
              later.
            </div>
            <div>
              <label
                for="bulk-reject-reason"
                class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]"
              >
                Reason <span class="normal-case">(optional, applied to all)</span>
              </label>
              <textarea
                id="bulk-reject-reason"
                rows={3}
                placeholder="e.g. Resolved by F15 reference extraction — underlying condition no longer present."
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
              <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] mt-1">
                ⌘+Enter to reject all · Esc to cancel
              </div>
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
  onApprove: (c: QueueCandidate) => void;
  onReject: (c: QueueCandidate) => void;
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
  onApprove,
  onReject,
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
              {c.kind}
            </span>
            <StatusBadge status={c.status} auto={!!c.autoApprovedAt} />
            {meta?.op ? (
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
                op: {meta.op}
              </span>
            ) : null}
            {c.confidence !== null ? (
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)]">
                conf {c.confidence.toFixed(2)}
              </span>
            ) : null}
          </div>
          <div class="font-medium">{c.title}</div>
          {!isExpanded ? (
            <p class="text-sm text-[color:var(--color-fg-muted)] mt-1 line-clamp-3">{preview}</p>
          ) : null}
          <div class="mt-2 text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
            {formatTs(c.createdAt)}
            {c.createdBy ? ` · by ${c.createdBy}` : ' · by pipeline'}
          </div>
        </div>
        {c.status === 'pending' ? (
          <div class="flex flex-col gap-2 shrink-0">
            <button
              disabled={busy}
              onClick={() => onApprove(c)}
              class="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-fg)] text-[color:var(--color-bg)] font-medium hover:bg-[color:var(--color-fg)]/90 disabled:opacity-50 transition"
            >
              {busy ? '…' : 'Approve'}
            </button>
            <button
              disabled={busy}
              onClick={() => onReject(c)}
              class="px-3 py-1.5 text-sm rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] disabled:opacity-50 transition"
            >
              Reject
            </button>
          </div>
        ) : null}
      </div>

      <button
        onClick={onToggle}
        class="w-full text-left px-4 pb-3 text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition"
      >
        {isExpanded ? '▲ Hide content' : '▼ Show full content'}
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
              <dt class="text-[color:var(--color-fg-subtle)]">op</dt>
              <dd>{meta.op}</dd>
            </>
          ) : null}
          {meta.filename ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">filename</dt>
              <dd>{meta.filename}</dd>
            </>
          ) : null}
          {meta.path ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">path</dt>
              <dd>{displayPath(meta.path)}</dd>
            </>
          ) : null}
          {meta.targetDocumentId ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">target doc</dt>
              <dd class="text-[color:var(--color-accent)]">{meta.targetDocumentId}</dd>
            </>
          ) : null}
          {meta.tags ? (
            <>
              <dt class="text-[color:var(--color-fg-subtle)]">tags</dt>
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
  const label = status === 'approved' && auto ? 'auto-approved' : status;
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
