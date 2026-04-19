import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { searchKb, listTags, ApiError, type SearchResponse, type DocumentSearchHit, type ChunkSearchHit, type TagCount } from '../api';
import { displayPath } from '../lib/display-path';
import { parseTags } from '../components/tag-chips';
import { t } from '../lib/i18n';

/**
 * FTS5 search across the current Trail. Reads/writes the `q=` query param so
 * results are bookmarkable and survive reload. Fires against the engine's
 * `/knowledge-bases/:id/search` endpoint — same one an embed widget or a
 * CMS adapter would use. Admin is just a first-class reference consumer.
 */
export function SearchPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';

  const initialQ = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('q') ?? ''
    : '';
  const initialTags = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).getAll('tag')
    : [];
  const [input, setInput] = useState(initialQ);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(
    () => new Set(initialTags.map((t) => t.toLowerCase())),
  );
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!kbId) return;
    listTags(kbId).then(setAllTags).catch(() => setAllTags([]));
  }, [kbId]);

  // Debounce: wait 200ms after the user stops typing before firing. Also
  // bump a sequence counter so an older in-flight response can't overwrite
  // a newer one (FTS is fast, but rank-heavy queries can reorder).
  useEffect(() => {
    const q = input.trim();
    const tags = Array.from(selectedTags);
    if (!q) {
      setResults(null);
      setError(null);
      setLoading(false);
      syncUrl('', tags);
      return;
    }
    const seq = ++reqSeq.current;
    const handle = setTimeout(async () => {
      setLoading(true);
      syncUrl(q, tags);
      try {
        const res = await searchKb(kbId, q, { limit: 20, tags });
        if (seq !== reqSeq.current) return;
        setResults(res);
        setError(null);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [input, kbId, selectedTags]);

  const toggleTag = useCallback((tag: string) => {
    const key = tag.toLowerCase();
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onClear = useCallback(() => setInput(''), []);

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Search</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          Full-text search across Neurons and Sources in this Trail.
        </p>
      </header>

      <div class="relative mb-6">
        <input
          type="search"
          autoFocus
          placeholder="Search Neurons and Sources…"
          value={input}
          onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
          class="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/80 px-4 py-3 pr-10 text-base focus:outline-none focus:border-[color:var(--color-accent)] transition"
        />
        {input ? (
          <button
            onClick={onClear}
            class="absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition text-sm"
            aria-label="Clear search"
          >
            ✕
          </button>
        ) : null}
      </div>

      {allTags.length > 0 ? (
        <TagFilterBar
          tags={allTags}
          selected={selectedTags}
          onToggle={toggleTag}
          onClear={() => setSelectedTags(new Set())}
        />
      ) : null}

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm mb-4">
          {error}
        </div>
      ) : null}

      {!input.trim() ? (
        <EmptyHint />
      ) : loading && !results ? (
        <div class="loading-delayed text-[color:var(--color-fg-muted)] text-sm">Searching…</div>
      ) : results ? (
        <Results kbId={kbId} results={results} query={input.trim()} />
      ) : null}
    </div>
  );
}

/**
 * F92 — collapsible tag filter row. Shares the interaction model with
 * the Queue's "Source:" connector filter: compact label toggle, chips
 * hidden until expanded, active-count pill next to the label, a Clear
 * link when any tag is selected. Keeps the page calm when the user
 * isn't tagging — flipping one open, exploring, flipping it away is a
 * familiar motion.
 */
function TagFilterBar({
  tags,
  selected,
  onToggle,
  onClear,
}: {
  tags: TagCount[];
  selected: Set<string>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const showChips = open || selected.size > 0;

  return (
    <div class="mb-4">
      <div class="flex items-center gap-2 mb-2">
        <button
          onClick={() => setOpen((v) => !v)}
          class="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition cursor-pointer"
          aria-expanded={showChips}
        >
          <span>{showChips ? '▼' : '▶'}</span>
          <span>{t('tagFilter.label')}</span>
          {selected.size > 0 ? (
            <span class="normal-case text-[color:var(--color-accent)]">· {selected.size}</span>
          ) : null}
        </button>
        {selected.size > 0 ? (
          <button
            onClick={onClear}
            class="text-[10px] font-mono text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
          >
            {t('tagFilter.clear')}
          </button>
        ) : null}
      </div>
      {showChips ? (
        <div class="flex flex-wrap gap-2">
          {tags.map(({ tag, count }) => (
            <TagChip
              key={tag}
              tag={tag}
              count={count}
              active={selected.has(tag.toLowerCase())}
              onClick={() => onToggle(tag)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TagChip({
  tag,
  count,
  active,
  onClick,
}: {
  tag: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={
        'inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded-md border transition ' +
        (active
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-fg)]'
          : 'border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:border-[color:var(--color-border-strong)]')
      }
    >
      <span>{tag}</span>
      {typeof count === 'number' ? (
        <span class="opacity-60">· {count}</span>
      ) : null}
    </button>
  );
}

function Results({
  kbId,
  results,
  query,
}: {
  kbId: string;
  results: SearchResponse;
  query: string;
}) {
  const total = results.documents.length + results.chunks.length;
  if (total === 0) {
    return (
      <div class="text-center py-16 text-[color:var(--color-fg-subtle)]">
        No matches for <code class="font-mono">{query}</code> in this Trail.
      </div>
    );
  }

  const neurons = results.documents.filter((d) => d.kind === 'wiki');
  const sources = results.documents.filter((d) => d.kind === 'source');

  return (
    <div class="space-y-8">
      {neurons.length ? (
        <section>
          <SectionHeader label="Neurons" count={neurons.length} />
          <ul class="space-y-2">
            {neurons.map((d) => (
              <NeuronHit key={d.id} hit={d} kbId={kbId} />
            ))}
          </ul>
        </section>
      ) : null}

      {sources.length ? (
        <section>
          <SectionHeader label="Sources" count={sources.length} />
          <ul class="space-y-2">
            {sources.map((d) => (
              <SourceHit key={d.id} hit={d} />
            ))}
          </ul>
        </section>
      ) : null}

      {results.chunks.length ? (
        <section>
          <SectionHeader label="Passages" count={results.chunks.length} />
          <ul class="space-y-2">
            {results.chunks.map((c) => (
              <ChunkHit key={c.id} hit={c} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <h2 class="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-2">
      {label} <span class="text-[color:var(--color-fg-muted)]">· {count}</span>
    </h2>
  );
}

function NeuronHit({ hit, kbId }: { hit: DocumentSearchHit; kbId: string }) {
  const slug = hit.filename.replace(/\.md$/i, '');
  const hitTags = parseTags(hit.tags ?? null);
  return (
    <li class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/80 hover:border-[color:var(--color-border-strong)] transition">
      <a
        href={`/kb/${kbId}/neurons/${encodeURIComponent(slug)}`}
        class="block px-4 py-3"
      >
        <div class="flex items-baseline justify-between gap-4 mb-1">
          <div class="font-medium truncate">{hit.title ?? slug}</div>
          <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] shrink-0">
            {displayPath(hit.path)}
          </div>
        </div>
        <Snippet html={hit.highlight} />
        {hitTags.length > 0 ? (
          <div class="mt-2 flex flex-wrap gap-1.5">
            {hitTags.map((tag) => (
              <span
                key={tag}
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-[color:var(--color-accent)]/10 border border-[color:var(--color-accent)]/25 text-[color:var(--color-accent)]"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </a>
    </li>
  );
}

function SourceHit({ hit }: { hit: DocumentSearchHit }) {
  return (
    <li class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/80">
      <div class="px-4 py-3">
        <div class="flex items-baseline justify-between gap-4 mb-1">
          <div class="font-medium truncate">{hit.title ?? hit.filename}</div>
          <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] shrink-0">
            {hit.filename}
          </div>
        </div>
        <Snippet html={hit.highlight} />
      </div>
    </li>
  );
}

function ChunkHit({ hit }: { hit: ChunkSearchHit }) {
  return (
    <li class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/60 px-4 py-3">
      {hit.headerBreadcrumb ? (
        <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] mb-1">
          {hit.headerBreadcrumb}
        </div>
      ) : null}
      <Snippet html={hit.highlight} />
    </li>
  );
}

/**
 * The FTS5 `highlight()` function wraps matches in <mark>…</mark>. We trust
 * that because it comes from our own engine against content we control; if
 * that changes (F31 user-generated content lint), sanitise here.
 */
function Snippet({ html }: { html: string }) {
  return (
    <div
      class="text-sm text-[color:var(--color-fg-muted)] leading-snug [&_mark]:bg-[color:var(--color-accent)]/30 [&_mark]:text-[color:var(--color-fg)] [&_mark]:rounded [&_mark]:px-0.5"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function EmptyHint() {
  return (
    <div class="text-center py-16 text-[color:var(--color-fg-subtle)] text-sm">
      Type to search — matches in Neuron titles + bodies, Source filenames + content, and indexed passages.
    </div>
  );
}

function syncUrl(q: string, tags: string[]): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (q) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  // Repeated ?tag= params — matches the F92 plan-doc URL shape
  // (?q=sanne&tag=incident&tag=ops) so a bookmarked URL preserves
  // both the search text AND the active facet selection.
  url.searchParams.delete('tag');
  for (const tag of tags) {
    url.searchParams.append('tag', tag);
  }
  window.history.replaceState({}, '', url);
}
