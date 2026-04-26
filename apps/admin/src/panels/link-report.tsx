/**
 * F150 — Link Check panel. Visual surface for F148's broken_links table.
 *
 * Curator sees one row per open finding (source-Neuron + broken link-text
 * + suggested fix). Three actions:
 *
 *   - Accept (only when suggested_fix present) — POST /link-check/:id/accept
 *     rewrites the source content via submitCuratorEdit, flips status to
 *     auto_fixed.
 *   - Dismiss — POST /link-check/:id/dismiss, marks intentional.
 *   - Reopen — POST /link-check/:id/reopen for previously-dismissed rows
 *     (note: status filter is server-side; reopen UX surfaces if we ever
 *     show the dismissed list here).
 *
 * Footer: "Rescan now" button → POST /link-check/rescan, then refetch.
 *
 * SSE: subscribe to `candidate_approved` for this KB — when any Neuron
 * commits, link-checker may have re-resolved or recorded findings on the
 * back of `extractBacklinksForDoc`, so refetch.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import {
  getLinkCheckFindings,
  acceptLinkFix,
  dismissLinkFinding,
  rescanLinkCheck,
  ApiError,
  type LinkFinding,
  type LinkRescanSummary,
} from '../api';
import { useKb } from '../lib/kb-cache';
import { useKbEvents } from '../lib/event-stream';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';

export function LinkReportPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const kb = useKb(kbId);
  useLocale();

  const [findings, setFindings] = useState<LinkFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [rescanResult, setRescanResult] = useState<LinkRescanSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const reload = useCallback(() => {
    if (!kbId) return;
    getLinkCheckFindings(kbId)
      .then((data) => {
        setFindings(data.findings);
        setError(null);
      })
      .catch((err: ApiError) => {
        setError(err.message);
        setFindings([]);
      });
  }, [kbId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Live updates: any candidate_approved for this KB might have changed
  // the link-pool — refetch.
  useKbEvents(kbId, (e) => {
    if (e.type === 'candidate_approved') reload();
  });

  const showToast = useCallback((kind: 'ok' | 'err', message: string) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const onAccept = useCallback(
    async (id: string) => {
      if (busyId) return;
      setBusyId(id);
      try {
        await acceptLinkFix(id);
        showToast('ok', t('linkReport.accepted'));
        reload();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          showToast('ok', t('linkReport.acceptDismissed'));
          reload();
        } else {
          showToast('err', err instanceof Error ? err.message : t('linkReport.actionFailed'));
        }
      } finally {
        setBusyId(null);
      }
    },
    [busyId, reload, showToast],
  );

  const onDismiss = useCallback(
    async (id: string) => {
      if (busyId) return;
      setBusyId(id);
      try {
        await dismissLinkFinding(id);
        reload();
      } catch (err) {
        showToast('err', err instanceof Error ? err.message : t('linkReport.actionFailed'));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, reload, showToast],
  );

  const onRescan = useCallback(async () => {
    if (!kbId || rescanning) return;
    setRescanning(true);
    setRescanResult(null);
    try {
      const summary = await rescanLinkCheck(kbId);
      setRescanResult(summary);
      reload();
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : t('linkReport.actionFailed'));
    } finally {
      setRescanning(false);
    }
  }, [kbId, rescanning, reload, showToast]);

  if (!kbId) return null;

  const formatRescan = (s: LinkRescanSummary): string =>
    t('linkReport.rescanResult')
      .replace('{docs}', String(s.docsScanned))
      .replace('{open}', String(s.openRecorded))
      .replace('{resolved}', String(s.resolved));

  return (
    <div class="page-shell">
      <header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('linkReport.title')}</h1>
          <p class="text-[color:var(--color-fg-muted)] text-sm max-w-3xl">
            {t('linkReport.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRescan}
          disabled={rescanning}
          class="shrink-0 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] transition disabled:opacity-50 disabled:cursor-wait"
        >
          {rescanning ? t('linkReport.rescanning') : t('linkReport.rescan')}
        </button>
      </header>

      {error ? (
        <div class="mb-4 px-3 py-2 text-sm rounded bg-red-500/10 text-red-400 border border-red-500/30">
          {error}
        </div>
      ) : null}

      {rescanResult ? (
        <div class="mb-4 px-3 py-2 text-sm rounded bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] border border-[color:var(--color-accent)]/30 font-mono">
          {formatRescan(rescanResult)}
        </div>
      ) : null}

      {findings === null ? <CenteredLoader /> : null}

      {findings !== null && findings.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-muted)]">
          <div class="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] mb-4">
            <CheckIcon />
          </div>
          <p class="text-base">{t('linkReport.empty')}</p>
        </div>
      ) : null}

      {findings !== null && findings.length > 0 ? (
        <div class="overflow-x-auto rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/30">
          <table class="w-full text-sm">
            <thead class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)]">
              <tr class="border-b border-[color:var(--color-border)]">
                <th class="text-left px-4 py-2 font-medium">{t('linkReport.col.from')}</th>
                <th class="text-left px-4 py-2 font-medium">{t('linkReport.col.linkText')}</th>
                <th class="text-left px-4 py-2 font-medium">{t('linkReport.col.suggestedFix')}</th>
                <th class="text-left px-4 py-2 font-medium">{t('linkReport.col.reportedAt')}</th>
                <th class="text-right px-4 py-2 font-medium">{t('linkReport.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  kbSlug={kb?.slug ?? kbId}
                  busy={busyId === f.id}
                  onAccept={() => onAccept(f.id)}
                  onDismiss={() => onDismiss(f.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {toast ? (
        <div
          class={
            'fixed bottom-6 right-6 px-4 py-2 rounded-md shadow-lg text-sm border ' +
            (toast.kind === 'ok'
              ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] border-[color:var(--color-accent)]/30'
              : 'bg-red-500/10 text-red-400 border-red-500/30')
          }
          role="status"
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

function FindingRow({
  finding,
  kbSlug,
  busy,
  onAccept,
  onDismiss,
}: {
  finding: LinkFinding;
  kbSlug: string;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const slug = finding.fromFilename.replace(/\.md$/, '');
  const href = `/kb/${kbSlug}/neurons/${slug}`;
  return (
    <tr class="border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-bg-card)]/40 transition">
      <td class="px-4 py-3">
        <a
          href={href}
          class="text-[color:var(--color-fg)] hover:text-[color:var(--color-accent)] transition"
        >
          {finding.fromTitle ?? finding.fromFilename}
        </a>
      </td>
      <td class="px-4 py-3 font-mono text-[12px] text-[color:var(--color-fg-muted)]">
        [[{finding.linkText}]]
      </td>
      <td class="px-4 py-3 font-mono text-[12px]">
        {finding.suggestedFix ? (
          <span class="text-[color:var(--color-accent)]">{finding.suggestedFix}</span>
        ) : (
          <span class="text-[color:var(--color-fg-subtle)]">{t('linkReport.noSuggestion')}</span>
        )}
      </td>
      <td class="px-4 py-3 font-mono text-[11px] text-[color:var(--color-fg-muted)]">
        {finding.reportedAt.slice(0, 10)}
      </td>
      <td class="px-4 py-3 text-right">
        <div class="inline-flex items-center gap-2 justify-end">
          {finding.suggestedFix ? (
            <button
              type="button"
              onClick={onAccept}
              disabled={busy}
              class="px-2 py-1 text-[11px] font-mono uppercase tracking-wider rounded border border-[color:var(--color-accent)]/40 text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent)] hover:text-[color:var(--color-accent-fg)] active:scale-95 transition disabled:opacity-50 disabled:cursor-wait"
            >
              {t('linkReport.action.accept')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            class="px-2 py-1 text-[11px] font-mono uppercase tracking-wider rounded border border-[color:var(--color-border-strong)] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:border-[color:var(--color-fg)] active:scale-95 transition disabled:opacity-50 disabled:cursor-wait"
          >
            {t('linkReport.action.dismiss')}
          </button>
        </div>
      </td>
    </tr>
  );
}

function CheckIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
