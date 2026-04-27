/**
 * F164 Phase 6 — Jobs history panel.
 *
 * Top-level admin page (/admin/jobs, not per-KB) listing every background
 * job for the current tenant. Filters by status/kind, ordered by
 * created_at DESC. Aggregate-stats header shows total count, status
 * breakdown, and total cost over the listed window.
 *
 * Click a row → re-foregrounds the job via showJob() so the curator
 * sees the JobProgressModal in its current state (live progress for
 * running jobs, completion view for terminal ones — the modal handles
 * both modes already).
 *
 * Polling: refetches every 5s when ANY job is non-terminal in the
 * current view. Cuts to silence when everything is settled — keeps
 * the page calm for historical browsing.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { listJobs, type Job } from '../api';
import { showJob } from '../lib/jobs-store';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';

type StatusFilter = 'all' | 'active' | 'completed' | 'failed' | 'aborted';

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter }> = [
  { value: 'all' },
  { value: 'active' },
  { value: 'completed' },
  { value: 'failed' },
  { value: 'aborted' },
];

const POLL_INTERVAL_MS = 5_000;

export function JobsPanel() {
  useLocale();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<string>('');

  const fetchJobs = async () => {
    try {
      // Fetch up to 200 — enough for aggregate stats; richer pagination
      // is a follow-up if the page gets used at scale.
      const r = await listJobs({ limit: 200 });
      setJobs(r.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void fetchJobs();
  }, []);

  // Quiet poll: only run while at least one job is non-terminal.
  // Saves the network when the page is opened on a settled tenant.
  const hasActive = jobs?.some((j) => j.status === 'pending' || j.status === 'running') ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => void fetchJobs(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasActive]);

  const filtered = useMemo(() => {
    if (!jobs) return null;
    let out = jobs;
    if (statusFilter !== 'all') {
      if (statusFilter === 'active') {
        out = out.filter((j) => j.status === 'pending' || j.status === 'running');
      } else {
        out = out.filter((j) => j.status === statusFilter);
      }
    }
    if (kindFilter) out = out.filter((j) => j.kind === kindFilter);
    return out;
  }, [jobs, statusFilter, kindFilter]);

  const stats = useMemo(() => {
    if (!jobs) return null;
    const total = jobs.length;
    const active = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
    const completed = jobs.filter((j) => j.status === 'completed').length;
    const failed = jobs.filter((j) => j.status === 'failed').length;
    const aborted = jobs.filter((j) => j.status === 'aborted').length;
    const totalCostCents = jobs.reduce((sum, j) => sum + (j.costCentsActual ?? 0), 0);
    const kinds = Array.from(new Set(jobs.map((j) => j.kind))).sort();
    return { total, active, completed, failed, aborted, totalCostCents, kinds };
  }, [jobs]);

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('jobsPanel.title')}</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {jobs ? (
            t(
              jobs.length === 1 ? 'jobsPanel.summary' : 'jobsPanel.summaryPlural',
              { n: jobs.length },
            )
          ) : (
            <span class="loading-delayed inline-block">{t('common.loading')}</span>
          )}
        </p>
      </header>

      {stats ? (
        <section class="mb-6 grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label={t('jobsPanel.statTotal')} value={String(stats.total)} />
          <StatTile label={t('jobsPanel.statActive')} value={String(stats.active)} tone="accent" />
          <StatTile label={t('jobsPanel.statCompleted')} value={String(stats.completed)} tone="success" />
          <StatTile label={t('jobsPanel.statFailed')} value={String(stats.failed)} tone="danger" />
          <StatTile label={t('jobsPanel.statCost')} value={formatCents(stats.totalCostCents)} />
        </section>
      ) : null}

      <nav class="flex gap-1 mb-3 border-b border-[color:var(--color-border)]">
        {STATUS_FILTERS.map((tab) => {
          const count =
            tab.value === 'all'
              ? stats?.total
              : tab.value === 'active'
              ? stats?.active
              : tab.value === 'completed'
              ? stats?.completed
              : tab.value === 'failed'
              ? stats?.failed
              : stats?.aborted;
          return (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              class={
                'inline-flex items-baseline gap-1.5 px-3 py-2 text-sm font-medium transition border-b-2 -mb-px ' +
                (statusFilter === tab.value
                  ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                  : 'border-transparent text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
              }
            >
              {t(`jobsPanel.filter.${tab.value}`)}
              {count !== undefined ? (
                <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
                  ({count})
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {stats && stats.kinds.length > 1 ? (
        <div class="mb-4 flex items-center gap-2 text-xs font-mono text-[color:var(--color-fg-muted)]">
          <span>{t('jobsPanel.kindFilter')}:</span>
          <button
            type="button"
            onClick={() => setKindFilter('')}
            class={
              'px-2 py-0.5 rounded ' +
              (kindFilter === ''
                ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                : 'border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-card)]')
            }
          >
            {t('jobsPanel.kindAll')}
          </button>
          {stats.kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              class={
                'px-2 py-0.5 rounded ' +
                (kindFilter === k
                  ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                  : 'border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-card)]')
              }
            >
              {k}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm mb-4">
          {error}
        </div>
      ) : null}

      {!jobs && !error ? <CenteredLoader /> : null}

      {filtered && filtered.length === 0 ? (
        <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
          {t(`jobsPanel.empty.${statusFilter}` as never)}
        </div>
      ) : null}

      {filtered && filtered.length > 0 ? (
        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="text-left text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] border-b border-[color:var(--color-border)]">
                <th class="px-3 py-2 font-normal">{t('jobsPanel.col.kind')}</th>
                <th class="px-3 py-2 font-normal">{t('jobsPanel.col.status')}</th>
                <th class="px-3 py-2 font-normal">{t('jobsPanel.col.progress')}</th>
                <th class="px-3 py-2 font-normal">{t('jobsPanel.col.created')}</th>
                <th class="px-3 py-2 font-normal">{t('jobsPanel.col.duration')}</th>
                <th class="px-3 py-2 font-normal text-right">{t('jobsPanel.col.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const onClick = () => showJob(job.id);
  return (
    <tr
      class="border-b border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-card)]/40 cursor-pointer transition"
      onClick={onClick}
    >
      <td class="px-3 py-2 font-mono text-xs">{job.kind}</td>
      <td class="px-3 py-2">
        <StatusBadge status={job.status} />
      </td>
      <td class="px-3 py-2 font-mono text-xs text-[color:var(--color-fg-muted)]">
        {formatProgress(job)}
      </td>
      <td class="px-3 py-2 font-mono text-xs text-[color:var(--color-fg-muted)]">
        {formatRelative(job.createdAt)}
      </td>
      <td class="px-3 py-2 font-mono text-xs text-[color:var(--color-fg-muted)]">
        {formatDuration(job.startedAt, job.finishedAt)}
      </td>
      <td class="px-3 py-2 font-mono text-xs text-right text-[color:var(--color-fg-muted)]">
        {formatCents(job.costCentsActual)}
      </td>
    </tr>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger' | 'accent';
}) {
  const cls =
    tone === 'success'
      ? 'text-[color:var(--color-success)]'
      : tone === 'danger'
      ? 'text-[color:var(--color-danger)]'
      : tone === 'accent'
      ? 'text-[color:var(--color-accent)]'
      : 'text-[color:var(--color-fg)]';
  return (
    <div class="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/40 px-3 py-2">
      <div class={`text-xl font-semibold tabular-nums ${cls}`}>{value}</div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mt-0.5">
        {label}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Job['status'] }) {
  const tone =
    status === 'completed'
      ? 'bg-[color:var(--color-success)]/15 text-[color:var(--color-success)]'
      : status === 'failed'
      ? 'bg-[color:var(--color-danger)]/15 text-[color:var(--color-danger)]'
      : status === 'running' || status === 'pending'
      ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)]'
      : 'bg-[color:var(--color-bg)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]';
  return (
    <span class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider ${tone}`}>
      {status}
    </span>
  );
}

function formatProgress(job: Job): string {
  const p = job.progress as { current?: number; total?: number } | null;
  if (!p?.total) return '—';
  return `${p.current ?? 0} / ${p.total}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '—';
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const ms = end - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  return `${hr}h ${remMin}m`;
}

function formatCents(c: number | null | undefined): string {
  if (c == null) return '—';
  if (c === 0) return '$0.00';
  return `$${(c / 100).toFixed(2)}`;
}
