import { useState, useRef } from 'preact/hooks';
import { t } from '../lib/i18n';
import { parseTags, serializeTags, canonicaliseTag } from '@trail/shared';

/**
 * F91 + F92 — tag chips.
 *
 * The canonical parse/serialize/canonicalise helpers live in
 * `@trail/shared` so the server-side write paths (submitCuratorEdit,
 * approveUpdate, create-candidate) use the exact same rules as the
 * editor. Re-exported here so existing admin call-sites that import
 * from './tag-chips' don't break.
 */
export { parseTags, serializeTags, canonicaliseTag };

interface ReadonlyProps {
  tags: string[];
  mode?: 'readonly';
}

interface EditableProps {
  tags: string[];
  mode: 'editable';
  onChange: (next: string[]) => void;
}

type Props = ReadonlyProps | EditableProps;

export function TagChips(props: Props) {
  const readonly = props.mode !== 'editable';
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commitDraft = () => {
    if (readonly) return;
    const next = draft.trim();
    if (!next) {
      setDraft('');
      return;
    }
    const already = props.tags.some((x) => x.toLowerCase() === next.toLowerCase());
    if (!already) {
      (props as EditableProps).onChange([...props.tags, next]);
    }
    setDraft('');
  };

  const removeAt = (i: number) => {
    if (readonly) return;
    const next = props.tags.slice();
    next.splice(i, 1);
    (props as EditableProps).onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (readonly) return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (
      e.key === 'Backspace' &&
      draft === '' &&
      props.tags.length > 0
    ) {
      // Empty input + backspace removes the last chip — matches the
      // convention in Gmail/Linear/most chip inputs so a mistaken tag
      // can be walked back without reaching for the mouse.
      e.preventDefault();
      removeAt(props.tags.length - 1);
    }
  };

  return (
    <div
      class={
        'flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md border text-sm ' +
        (readonly
          ? 'border-[color:var(--color-border)] bg-transparent'
          : 'border-[color:var(--color-border)] bg-transparent focus-within:border-[color:var(--color-accent)]')
      }
      onClick={() => !readonly && inputRef.current?.focus()}
    >
      {props.tags.length === 0 && readonly ? (
        <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">—</span>
      ) : null}

      {props.tags.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-[color:var(--color-accent)]/15 text-[color:var(--color-accent)] border border-[color:var(--color-accent)]/30"
        >
          {tag}
          {!readonly ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
              aria-label={t('tagChips.remove', { tag })}
              class="ml-0.5 -mr-0.5 rounded-full hover:bg-[color:var(--color-accent)]/25 w-4 h-4 flex items-center justify-center leading-none"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}

      {!readonly ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
          onBlur={commitDraft}
          placeholder={
            props.tags.length === 0
              ? t('tagChips.placeholder')
              : t('tagChips.placeholderMore')
          }
          class="flex-1 min-w-[120px] bg-transparent outline-none text-sm py-0.5"
        />
      ) : null}
    </div>
  );
}
