/**
 * CopyId — tiny "copy to clipboard" button for any internal id. Used on
 * candidate cards, Neuron rows, source tiles, etc. so Christian can paste
 * an id straight into a chat with the dev agent during review without
 * hunting for it in the DB.
 *
 * Visual: monospace id + a copy glyph. Clicking writes the id to the
 * clipboard and flips to a green check for 1.2s so the user gets
 * immediate feedback. Gracefully degrades when navigator.clipboard is
 * missing (old browsers, sandboxed iframes) — the button still renders
 * but the click is a no-op.
 */
import { useState } from 'preact/hooks';
import { t, useLocale } from '../lib/i18n';

interface Props {
  id: string;
  /** Optional label override, defaults to the id itself. */
  label?: string;
  /** Keep the class list tiny and inline so parents can position it. */
  class?: string;
}

export function CopyId({ id, label, class: extraClass }: Props) {
  useLocale();
  const [copied, setCopied] = useState(false);

  const onClick = async (): Promise<void> => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Permission denied or other clipboard API failure — silent; the
      // user can always drag-select the monospace id text instead.
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? t('common.copied') : t('common.copyId')}
      aria-label={copied ? t('common.copied') : t('common.copyId')}
      class={
        'inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition ' +
        (copied
          ? 'border-[color:var(--color-success)]/40 text-[color:var(--color-success)]'
          : 'border-[color:var(--color-border)] text-[color:var(--color-fg-subtle)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg-muted)]') +
        (extraClass ? ' ' + extraClass : '')
      }
    >
      <span class="truncate max-w-[200px]">{label ?? id}</span>
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

function CopyGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 11V4a1 1 0 0 1 1-1h7" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
