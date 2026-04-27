/**
 * F164 Phase 4 — JobProgressModal.
 *
 * Shows live progress for a single job. Subscribes via SSE (useJobProgress
 * hook). Three modes by terminal-state:
 *   - null (still running) → progress bar + ETA + counters + "Kør i
 *     baggrunden" / "Annullér" buttons
 *   - 'completed' → completion view with described/decorative/failed
 *     summary + 6-image sample-grid (Phase 5 adds 👍👎)
 *   - 'error' / 'aborted' → terminal-error view with retry option
 *
 * "Kør i baggrunden" pushes the jobId into the backgroundedJobIds signal
 * — header badge picks up the count and lets the user re-foreground.
 *
 * The modal is mounted once at app root (apps/admin/src/app.tsx) and
 * driven by visibleJobId signal. Per-row "Run Vision" callsites just
 * call `showJob(jobId)` after submit; they don't render the modal
 * themselves.
 */
import { useSignal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { Modal, ModalButton } from './modal';
import { abortJob, setImageRating, type ImageRating } from '../api';
import { useJobProgress } from '../lib/use-job-progress';
import { visibleJobId, backgroundJob, dismissJob } from '../lib/jobs-store';
import { lockBodyScroll } from '../lib/scroll-lock';
import { t } from '../lib/i18n';

export function JobProgressModalRoot() {
  // Read the signal directly so this component re-renders on signal change.
  const jobId = visibleJobId.value;
  return (
    <JobProgressModal
      jobId={jobId}
      onClose={() => {
        if (jobId) dismissJob(jobId);
      }}
      onBackground={() => {
        if (jobId) backgroundJob(jobId);
      }}
    />
  );
}

function JobProgressModal({
  jobId,
  onClose,
  onBackground,
}: {
  jobId: string | null;
  onClose: () => void;
  onBackground: () => void;
}) {
  const state = useJobProgress(jobId);
  const aborting = useSignal(false);

  const open = jobId !== null;

  if (!open) {
    return <Modal open={false} title="" onClose={onClose}>{null}</Modal>;
  }

  const isRunning = state.terminal === null;
  const isCompleted = state.terminal === 'completed';
  const isErrored = state.terminal === 'error';
  const isAborted = state.terminal === 'aborted';

  const onAbort = async () => {
    if (!jobId || aborting.value) return;
    aborting.value = true;
    try {
      await abortJob(jobId);
    } catch {
      // ignore — UI will reflect terminal state via SSE either way
    }
  };

  return (
    <Modal
      open={open}
      title={titleFor(state, jobId ?? '')}
      onClose={onClose}
      maxWidth="lg"
      footer={
        isRunning ? (
          <>
            <ModalButton onClick={onAbort} disabled={aborting.value}>
              {aborting.value ? '…' : t('jobs.abort')}
            </ModalButton>
            <ModalButton onClick={onBackground}>{t('jobs.background')}</ModalButton>
          </>
        ) : (
          <ModalButton onClick={onClose}>{t('common.close')}</ModalButton>
        )
      }
    >
      {isRunning ? <RunningView state={state} /> : null}
      {isCompleted ? <CompletedView state={state} /> : null}
      {isErrored ? <ErrorView state={state} /> : null}
      {isAborted ? <AbortedView state={state} /> : null}
    </Modal>
  );
}

function titleFor(state: ReturnType<typeof useJobProgress>, _jobId: string): string {
  const kind = state.snapshot?.kind ?? 'job';
  const label =
    kind === 'vision-rerun' || kind === 'bulk-vision-rerun'
      ? t('jobs.kind.visionRerun')
      : kind;
  if (state.terminal === 'completed') return t('jobs.titleCompleted', { kind: label });
  if (state.terminal === 'error') return t('jobs.titleFailed', { kind: label });
  if (state.terminal === 'aborted') return t('jobs.titleAborted', { kind: label });
  return label;
}

function RunningView({ state }: { state: ReturnType<typeof useJobProgress> }) {
  const p = state.progress ?? { current: 0, total: 0, etaMs: null, extra: {} };
  const total = p.total || 0;
  const current = p.current || 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const described = (p.extra?.described as number | undefined) ?? 0;
  const decorative = (p.extra?.decorative as number | undefined) ?? 0;
  const failed = (p.extra?.failed as number | undefined) ?? 0;
  const eta = formatEta(p.etaMs ?? null);
  const cost = state.snapshot?.costCentsActual ?? 0;
  const estCost = state.snapshot?.costCentsEstimated ?? null;

  return (
    <div class="space-y-4">
      <div class="space-y-1">
        <div class="flex items-baseline justify-between text-sm">
          <span class="font-mono">
            {current} / {total}
          </span>
          <span class="text-[color:var(--color-fg-muted)]">{pct}%</span>
        </div>
        <div class="h-2 w-full bg-[color:var(--color-bg)] rounded overflow-hidden border border-[color:var(--color-border)]">
          <div
            class="h-full bg-[color:var(--color-accent)] transition-all duration-200"
            style={`width: ${pct}%`}
          />
        </div>
        {eta ? (
          <div class="text-xs font-mono text-[color:var(--color-fg-muted)]">{t('jobs.eta', { time: eta })}</div>
        ) : null}
      </div>

      <div class="grid grid-cols-3 gap-3 text-center">
        <Counter label={t('jobs.described')} value={described} tone="success" />
        <Counter label={t('jobs.decorative')} value={decorative} tone="neutral" />
        <Counter label={t('jobs.failed')} value={failed} tone="danger" />
      </div>

      {estCost !== null || cost > 0 ? (
        <div class="text-xs font-mono text-[color:var(--color-fg-muted)] flex justify-between border-t border-[color:var(--color-border)] pt-2">
          <span>{t('jobs.cost')}</span>
          <span>
            {estCost !== null ? `${t('jobs.estimate')}: ${formatCents(estCost)} · ` : ''}
            {t('jobs.actual')}: {formatCents(cost)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function CompletedView({ state }: { state: ReturnType<typeof useJobProgress> }) {
  const r = state.result;
  const [lightbox, setLightbox] = useState<{
    documentId: string;
    filename: string;
    description: string;
  } | null>(null);
  // Local cache of ratings per image-filename so SampleTile + Lightbox
  // share state. Optimistic updates: we flip the local map immediately
  // on click, then the POST persists. Rollback on error reverts.
  const [ratings, setRatings] = useState<Record<string, ImageRating>>({});

  const onRate = async (img: { documentId: string; filename: string }, next: ImageRating) => {
    const key = img.filename;
    const prev = ratings[key] ?? null;
    setRatings((r) => ({ ...r, [key]: next }));
    try {
      await setImageRating(img.documentId, img.filename, next);
    } catch {
      // Revert on failure
      setRatings((r) => ({ ...r, [key]: prev }));
    }
  };

  if (!r) return <div>{t('jobs.completedNoResult')}</div>;
  const elapsed = computeElapsed(state.snapshot);
  const cost = state.snapshot?.costCentsActual ?? 0;
  const ratingCounts = countRatings(ratings);

  return (
    <div class="space-y-4">
      {/* Human-friendly headline + per-category lines. Decorative + failed
          rows render only when their count > 0 so a clean "all described"
          run shows a single positive line — no jargon-blast. */}
      <div class="space-y-2">
        <p class="text-sm leading-relaxed">
          {r.described > 0
            ? t('jobs.completionHeadline', { described: r.described, elapsed })
            : t('jobs.completionHeadlineNoneDescribed', { total: r.total, elapsed })}
        </p>
        {r.decorative > 0 ? (
          <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
            {t('jobs.decorativeLine', { n: r.decorative })}
          </p>
        ) : null}
        {r.failed > 0 ? (
          <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
            {t('jobs.failedLine', { n: r.failed })}
          </p>
        ) : null}
        {cost > 0 ? (
          <p class="text-xs font-mono text-[color:var(--color-fg-subtle)]">
            {t('jobs.costLine', { cost: formatCents(cost) })}
          </p>
        ) : null}
      </div>

      {r.sampleImages?.length ? (
        <div>
          <div class="flex items-baseline justify-between mb-2">
            <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
              {t('jobs.sampleGrid')}
            </div>
            {ratingCounts.up + ratingCounts.down > 0 ? (
              <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
                {t('jobs.ratingSummary', { up: ratingCounts.up, down: ratingCounts.down })}
              </div>
            ) : null}
          </div>
          <p class="text-[11px] text-[color:var(--color-fg-subtle)] mb-2 italic">
            {t('jobs.ratingHint')}
          </p>
          <div class="grid grid-cols-3 gap-2">
            {r.sampleImages.map((img) => (
              <SampleTile
                key={img.id}
                img={img}
                rating={ratings[img.filename] ?? null}
                onOpen={() => setLightbox(img)}
                onRate={(next) => onRate(img, next)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {lightbox ? (
        <Lightbox
          documentId={lightbox.documentId}
          filename={lightbox.filename}
          description={lightbox.description}
          rating={ratings[lightbox.filename] ?? null}
          onRate={(next) => onRate(lightbox, next)}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

function countRatings(map: Record<string, ImageRating>): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const v of Object.values(map)) {
    if (v === 'up') up += 1;
    else if (v === 'down') down += 1;
  }
  return { up, down };
}

function ErrorView({ state }: { state: ReturnType<typeof useJobProgress> }) {
  return (
    <div class="space-y-3">
      <p class="text-sm text-[color:var(--color-danger)] leading-relaxed">
        {state.errorMessage ?? t('jobs.unknownError')}
      </p>
    </div>
  );
}

function AbortedView({ state }: { state: ReturnType<typeof useJobProgress> }) {
  const p = state.progress;
  const partial = p ? `${p.current} / ${p.total}` : '—';
  return (
    <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
      {t('jobs.abortedSummary', { partial })}
    </p>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: 'success' | 'neutral' | 'danger' }) {
  const cls =
    tone === 'success'
      ? 'text-[color:var(--color-success)]'
      : tone === 'danger'
      ? 'text-[color:var(--color-danger)]'
      : 'text-[color:var(--color-fg-muted)]';
  return (
    <div class="rounded-md border border-[color:var(--color-border)] py-2">
      <div class={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
      <div class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mt-1">
        {label}
      </div>
    </div>
  );
}

function SampleTile({
  img,
  rating,
  onOpen,
  onRate,
}: {
  img: { id: string; documentId: string; filename: string; description: string };
  rating: ImageRating;
  onOpen: () => void;
  onRate: (next: ImageRating) => void;
}) {
  const url = imageUrl(img.documentId, img.filename);
  // Click on the rating buttons must not also trigger the parent
  // open-lightbox button — stopPropagation the click.
  const stop = (e: Event) => e.stopPropagation();
  const toggle = (next: 'up' | 'down') => (e: MouseEvent) => {
    e.stopPropagation();
    onRate(rating === next ? null : next);
  };
  return (
    <button
      type="button"
      onClick={onOpen}
      class="group relative block aspect-square overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] cursor-zoom-in active:scale-[0.98] transition"
      title={img.description}
    >
      <img
        src={url}
        alt={img.description}
        loading="lazy"
        class="w-full h-full object-cover transition group-hover:scale-105"
      />
      <div class="absolute inset-x-0 bottom-0 p-1.5 text-[10px] font-mono text-white bg-gradient-to-t from-black/80 to-transparent line-clamp-2 text-left pr-14">
        {img.description.slice(0, 80)}
        {img.description.length > 80 ? '…' : ''}
      </div>
      <div
        class="absolute top-1.5 right-1.5 flex items-center gap-1"
        onClick={stop}
      >
        <RatingPill active={rating === 'up'} variant="up" onClick={toggle('up')} />
        <RatingPill active={rating === 'down'} variant="down" onClick={toggle('down')} />
      </div>
    </button>
  );
}

function RatingPill({
  active,
  variant,
  onClick,
}: {
  active: boolean;
  variant: 'up' | 'down';
  onClick: (e: MouseEvent) => void;
}) {
  const glyph = variant === 'up' ? '👍' : '👎';
  const label = variant === 'up' ? t('jobs.thumbsUp') : t('jobs.thumbsDown');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      class={
        'inline-flex items-center justify-center w-7 h-7 rounded-full text-sm transition active:scale-90 ' +
        (active
          ? variant === 'up'
            ? 'bg-[color:var(--color-success)]/30 ring-2 ring-[color:var(--color-success)]'
            : 'bg-[color:var(--color-danger)]/30 ring-2 ring-[color:var(--color-danger)]'
          : 'bg-black/40 hover:bg-black/60')
      }
    >
      {glyph}
    </button>
  );
}

/**
 * Fullscreen image lightbox. ESC + big × in top-right + backdrop-click
 * all close. Sits on top of the JobProgressModal (z-60 vs the modal's
 * default ~z-50). Renders the image full-bleed with a description
 * footer; cursor-zoom-out on the backdrop signals "click anywhere to
 * close". Native dialog/popover not used because Trail's Modal pattern
 * already owns the styling tokens — staying consistent.
 */
function Lightbox({
  documentId,
  filename,
  description,
  rating,
  onRate,
  onClose,
}: {
  documentId: string;
  filename: string;
  description: string;
  rating: ImageRating;
  onRate: (next: ImageRating) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // capture-phase so we steal ESC before the parent Modal sees it.
    // Without this, the parent JobProgressModal would also close on ESC.
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as never);
  }, [onClose]);

  // Lock body scroll while lightbox is open. Ref-counted via shared
  // helper so overlapping with parent Modal doesn't double-restore.
  useEffect(() => lockBodyScroll(), []);

  const url = imageUrl(documentId, filename);

  return (
    <div
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/90 backdrop-blur-sm cursor-zoom-out"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={description || filename}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        class="absolute top-4 right-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white text-3xl font-bold leading-none transition cursor-pointer"
        aria-label="Close (Esc)"
        title="Close (Esc)"
      >
        ×
      </button>

      <img
        src={url}
        alt={description}
        onClick={(e) => e.stopPropagation()}
        class="max-w-[90vw] max-h-[75vh] object-contain rounded-md cursor-default shadow-2xl"
      />

      {description ? (
        <div
          class="mt-4 max-w-[80vw] px-4 py-2 text-sm text-white/90 text-center leading-relaxed"
          onClick={(e) => e.stopPropagation()}
        >
          {description}
        </div>
      ) : null}

      <div
        class="mt-4 flex items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => onRate(rating === 'up' ? null : 'up')}
          class={
            'inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm transition active:scale-95 ' +
            (rating === 'up'
              ? 'bg-[color:var(--color-success)]/30 ring-2 ring-[color:var(--color-success)] text-white'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          aria-label={t('jobs.thumbsUp')}
        >
          <span class="text-lg">👍</span>
          <span class="font-mono text-xs">{t('jobs.thumbsUp')}</span>
        </button>
        <button
          type="button"
          onClick={() => onRate(rating === 'down' ? null : 'down')}
          class={
            'inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm transition active:scale-95 ' +
            (rating === 'down'
              ? 'bg-[color:var(--color-danger)]/30 ring-2 ring-[color:var(--color-danger)] text-white'
              : 'bg-white/10 hover:bg-white/20 text-white')
          }
          aria-label={t('jobs.thumbsDown')}
        >
          <span class="text-lg">👎</span>
          <span class="font-mono text-xs">{t('jobs.thumbsDown')}</span>
        </button>
      </div>
    </div>
  );
}

function imageUrl(documentId: string, filename: string): string {
  return `/api/v1/documents/${encodeURIComponent(documentId)}/images/${encodeURIComponent(
    filename.replace(/^\//, ''),
  )}`;
}

function formatEta(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min - hr * 60;
  return `${hr}h ${remMin}m`;
}

function computeElapsed(snap: { startedAt: string | null; finishedAt: string | null } | null): string {
  if (!snap?.startedAt || !snap.finishedAt) return '—';
  const ms = Date.parse(snap.finishedAt) - Date.parse(snap.startedAt);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return formatEta(ms) ?? '—';
}

function formatCents(c: number | null | undefined): string {
  if (c == null) return '—';
  if (c === 0) return '$0.00';
  return `$${(c / 100).toFixed(2)}`;
}
