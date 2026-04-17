import { useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { Document } from '@trail/shared';
import { listWikiPages, getDocumentContent, ApiError } from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { t } from '../lib/i18n';
import { NeuronEditorPanel } from './neuron-editor';
import { TagChips, parseTags } from '../components/tag-chips';

/**
 * Single-Neuron panel. Routes between the read-only reader and the F91
 * edit-mode view based on the `?edit=1` query flag. Sub-components own
 * their own hooks so the hook-order rule holds across mode flips.
 */
export function WikiReaderPanel() {
  const route = useRoute();
  return route.query.edit === '1' ? <NeuronEditorPanel /> : <ReaderView />;
}

function ReaderView() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const slug = decodeURIComponent(route.params.slug ?? '');
  const [pages, setPages] = useState<Document[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!kbId) return;
    listWikiPages(kbId)
      .then(setPages)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);

  const doc = useMemo(() => {
    if (!pages) return null;
    return (
      pages.find((p) => {
        const d = p as Document & { filename: string };
        return d.filename.replace(/\.md$/i, '') === slug;
      }) ?? null
    );
  }, [pages, slug]);

  useEffect(() => {
    if (!doc) {
      setContent(null);
      return;
    }
    getDocumentContent(doc.id)
      .then((r) => setContent(r.content ?? ''))
      .catch((err: ApiError) => setError(err.message));
  }, [doc]);

  const html = useMemo(() => {
    if (content === null) return '';
    const preprocessed = rewriteWikiLinks(content, kbId);
    return marked.parse(preprocessed, { async: false }) as string;
  }, [content, kbId]);

  const d = doc as (Document & { filename: string; title: string | null; version: number; path?: string; tags?: string | null }) | null;
  const editHref = d ? `/kb/${kbId}/neurons/${encodeURIComponent(slug)}?edit=1` : null;
  const readerTags = d ? parseTags(d.tags) : [];

  return (
    <div class="page-shell">
      <header class="mb-4 flex items-center justify-between gap-4">
        <a
          href={`/kb/${kbId}/neurons`}
          class="text-sm text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
        >
          ← Neurons
        </a>
        {editHref ? (
          <a
            href={editHref}
            class="px-3 py-1.5 rounded-md border border-[color:var(--color-border)] text-sm hover:bg-[color:var(--color-bg-card)] transition"
          >
            {t('neuronEditor.editButton')}
          </a>
        ) : null}
      </header>

      {error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {error}
        </div>
      ) : null}

      {pages && !d ? (
        <div class="text-center py-16">
          <h1 class="text-2xl font-semibold mb-2">Neuron not found</h1>
          <p class="text-[color:var(--color-fg-muted)] text-sm mb-6">
            No Neuron matches slug <code class="font-mono">{slug}</code> in this Trail.
          </p>
          <a
            href={`/kb/${kbId}/neurons`}
            class="inline-block px-4 py-2 rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-card)] transition text-sm"
          >
            Back to Neurons
          </a>
        </div>
      ) : null}

      {d ? (
        <article>
          <div class="mb-6">
            <div class="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
              {displayPath(d.path ?? '')}
            </div>
            <h1 class="text-3xl font-semibold tracking-tight mb-2">
              {d.title ?? d.filename}
            </h1>
            <div class="flex items-center gap-3 flex-wrap">
              <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
                v{d.version}
              </span>
              {readerTags.length > 0 ? (
                <TagChips tags={readerTags} />
              ) : null}
            </div>
          </div>
          {content === null ? (
            <div class="loading-delayed text-[color:var(--color-fg-muted)] text-sm">
              Loading content…
            </div>
          ) : (
            <div
              class="prose-body text-[15px] leading-relaxed"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </article>
      ) : null}
    </div>
  );
}
