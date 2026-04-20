import { useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import type { Document } from '@trail/shared';
import { slugify } from '@trail/shared';
import {
  listWikiPages,
  getDocumentContent,
  getNeuronProvenance,
  ApiError,
  type NeuronProvenance,
} from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { t } from '../lib/i18n';
import { NeuronEditorPanel } from './neuron-editor';
import { TagChips, parseTags } from '../components/tag-chips';
import { CenteredLoader } from '../components/centered-loader';
import { ConnectorBadge } from '../components/connector-badge';
import { ConfidencePill } from '../components/confidence-pill';

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
  const [provenance, setProvenance] = useState<NeuronProvenance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!kbId) return;
    listWikiPages(kbId)
      .then(setPages)
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);

  const doc = useMemo(() => {
    if (!pages) return null;
    // Match the requested slug against every Neuron's canonical slug
    // form (slugify of filename-sans-.md). Robust against old links
    // in the wild that carry raw display casing or spaces — a link
    // written as `/neurons/FMC` or `/neurons/ARC Farm Intelligence`
    // still lands on `fmc.md` / `arc-farm-intelligence.md`. Falls
    // back to exact filename match for extra-safe round-tripping.
    const wanted = slugify(slug);
    return (
      pages.find((p) => {
        const d = p as Document & { filename: string };
        const fileSlug = slugify(d.filename.replace(/\.md$/i, ''));
        return fileSlug === wanted || d.filename.replace(/\.md$/i, '') === slug;
      }) ?? null
    );
  }, [pages, slug]);

  useEffect(() => {
    if (!doc) {
      setContent(null);
      setProvenance(null);
      return;
    }
    getDocumentContent(doc.id)
      .then((r) => setContent(r.content ?? ''))
      .catch((err: ApiError) => setError(err.message));
    // Provenance lookup is independent of content — fire in parallel.
    // Silent on failure; the panel just doesn't render the "Created via"
    // line if the lookup 404s or throws.
    getNeuronProvenance(doc.id).then(setProvenance).catch(() => setProvenance(null));
  }, [doc]);

  const html = useMemo(() => {
    if (content === null) return '';
    const preprocessed = rewriteWikiLinks(content, kbId);
    return marked.parse(preprocessed, { async: false }) as string;
  }, [content, kbId]);

  const d = doc as (Document & { filename: string; title: string | null; version: number; path?: string; tags?: string | null; createdAt?: string; updatedAt?: string }) | null;
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

      {!pages && !error ? <CenteredLoader /> : null}

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
              {d.updatedAt || d.createdAt ? (
                <span
                  class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]"
                  title={d.updatedAt ?? d.createdAt ?? ''}
                >
                  {formatAbsolute(d.updatedAt ?? d.createdAt ?? '')}
                </span>
              ) : null}
              {readerTags.length > 0 ? (
                <TagChips tags={readerTags} />
              ) : null}
            </div>
            {provenance?.connector ? (
              <div class="mt-3 flex items-center gap-2 text-[11px] font-mono text-[color:var(--color-fg-subtle)] flex-wrap">
                <span>{t('queue.createdVia')}</span>
                <ConnectorBadge variant="tag" connector={provenance.connector} />
                <ConfidencePill confidence={provenance.confidence} />
              </div>
            ) : null}
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

/**
 * Absolute timestamp for the Neuron reader header — short, readable,
 * no guessing what "3d" means. SQLite stamps are UTC without a
 * timezone marker; we treat them as UTC and let the browser localise.
 */
function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch {
    return iso;
  }
}
