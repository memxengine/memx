import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { QueueCandidate, QueueCandidateStatus } from '@trail/shared';
import {
  listQueue,
  approveCandidate,
  rejectCandidate,
  ApiError,
  type QueueListResponse,
} from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { Modal, ModalButton } from '../components/modal';

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

  useEffect(reload, [reload]);

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
}

function CandidateRow({ candidate: c, kbId, isExpanded, onToggle, busy, onApprove, onReject }: RowProps) {
  const meta = parseMetadata(c.metadata);
  const preview =
    c.content.length > 200 ? c.content.slice(0, 200).replace(/\s+/g, ' ').trim() + '…' : c.content;

  return (
    <li class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)] hover:border-[color:var(--color-border-strong)] transition">
      <div class="p-4 flex items-start gap-4">
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
      <details class="mt-4 text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
        <summary class="cursor-pointer hover:text-[color:var(--color-fg-muted)]">
          Raw markdown ({c.content.length} chars)
        </summary>
        <pre class="mt-2 whitespace-pre-wrap bg-[color:var(--color-bg-card)] border border-[color:var(--color-border)] rounded p-3 overflow-x-auto">
          {c.content}
        </pre>
      </details>
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
