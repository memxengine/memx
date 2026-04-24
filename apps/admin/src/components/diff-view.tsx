import { useEffect, useState } from 'preact/hooks';
import { computeLineDiff, type DiffLine } from '@trail/shared';
import { getDocumentContent, ApiError } from '../api';
import { t } from '../lib/i18n';

/**
 * F20 — side-by-side line diff for a queue candidate that will modify
 * an existing Neuron. "Before" = the Neuron's current `documents.content`
 * (fetched lazily via `/api/v1/documents/:id/content`). "After" = the
 * candidate's proposed `content` passed by the parent.
 *
 * Layout: two-column grid. Removed lines glow red on the before side;
 * added lines glow green on the after side; GAP rows are rendered as
 * muted empty cells so the two sides stay vertically aligned per the
 * LCS match — the curator can read across and see exactly what's new
 * at that position.
 *
 * Lazy-loads on first mount — candidates that never get expanded never
 * pay the fetch cost. Caches the before-doc per component instance so
 * re-mounting the same candidate (collapse→expand cycle) doesn't
 * re-hit the endpoint.
 */
export function DiffView({
  targetDocumentId,
  proposedContent,
}: {
  targetDocumentId: string;
  proposedContent: string;
}) {
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDocumentContent(targetDocumentId)
      .then((res) => {
        if (cancelled) return;
        setBefore(res.content ?? '');
        setLoading(false);
      })
      .catch((err: ApiError) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetDocumentId]);

  if (loading) {
    return (
      <div class="text-xs text-[color:var(--color-fg-muted)] py-4">{t('diff.loading')}</div>
    );
  }
  if (error) {
    return (
      <div class="text-xs text-[color:var(--color-danger)] py-4">
        {t('diff.loadError', { error })}
      </div>
    );
  }
  if (before === null) return null;

  const diff = computeLineDiff(before, proposedContent);

  if (diff.stats.added === 0 && diff.stats.removed === 0) {
    return (
      <div class="text-xs italic text-[color:var(--color-fg-muted)] py-4">
        {t('diff.identical')}
      </div>
    );
  }

  return (
    <div class="space-y-2">
      <div class="flex items-center gap-3 text-[11px] font-mono">
        <span class="text-[color:var(--color-success)]">+{diff.stats.added} {t('diff.added')}</span>
        <span class="text-[color:var(--color-danger)]">−{diff.stats.removed} {t('diff.removed')}</span>
        <span class="text-[color:var(--color-fg-subtle)]">
          {diff.stats.unchanged} {t('diff.unchanged')}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-px border border-[color:var(--color-border)] rounded-md overflow-hidden bg-[color:var(--color-border)]">
        <div class="bg-[color:var(--color-bg)]">
          <div class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] px-3 py-1.5 border-b border-[color:var(--color-border)] sticky top-0 bg-[color:var(--color-bg)]">
            {t('diff.before')}
          </div>
          <DiffColumn lines={diff.before} side="before" />
        </div>
        <div class="bg-[color:var(--color-bg)]">
          <div class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] px-3 py-1.5 border-b border-[color:var(--color-border)] sticky top-0 bg-[color:var(--color-bg)]">
            {t('diff.after')}
          </div>
          <DiffColumn lines={diff.after} side="after" />
        </div>
      </div>
    </div>
  );
}

function DiffColumn({ lines, side }: { lines: DiffLine[]; side: 'before' | 'after' }) {
  return (
    <div class="max-h-96 overflow-auto">
      {lines.map((line, idx) => (
        <DiffRow key={idx} line={line} side={side} />
      ))}
    </div>
  );
}

function DiffRow({ line, side }: { line: DiffLine; side: 'before' | 'after' }) {
  const isGap = line.kind === 'unchanged' && line.text === '' && line.lineNumber === 0;
  const isRemoved = line.kind === 'removed' && side === 'before';
  const isAdded = line.kind === 'added' && side === 'after';

  // Each row maps to a diff slot; use the same row-height as its
  // opposite column so both sides line up. Font-mono + leading-relaxed
  // for easy line-to-line scanning.
  const bg = isRemoved
    ? 'bg-[color:var(--color-danger)]/10'
    : isAdded
      ? 'bg-[color:var(--color-success)]/10'
      : isGap
        ? 'bg-[color:var(--color-bg-subtle)]'
        : '';
  const textColor = isRemoved
    ? 'text-[color:var(--color-danger)]'
    : isAdded
      ? 'text-[color:var(--color-success)]'
      : 'text-[color:var(--color-fg)]';
  const prefix = isRemoved ? '−' : isAdded ? '+' : isGap ? '' : ' ';

  return (
    <div class={`flex ${bg}`}>
      <span class="flex-shrink-0 w-10 px-1 py-0.5 text-right text-[10px] font-mono text-[color:var(--color-fg-subtle)] border-r border-[color:var(--color-border)]/50 select-none">
        {isGap ? '' : line.lineNumber}
      </span>
      <span class={`flex-shrink-0 w-4 px-1 py-0.5 text-center text-[11px] font-mono ${textColor} select-none`}>
        {prefix}
      </span>
      <pre class={`flex-1 min-w-0 px-2 py-0.5 text-[12px] font-mono leading-snug whitespace-pre-wrap break-words ${textColor}`}>
        {isGap ? ' ' : line.text || ' '}
      </pre>
    </div>
  );
}
