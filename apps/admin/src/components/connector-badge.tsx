/**
 * ConnectorBadge — small chip showing which ingestion pathway produced
 * a candidate or Neuron. Reads from the central shared registry, so
 * adding a new connector flows through this component without any
 * edits here.
 *
 * Two variants:
 *   - `variant="chip"` — clickable filter chip (used above the queue tabs)
 *   - `variant="tag"` — read-only tag (used on candidate rows and the
 *     Neuron reader's "Created via" panel)
 */
import type { ConnectorId } from '@trail/shared';
import { CONNECTORS, isConnectorId } from '@trail/shared';
import { t } from '../lib/i18n';

interface ChipProps {
  connector: ConnectorId;
  variant: 'chip';
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface TagProps {
  connector: string;
  variant: 'tag';
  onClick?: () => void;
}

type Props = ChipProps | TagProps;

export function ConnectorBadge(props: Props) {
  if (props.variant === 'chip') {
    return <ConnectorChip {...props} />;
  }
  return <ConnectorTag {...props} />;
}

function ConnectorChip({ connector, active, disabled, onClick }: ChipProps) {
  const def = CONNECTORS[connector];
  // Prefer localised hint from the admin locale dict; fall back to the
  // shared registry's English hint when no translation exists.
  const localised = t(`connectors.hints.${connector}`);
  const hint = localised.startsWith('connectors.hints.') ? def.hint : localised;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={hint + (disabled ? ' · ' + t('connectors.roadmapSuffix') : '')}
      class={
        'px-2 py-1 text-[11px] font-mono uppercase tracking-wider rounded-md border transition ' +
        (disabled
          ? 'border-[color:var(--color-border)]/60 text-[color:var(--color-fg-subtle)] opacity-50 cursor-not-allowed'
          : active
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-fg)]'
          : 'border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:border-[color:var(--color-border-strong)]')
      }
    >
      {def.label}
    </button>
  );
}

function ConnectorTag({ connector, onClick }: TagProps) {
  // Unknown connector ids are rendered verbatim (slightly dimmed) so
  // legacy or future-roadmap values don't break the UI.
  const def = isConnectorId(connector) ? CONNECTORS[connector] : null;
  const label = def?.label ?? connector;
  const localised = t(`connectors.hints.${connector}`);
  const hint = localised.startsWith('connectors.hints.')
    ? def?.hint ?? t('connectors.unknownConnector', { id: connector })
    : localised;
  return (
    <span
      title={hint}
      onClick={onClick}
      class={
        'inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider ' +
        (def
          ? 'bg-[color:var(--color-accent)]/10 border border-[color:var(--color-accent)]/30 text-[color:var(--color-fg-muted)]'
          : 'bg-[color:var(--color-bg-card)] border border-[color:var(--color-border)] text-[color:var(--color-fg-subtle)]') +
        (onClick ? ' cursor-pointer hover:text-[color:var(--color-fg)] hover:border-[color:var(--color-accent)]' : '')
      }
    >
      {label}
    </span>
  );
}
