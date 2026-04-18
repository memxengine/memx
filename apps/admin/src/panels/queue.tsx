import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { CandidateAction, QueueCandidate, QueueCandidateStatus } from '@trail/shared';
import {
  listQueue,
  listWikiPages,
  resolveCandidate,
  reopenCandidate,
  bulkQueue,
  bulkAcceptRecommendations,
  ApiError,
  type QueueListResponse,
} from '../api';
import type { Document } from '@trail/shared';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { Modal, ModalButton } from '../components/modal';
import { DynamicActionButtons } from '../components/dynamic-actions';
import { CopyId } from '../components/copy-id';
import { CenteredLoader } from '../components/centered-loader';
import { NeuronLoader } from '../components/neuron-loader';
import { ConnectorBadge } from '../components/connector-badge';
import { ConfidencePill } from '../components/confidence-pill';
import {
  CONNECTORS,
  LIVE_CONNECTORS,
  ROADMAP_CONNECTORS,
  type ConnectorId,
} from '@trail/shared';
import { useEvents, onStreamOpen, onFocusRefresh, debounce } from '../lib/event-stream';
import { t, useLocale, bilingual } from '../lib/i18n';
import { useCandidateBundle } from '../lib/translate-candidate';

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
  /** F95 — which ingestion connector produced this candidate. */
  connector?: string;
  /** F96 — LLM-generated action recommendation. Arrives async a few
   *  seconds after candidate creation (via candidate_created re-emit). */
  recommendation?: {
    recommendedActionId: string;
    confidence: number;
    reasoning: string;
    generatedAt: string;
  };
  // Lint-finding shapes carry the affected Neuron id under different keys
  // depending on the detector. The deep-link resolver falls back through
  // these so orphan/stale/contradiction candidates all get an Open-editor
  // link — not just update/archive candidates.
  documentId?: string;
  newDocumentId?: string;
  existingDocumentId?: string;
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
  // Set of connector ids currently included in the filter. Empty set =
  // "show all". Multi-select (OR logic on server side).
  const [selectedConnectors, setSelectedConnectors] = useState<Set<ConnectorId>>(new Set());
  // Chip row is collapsed by default — 14 chips take vertical real
  // estate most curators don't need on every page load. Click the
  // "Kilde:" label to toggle. Auto-open when any filter is active so
  // the curator can see what they've selected.
  const [connectorFilterOpen, setConnectorFilterOpen] = useState(false);
  const [data, setData] = useState<QueueListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-candidate in-flight tracking. Multiple rows can be resolving
  // in parallel (curator clicking Accept rapidly on several rows), so
  // every bit of "row is busy" state lives in a Map keyed by
  // candidate id. Single-slot state would race: clicking B while A's
  // promise is mid-flight would clobber A's overlay + button
  // animation. Map entries are cleared independently as each resolve
  // settles.
  interface ActingEntry {
    actionId: string;
    viaRecommendation: boolean;
  }
  const [acting, setActing] = useState<Map<string, ActingEntry>>(new Map());
  // Candidate ids whose recommendation-Accept click failed in this
  // session. When a row's id is here, its action column auto-expands
  // the alternatives so the curator isn't stuck with a dead badge
  // and no visible next step. Session-local on purpose — once the
  // curator resolves the row via any action, it leaves the queue
  // and the id no longer matters.
  const [failedRecommendations, setFailedRecommendations] = useState<Set<string>>(new Set());
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
  // F91 — docId → filename-slug map so action cards can deep-link to the
  // editor via the existing /kb/:kbId/neurons/:slug?edit=1 route. Fetched
  // once per KB; the page list is already tiny and refreshed on focus.
  const [slugByDocId, setSlugByDocId] = useState<Map<string, string>>(new Map());

  const reload = useCallback(() => {
    setError(null);
    const connectorCsv = selectedConnectors.size > 0
      ? Array.from(selectedConnectors).join(',')
      : undefined;
    listQueue({
      knowledgeBaseId: kbId,
      status: status === 'all' ? undefined : status,
      connector: connectorCsv,
      limit: 100,
    })
      .then(setData)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId, status, selectedConnectors]);
  const reloadDebounced = useCallback(debounce(reload, 100), [reload]);

  useEffect(reload, [reload]);

  useEffect(() => {
    if (!kbId) return;
    listWikiPages(kbId)
      .then((pages) => {
        const map = new Map<string, string>();
        for (const p of pages as Array<Document & { filename: string }>) {
          map.set(p.id, p.filename.replace(/\.md$/i, ''));
        }
        setSlugByDocId(map);
      })
      .catch(() => {
        // Non-fatal — action cards without a resolvable slug just skip
        // the "Open editor" link. The queue itself still works.
      });
  }, [kbId]);

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

  const toggleConnector = useCallback((id: ConnectorId) => {
    setSelectedConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(new Set()); // filter change wipes bulk-selection
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

  // Any candidate in the selection carrying rich (non-null) actions
  // makes bulk-approve ambiguous: there's no universal "accept this"
  // effect across contradiction/orphan/stale — each kind expects a
  // specific per-case choice. We DO support bulk-reject via effect
  // matching because every kind has a reject-effect action ('dismiss'
  // on rich, 'reject' on legacy).
  const selectedItems = (data?.items ?? []).filter((c) => selected.has(c.id));
  const anySelectedHasRichActions = selectedItems.some((c) => c.actions !== null);
  // Hide the plain "Approve N" bulk button entirely when every
  // selected row has rich actions — the button is meaningless for
  // them (they don't expose an 'approve' action id), and showing it
  // disabled is visual clutter next to the recommendation-accept
  // button that DOES do useful work for the same selection.
  const allSelectedHaveRichActions =
    selectedItems.length > 0 && selectedItems.every((c) => c.actions !== null);
  // F96 — how many selected candidates have a ready recommendation.
  // Used to enable/disable the "Accept recommendation" bulk button
  // and to show the count on its label.
  const selectedWithRecommendation = selectedItems.filter((c) => {
    const meta = parseMetadata(c.metadata);
    return !!meta?.recommendation?.recommendedActionId;
  });

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

  /**
   * F96 — accept-recommendation bulk. Each selected candidate's LLM-
   * recommended action is executed; candidates without a recommendation
   * (still being computed) or with a reject-recommendation are skipped
   * and surfaced in the failure-summary so the curator knows to handle
   * them manually.
   */
  async function onBulkAcceptRecommendations() {
    const ids = selectedWithRecommendation.map((c) => c.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await bulkAcceptRecommendations(ids);
      setToast({
        kind: r.failed.length === 0 ? 'success' : 'error',
        text:
          t('queue.bulk.acceptedRecommendationsToast', { ok: r.succeeded.length, total: r.requested }) +
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
      // Dispatch by effect, not actionId: every candidate kind has at
      // least one reject-effect action ('dismiss' on rich, 'reject' on
      // legacy), so this works across mixed selections.
      const r = await bulkQueue({ effect: 'reject', ids, reason: reason.trim() || undefined });
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
  async function onResolve(
    c: QueueCandidate,
    action: CandidateAction,
    opts: { prefilledReason?: string; viaRecommendation?: boolean } = {},
  ) {
    // Reject/dismiss normally opens a modal so the curator can type a
    // reason. But when called via "Accept recommendation" the LLM's
    // reasoning is already visible in the badge — skip the modal and
    // fire directly with that reasoning as the reject reason.
    if (action.effect === 'reject' && !opts.prefilledReason) {
      setRejectTarget(c);
      setRejectTargetActionId(action.id);
      setRejectReason('');
      return;
    }

    setActing((prev) => {
      const next = new Map(prev);
      next.set(c.id, { actionId: action.id, viaRecommendation: !!opts.viaRecommendation });
      return next;
    });
    try {
      const result = await resolveCandidate(c.id, {
        actionId: action.id,
        args: action.args,
        ...(opts.prefilledReason ? { reason: opts.prefilledReason } : {}),
      });
      const sources = (result as { inferredSources?: unknown }).inferredSources;
      if (action.id === 'auto-link-sources' && Array.isArray(sources) && sources.length > 0) {
        setToast({
          kind: 'success',
          text: t('queue.item.autoLinkSuccess', {
            sources: (sources as string[]).join(', '),
          }),
        });
      } else {
        setToast({
          kind: 'success',
          text:
            result.documentId && result.effect === 'approve'
              ? t('queue.item.approveSuccess', { docId: result.documentId.slice(0, 12) })
              : t('queue.item.approveSuccessNoDoc'),
        });
      }
      reload();
    } catch (err) {
      // The LLM inferer returns 422 when it can't find any plausible
      // Source for an orphan Neuron. Surface a localised, actionable
      // message so the curator knows to link manually instead of
      // retrying the same button — also auto-expand the options row
      // below the failed badge so the next-best choices are visible.
      if (
        err instanceof ApiError &&
        err.status === 422 &&
        action.id === 'auto-link-sources'
      ) {
        setFailedRecommendations((prev) => {
          const next = new Set(prev);
          next.add(c.id);
          return next;
        });
        setToast({ kind: 'error', text: t('queue.item.autoLinkNoSources') });
      } else {
        setToast({
          kind: 'error',
          text: err instanceof Error ? err.message : t('common.error'),
        });
      }
    } finally {
      setActing((prev) => {
        if (!prev.has(c.id)) return prev;
        const next = new Map(prev);
        next.delete(c.id);
        return next;
      });
    }
  }

  async function confirmReject() {
    const c = rejectTarget;
    if (!c) return;
    const reason = rejectReason.trim();
    const actionId = rejectTargetActionId ?? 'reject';
    setActing((prev) => {
      const next = new Map(prev);
      next.set(c.id, { actionId, viaRecommendation: false });
      return next;
    });
    setRejectTarget(null);
    setRejectTargetActionId(null);
    try {
      await resolveCandidate(c.id, { actionId, reason: reason || undefined });
      setToast({ kind: 'success', text: t('queue.item.rejectSuccess') });
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setActing((prev) => {
        if (!prev.has(c.id)) return prev;
        const next = new Map(prev);
        next.delete(c.id);
        return next;
      });
    }
  }

  /**
   * Revision: pull a rejected candidate back into Pending so the curator
   * can reconsider. Fires candidate_created (as pending) via the engine
   * so the badge + other panels update live.
   */
  async function onReopen(c: QueueCandidate) {
    setActing((prev) => {
      const next = new Map(prev);
      next.set(c.id, { actionId: 'reopen', viaRecommendation: false });
      return next;
    });
    try {
      await reopenCandidate(c.id);
      setToast({ kind: 'success', text: t('queue.item.reopenSuccess') });
      reload();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : t('common.error') });
    } finally {
      setActing((prev) => {
        if (!prev.has(c.id)) return prev;
        const next = new Map(prev);
        next.delete(c.id);
        return next;
      });
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

      <div class="mb-3">
        <div class="flex items-center gap-2 mb-2">
          <button
            onClick={() => setConnectorFilterOpen((v) => !v)}
            class="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition cursor-pointer"
            aria-expanded={connectorFilterOpen || selectedConnectors.size > 0}
          >
            <span>{connectorFilterOpen || selectedConnectors.size > 0 ? '▼' : '▶'}</span>
            <span>{t('queue.connectorFilterLabel')}</span>
            {selectedConnectors.size > 0 ? (
              <span class="normal-case text-[color:var(--color-accent)]">
                · {selectedConnectors.size}
              </span>
            ) : null}
          </button>
          {selectedConnectors.size > 0 ? (
            <button
              onClick={() => setSelectedConnectors(new Set())}
              class="text-[10px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
            >
              {t('queue.connectorFilterClear')}
            </button>
          ) : null}
        </div>
        {connectorFilterOpen || selectedConnectors.size > 0 ? (
          <div class="flex flex-wrap gap-2">
            {LIVE_CONNECTORS.map((id) => (
              <ConnectorBadge
                key={id}
                variant="chip"
                connector={id}
                active={selectedConnectors.has(id)}
                onClick={() => toggleConnector(id)}
              />
            ))}
            {ROADMAP_CONNECTORS.map((id) => (
              <ConnectorBadge
                key={id}
                variant="chip"
                connector={id}
                active={false}
                disabled
                onClick={() => {}}
              />
            ))}
          </div>
        ) : null}
      </div>

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

      {!data && !error ? <CenteredLoader /> : null}

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
              {status === 'pending' && selectedWithRecommendation.length > 0 ? (
                <button
                  disabled={bulkBusy}
                  onClick={onBulkAcceptRecommendations}
                  title={t('queue.bulk.acceptRecommendationsHint', {
                    ready: selectedWithRecommendation.length,
                    total: selected.size,
                  })}
                  class="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded-md bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] font-medium hover:bg-[color:var(--color-accent)]/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <span>💡</span>
                  <span>
                    {t('queue.bulk.acceptRecommendations', {
                      n: selectedWithRecommendation.length,
                    })}
                  </span>
                </button>
              ) : null}
              {status === 'pending' && !allSelectedHaveRichActions ? (
                <button
                  disabled={bulkBusy || anySelectedHasRichActions}
                  onClick={onBulkApprove}
                  title={
                    anySelectedHasRichActions
                      ? t('queue.bulk.approveDisabledRich')
                      : undefined
                  }
                  class="px-3 py-1.5 text-[11px] rounded-md bg-[color:var(--color-fg)] text-[color:var(--color-bg)] font-medium hover:bg-[color:var(--color-fg)]/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
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
            slugByDocId={slugByDocId}
            isExpanded={expanded.has(c.id)}
            onToggle={() => toggleExpanded(c.id)}
            busy={acting.has(c.id)}
            busyActionId={acting.get(c.id)?.actionId ?? null}
            recommendationFailed={failedRecommendations.has(c.id)}
            showRecommendationOverlay={acting.get(c.id)?.viaRecommendation === true}
            onResolve={onResolve}
            onReopen={onReopen}
            selected={selected.has(c.id)}
            onToggleSelected={() => toggleSelected(c.id)}
            showCheckbox={status === 'pending'}
          />
        ))}
      </ul>

      {toast ? (
        <div
          class={
            'fixed bottom-6 right-6 z-50 max-w-md px-4 py-3 rounded-md border text-sm shadow-lg backdrop-blur-md ' +
            (toast.kind === 'success'
              ? 'border-[color:var(--color-success)]/60 bg-[color:var(--color-success)]/25 text-[color:var(--color-fg)]'
              : 'border-[color:var(--color-danger)]/60 bg-[color:var(--color-danger)]/25 text-[color:var(--color-fg)]')
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
  slugByDocId: Map<string, string>;
  isExpanded: boolean;
  onToggle: () => void;
  busy: boolean;
  /** Which actionId is in-flight on this row (null when idle). */
  busyActionId: string | null;
  /** Session-local flag: an earlier Accept on this row's recommendation
   *  failed. Used to force-expand the alternatives column so the
   *  curator sees the next-best options. */
  recommendationFailed: boolean;
  /** Recommendation-accept is in flight — render the big animation
   *  overlay across the whole card. Cleared when the resolve promise
   *  settles (success or failure). */
  showRecommendationOverlay: boolean;
  onResolve: (c: QueueCandidate, action: CandidateAction, opts?: { prefilledReason?: string; viaRecommendation?: boolean }) => void;
  onReopen: (c: QueueCandidate) => void;
  selected: boolean;
  onToggleSelected: () => void;
  showCheckbox: boolean;
}

function CandidateRow({
  candidate: c,
  kbId,
  slugByDocId,
  isExpanded,
  onToggle,
  busy,
  busyActionId,
  recommendationFailed,
  showRecommendationOverlay,
  onResolve,
  onReopen,
  selected,
  onToggleSelected,
  showCheckbox,
}: RowProps) {
  const meta = parseMetadata(c.metadata);
  // F91 — when the candidate's decision leads the curator to "edit
  // manually", show an Open-editor deep-link. Covers update-op candidates
  // (contradiction-alert's manual reconcile, orphan-neuron, stale) where
  // meta.targetDocumentId resolves to a known Neuron filename.
  // Try each known metadata shape in order: update/archive candidates use
  // targetDocumentId, orphan/stale use documentId, contradiction-alerts
  // use newDocumentId (the just-committed Neuron that triggered the
  // alert). First hit in slugByDocId wins.
  const editorDocId =
    meta?.targetDocumentId ?? meta?.documentId ?? meta?.newDocumentId ?? null;
  const editorSlug = editorDocId ? slugByDocId.get(editorDocId) : null;
  const editorHref = editorSlug
    ? `/kb/${encodeURIComponent(kbId)}/neurons/${encodeURIComponent(editorSlug)}?edit=1`
    : null;
  // Localised title + content. `bundle` starts with EN fallback and is
  // populated with the active locale's translations once they arrive (or
  // immediately, if the candidate already has them cached).
  const bundle = useCandidateBundle(c);
  const preview =
    bundle.content.length > 200
      ? bundle.content.slice(0, 200).replace(/\s+/g, ' ').trim() + '…'
      : bundle.content;

  return (
    <li
      class={
        'relative border rounded-md bg-[color:var(--color-bg-card)] transition ' +
        (selected
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5'
          : 'border-[color:var(--color-border)] hover:border-[color:var(--color-border-strong)]')
      }
    >
      {showRecommendationOverlay ? (
        <div
          class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 rounded-md bg-[color:var(--color-bg-card)]/85 backdrop-blur-sm text-[color:var(--color-accent)]"
          aria-live="polite"
          aria-busy="true"
        >
          <NeuronLoader size={180} />
          <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)]">
            {t('queue.recommended')} · {t('queue.acceptRecommendation')}…
          </div>
        </div>
      ) : null}
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
            {meta?.connector ? (
              <ConnectorBadge variant="tag" connector={meta.connector} />
            ) : null}
            <span
              title={t(`queue.kindHints.${c.kind}`)}
              class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]"
            >
              {t(`queue.kinds.${c.kind}`)}
            </span>
            <StatusBadge status={c.status} auto={!!c.autoApprovedAt} />
            {meta?.op ? (
              <span
                title={t(`queue.opHints.${meta.op}`)}
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]"
              >
                {t('queue.op.label')}: {t(`queue.op.${meta.op}`)}
              </span>
            ) : null}
            <ConfidencePill confidence={c.confidence} />
          </div>
          <div class="font-medium">{bundle.title}</div>
          {!isExpanded ? (
            <p class="text-sm text-[color:var(--color-fg-muted)] mt-1 line-clamp-3">{preview}</p>
          ) : null}
          <div class="mt-2 flex items-center gap-2 text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
            <span>
              {formatTs(c.createdAt)}
              {' · '}
              {c.createdBy ? t('queue.byAuthor', { who: c.createdBy }) : t('queue.byPipeline')}
            </span>
            <CopyId id={c.id} />
            {editorHref ? (
              <a
                href={editorHref}
                onClick={(e) => e.stopPropagation()}
                class="underline underline-offset-2 decoration-[color:var(--color-fg-subtle)]/60 hover:decoration-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] transition"
              >
                {t('neuronEditor.openEditor')}
              </a>
            ) : null}
          </div>
        </div>
        {c.status === 'pending' ? (
          <div class="flex flex-col gap-2 shrink-0 w-[280px]">
            {meta?.recommendation ? (
              <RecommendationBadge
                recommendation={meta.recommendation}
                actions={bundle.actions ?? c.actions}
                onAccept={(action, prefilledReason) =>
                  onResolve(c, action, { prefilledReason, viaRecommendation: true })
                }
                disabled={busy}
                failed={recommendationFailed}
              />
            ) : null}
            <DynamicActionButtons
              candidate={c}
              kbId={kbId}
              localisedActions={bundle.actions}
              busy={busy}
              busyActionId={busyActionId}
              onResolve={(action) => onResolve(c, action)}
              hideable={!!meta?.recommendation && !recommendationFailed}
            />
          </div>
        ) : c.status === 'rejected' ? (
          <div class="flex flex-col gap-1 shrink-0 items-end">
            <button
              disabled={busy}
              onClick={() => onReopen(c)}
              title={t('queue.item.reopenHint')}
              class="px-3 py-1.5 text-sm rounded-md border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] disabled:opacity-50 transition"
            >
              {busy ? '…' : t('queue.item.reopen')}
            </button>
            {c.rejectionReason ? (
              <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)] max-w-[200px] text-right truncate" title={c.rejectionReason}>
                "{c.rejectionReason}"
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <button
        onClick={onToggle}
        class="w-full text-left px-4 pb-3 text-[11px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)] transition"
      >
        {isExpanded ? `▲ ${t('queue.item.hideContent')}` : `▼ ${t('queue.item.showContent')}`}
      </button>

      {isExpanded ? <ExpandedContent candidate={c} meta={meta} kbId={kbId} content={bundle.content} /> : null}
    </li>
  );
}

function ExpandedContent({
  candidate: _c,
  meta,
  kbId,
  content,
}: {
  candidate: QueueCandidate;
  meta: CandidateOpMeta | null;
  kbId: string;
  /** Localised markdown body to render — parent supplies the already-
   *  translated version for the active locale (or the EN original). */
  content: string;
}) {
  // Render markdown content. Trust the candidate content — it comes from
  // either an authenticated user (chat-answer) or our own pipelines
  // (ingest-*, reader-feedback will need sanitisation once F31 lands).
  // Rewrite `[[wiki-link]]` before marked.parse so cross-Neuron references
  // become real anchors here too, not just in the reader.
  const html = marked.parse(rewriteWikiLinks(content, kbId), { async: false }) as string;

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
  const labelKey = status === 'approved' && auto ? 'queue.status.autoApproved' : `queue.status.${status}`;
  const label = t(labelKey);
  const hint = t(
    status === 'approved' && auto ? 'queue.statusHints.autoApproved' : `queue.statusHints.${status}`,
  );
  const tone =
    status === 'approved'
      ? 'bg-[color:var(--color-success)]/10 text-[color:var(--color-success)]'
      : status === 'rejected'
      ? 'bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
      : 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]';
  return (
    <span
      title={hint}
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

/**
 * F96 — "💡 Anbefalet: X" card that lives between the candidate body
 * and the action button column. Renders the LLM's recommended action
 * label + a 1-3 sentence reasoning + a direct Accept button that
 * dispatches the matching action. Confidence score rides as a pill.
 * Disabled entirely when the matched action is a reject-effect —
 * those need the reason-modal flow, not one-click.
 */
function RecommendationBadge({
  recommendation,
  actions,
  onAccept,
  disabled,
  failed,
}: {
  recommendation: NonNullable<CandidateOpMeta['recommendation']>;
  actions: CandidateAction[] | null;
  onAccept: (action: CandidateAction, prefilledReason?: string) => void;
  disabled: boolean;
  /** Earlier Accept click on this recommendation failed (LLM inferer
   *  came up empty, etc.). Render the card in a muted state + guide
   *  the curator down to the alternatives below. */
  failed?: boolean;
}) {
  const matched = (actions ?? []).find((a) => a.id === recommendation.recommendedActionId);
  if (!matched) return null;
  const locale = useLocale();
  // For reject-effect recommendations, pass the LLM's reasoning as the
  // prefilled rejection reason so onResolve skips the modal round-trip.
  const acceptArg = matched.effect === 'reject' ? recommendation.reasoning : undefined;
  // Vertical stack: lives inside the 280px action column. Header row
  // (badge + pill), then label, then reasoning, then accept button.
  // Accept works for ALL effect kinds — dismiss/reject recommendations
  // fire with the LLM's reasoning as the rejection reason so the curator
  // still gets a record without the modal round-trip.
  return (
    <div class="rounded-md border border-[color:var(--color-accent)]/40 bg-[color:var(--color-accent)]/10 px-3 py-2 flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-accent)]">
          {t('queue.recommended')}
        </span>
        <ConfidencePill confidence={recommendation.confidence} />
      </div>
      <div class="text-[12px] font-medium leading-tight break-words">
        {bilingual(matched.label, locale)}
      </div>
      <p class="text-[11px] text-[color:var(--color-fg-muted)] leading-snug break-words">
        {recommendation.reasoning}
      </p>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAccept(matched, acceptArg);
        }}
        disabled={disabled}
        class="w-full px-2.5 py-1.5 text-[11px] font-medium rounded-md bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] hover:bg-[color:var(--color-accent)]/90 disabled:opacity-50 transition mt-1"
      >
        {t('queue.acceptRecommendation')}
      </button>
    </div>
  );
}
