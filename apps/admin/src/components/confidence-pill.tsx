/**
 * ConfidencePill — graduated badge showing a 0-1 confidence score in a
 * tiered colour.
 *
 *   ≥ 0.80 → success (green)     high — auto-approvable threshold
 *   0.50 to 0.80 → accent (amber) medium — worth a look
 *   < 0.50 → danger (red)         low — likely needs attention
 *
 * Used on candidate rows in the Queue and the "Created via" panel on
 * the Neuron reader. When confidence is `null` the component renders
 * nothing — curator-authored candidates don't carry a confidence signal
 * ("I'm saving this" IS the signal).
 *
 * Thresholds match @trail/core's shouldAutoApprove config — keep these
 * in sync if the auto-approval threshold ever moves.
 */
import { t } from '../lib/i18n';

interface Props {
  confidence: number | null;
  /** Compact mode drops the "sikkerhed" label prefix. Default true. */
  compact?: boolean;
}

type Tier = 'high' | 'medium' | 'low';

function tier(c: number): Tier {
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

// Match ConnectorBadge "tag" variant's visual shape exactly — same
// opacity stops (10% bg, 30% border), same padding, same font-size —
// only the hue changes per tier. Visual language stays consistent with
// the connector pill sitting next to it.
const TIER_CLASSES: Record<Tier, string> = {
  high:
    'bg-[color:var(--color-success)]/10 border-[color:var(--color-success)]/30 text-[color:var(--color-success)]',
  medium:
    'bg-[color:var(--color-accent)]/10 border-[color:var(--color-accent)]/30 text-[color:var(--color-accent)]',
  low:
    'bg-[color:var(--color-danger)]/10 border-[color:var(--color-danger)]/30 text-[color:var(--color-danger)]',
};

function tierTitle(level: Tier): string {
  return t(`queue.confidenceTierHints.${level}`);
}

export function ConfidencePill({ confidence, compact = true }: Props) {
  if (typeof confidence !== 'number') return null;
  const clamped = Math.max(0, Math.min(1, confidence));
  const level = tier(clamped);
  const text = compact
    ? clamped.toFixed(2)
    : t('queue.conf', { n: clamped.toFixed(2) });
  return (
    <span
      title={tierTitle(level)}
      class={
        'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider border ' +
        TIER_CLASSES[level]
      }
    >
      {text}
    </span>
  );
}
