import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/**
 * Ref-stash for the onClose handler so the effect below can capture
 * its identity without subscribing to it. Without this the effect
 * re-runs on every parent render that passes a fresh inline
 * onClose={() => ...} lambda — and a re-run re-fires the auto-focus
 * setTimeout, which yanks the cursor back to the first input mid-
 * keystroke. Symptom: "typing in Description jumps to Name, pasted
 * text gets interleaved". Root cause fixed here so every consumer
 * of Modal gets predictable focus behaviour even with inline handlers.
 */

/**
 * Minimal Bauhaus-aligned modal — backdrop blur + warm card + amber accents
 * to match the landing. Keyboard: ESC closes, first focusable element auto-
 * focuses on open. Click outside = cancel. Intentionally thin: consumers
 * compose their own body + footer so we don't grow a "props-for-everything"
 * anti-API.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  maxWidth = 'sm',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  maxWidth?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  // Keep the ref in sync without listing onClose as an effect dep —
  // see block comment above the file for why.
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    // Auto-focus the first focusable element inside the panel (typically the
    // textarea/input). We wait a tick so the DOM is ready.
    const handle = setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'textarea, input, button, [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    }, 0);
    // Prevent body scroll while open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(handle);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  const widthClass = maxWidth === 'lg' ? 'max-w-2xl' : maxWidth === 'md' ? 'max-w-lg' : 'max-w-md';

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="absolute inset-0 bg-[color:var(--color-bg)]/70 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        class={
          'relative w-full ' +
          widthClass +
          ' rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-card)] shadow-2xl ' +
          'before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] before:bg-[color:var(--color-accent)] before:rounded-t-md'
        }
      >
        <header class="px-5 pt-5 pb-3">
          <h2 class="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
            trail · admin
          </h2>
          <div class="text-lg font-semibold tracking-tight">{title}</div>
        </header>
        <div class="px-5 pb-4">{children}</div>
        {footer ? (
          <footer class="flex items-center justify-end gap-2 px-5 py-3 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)]/40 rounded-b-md">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** Pre-styled action buttons matching the rest of the admin surface. */
export function ModalButton({
  variant = 'secondary',
  onClick,
  disabled,
  children,
}: {
  variant?: 'primary' | 'secondary' | 'danger';
  onClick?: () => void;
  disabled?: boolean;
  children: ComponentChildren;
}) {
  const tone =
    variant === 'primary'
      ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-fg)]/90'
      : variant === 'danger'
      ? 'bg-[color:var(--color-danger)] text-white hover:bg-[color:var(--color-danger)]/90'
      : 'border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      class={
        'px-4 py-1.5 text-sm rounded-md font-medium transition active:scale-[0.98] disabled:opacity-50 ' +
        tone
      }
    >
      {children}
    </button>
  );
}
