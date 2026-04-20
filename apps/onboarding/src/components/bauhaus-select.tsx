// Bauhaus-style dropdown — sharp corners, 1px strokes, amber accent on
// selection, box-shadow "lift" on hover/focus. Same visual language as the
// landing nav and the admin theme-toggle. Designed to replace the native
// <select> wherever we need branded option-pickers.
//
// DOM contract (so landing's static build.ts can match by hand if we ever
// want the same widget in a vanilla context):
//
//   <div class="bauhaus-select" data-open="false">
//     <button class="bauhaus-select__trigger" aria-haspopup="listbox" aria-expanded="false">
//       <span class="bauhaus-select__value">…label…</span>
//       <svg class="bauhaus-select__chevron">…</svg>
//     </button>
//     <ul class="bauhaus-select__menu" role="listbox">
//       <li class="bauhaus-select__option" role="option" aria-selected="true">
//         <span class="bauhaus-select__check">✓</span>
//         <span class="bauhaus-select__label">…</span>
//       </li>
//       …
//     </ul>
//   </div>

import { useEffect, useRef, useState } from 'preact/hooks';

export interface BauhausSelectOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: BauhausSelectOption<T>[];
  onChange: (value: T) => void;
  /** Optional: wiring for form submission or querying by name. */
  name?: string;
  /** Optional extra class on the root. */
  class?: string;
  ariaLabel?: string;
}

export function BauhausSelect<T extends string>({
  value,
  options,
  onChange,
  name,
  class: klass,
  ariaLabel,
}: Props<T>): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  // Index of the keyboard-focused option while open. Mouse hover updates this
  // too so the highlight and the keyboard cursor stay in sync.
  const [activeIdx, setActiveIdx] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const current = options.find((o) => o.value === value) ?? options[0];

  // Close on click outside. pointerdown catches both mouse and touch before
  // the focus-dance that `click` triggers, so we don't get the briefly-open-
  // then-immediately-closed flicker when the user clicks another dropdown.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // Sync activeIdx with the current value whenever the menu opens — arrow
  // keys should start from the selected row, not wherever the cursor was
  // last time the menu was open.
  useEffect(() => {
    if (open) {
      const i = options.findIndex((o) => o.value === value);
      setActiveIdx(i >= 0 ? i : 0);
    }
  }, [open]);

  const commit = (next: T) => {
    onChange(next);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(options.length - 1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) commit(opt.value);
      return;
    }
    // Type-ahead: jump to the next option whose label starts with the typed
    // letter. Cheap and predictable — no debounced multi-char prefix buffer.
    if (e.key.length === 1) {
      const ch = e.key.toLowerCase();
      const start = (activeIdx + 1) % options.length;
      for (let k = 0; k < options.length; k++) {
        const idx = (start + k) % options.length;
        const opt = options[idx];
        if (opt && opt.label.toLowerCase().startsWith(ch)) {
          setActiveIdx(idx);
          break;
        }
      }
    }
  };

  return (
    <div
      class={`bauhaus-select${klass ? ' ' + klass : ''}`}
      data-open={open ? 'true' : 'false'}
      ref={rootRef}
    >
      {/* Hidden input so <form>-submit consumers pick up the value without
          re-implementing name→value wiring. Cheap for the 95% case, invisible
          for the rest. */}
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        type="button"
        class="bauhaus-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span class="bauhaus-select__value">{current?.label ?? ''}</span>
        <svg
          class="bauhaus-select__chevron"
          width="10"
          height="6"
          viewBox="0 0 10 6"
          aria-hidden="true"
        >
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul class="bauhaus-select__menu" role="listbox" ref={menuRef}>
          {options.map((o, i) => {
            const selected = o.value === value;
            const active = i === activeIdx;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={selected}
                data-active={active ? 'true' : 'false'}
                class="bauhaus-select__option"
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(o.value)}
              >
                <span class="bauhaus-select__check" aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
                <span class="bauhaus-select__label">{o.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
