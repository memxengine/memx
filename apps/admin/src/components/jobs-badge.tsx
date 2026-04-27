/**
 * F164 Phase 4 — JobsBadge.
 *
 * Compact header element. Shows count of currently-backgrounded jobs;
 * click → re-foregrounds the most recent. Polls /api/v1/jobs?status=…
 * every 4s as a defensive sweep so a job that completes while the
 * modal is closed AND was never backgrounded (rare path: user reload
 * during a long job) still shows up here.
 *
 * Hidden when count = 0 — keeps the header clean for the common case
 * where no background work is running.
 */
import { useComputed, useSignalEffect } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { backgroundedJobIds, showJob } from '../lib/jobs-store';
import { listJobs } from '../api';
import { t } from '../lib/i18n';

const POLL_INTERVAL_MS = 4_000;

export function JobsBadge() {
  const [serverActive, setServerActive] = useState<string[]>([]);

  // Poll for any active jobs server-side as a defensive sweep — covers
  // the case where the user reloaded during a long job, the modal isn't
  // open, and the job isn't in backgroundedJobIds yet.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await listJobs({ status: 'pending,running', limit: 20 });
        if (!cancelled) {
          setServerActive(r.jobs.map((j) => j.id));
        }
      } catch {
        // ignore; just retry next tick
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Re-render whenever signals change.
  const merged = useComputed(() => {
    const fromSignal = backgroundedJobIds.value;
    const set = new Set<string>([...fromSignal, ...serverActive]);
    return Array.from(set);
  });

  // Auto-bring-back: if the user reloaded mid-job and the server still
  // has it as running, surface it through the badge so they can click
  // back into it. Idempotent — `showJob` no-ops if already visible.
  useSignalEffect(() => {
    const ids = merged.value;
    if (ids.length === 0) return;
    // If nothing is currently visible AND nothing is backgrounded by the
    // user, hoist the freshest server-side active job into the badge so
    // the count reflects reality.
  });

  const count = merged.value.length;
  if (count === 0) return null;

  const onClick = () => {
    // Foreground the most recent job — array order from listJobs is
    // DESC created_at, so the first id is freshest.
    const ids = merged.value;
    const next = ids[0];
    if (next) showJob(next);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      class="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-mono rounded-md border border-[color:var(--color-accent)]/40 bg-[color:var(--color-accent)]/5 text-[color:var(--color-accent)] hover:bg-[color:var(--color-accent)]/10 transition"
      title={t('jobs.badgeTooltip', { n: count })}
      aria-label={t('jobs.badgeTooltip', { n: count })}
    >
      <span class="relative flex h-2 w-2">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[color:var(--color-accent)] opacity-75" />
        <span class="relative inline-flex rounded-full h-2 w-2 bg-[color:var(--color-accent)]" />
      </span>
      <span>{t('jobs.badgeLabel', { n: count })}</span>
    </button>
  );
}
