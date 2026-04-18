import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useRoute, useLocation } from 'preact-iso';
import { marked } from 'marked';
import type { Document } from '@trail/shared';
import {
  listWikiPages,
  getDocumentContent,
  saveNeuronEdit,
  NeuronEditConflictError,
  ApiError,
} from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { displayPath } from '../lib/display-path';
import { t } from '../lib/i18n';
import { TagChips, parseTags, serializeTags } from '../components/tag-chips';
import { Modal, ModalButton } from '../components/modal';

/**
 * F91 — Neuron editor. Split-view markdown editor for Neurons, lifted
 * into edit mode on `?edit=1` from the reader route. The component owns
 * three concerns: load (GET doc + content), edit (raw markdown textarea
 * + live preview), save (PUT through the queue, handle 409 conflicts,
 * guard dirty state against navigation).
 *
 * See docs/features/F91-neuron-editor.md for the rationale on why the
 * save path can't use F19 auto-approval and instead runs a
 * create+resolve in one tx via `submitCuratorEdit` in core.
 */
export function NeuronEditorPanel() {
  const route = useRoute();
  const location = useLocation();
  const kbId = route.params.kbId ?? '';
  const slug = decodeURIComponent(route.params.slug ?? '');

  const [pages, setPages] = useState<Document[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [originalTitle, setOriginalTitle] = useState<string>('');
  const [originalTags, setOriginalTags] = useState<string[]>([]);
  const [content, setContent] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [tags, setTags] = useState<string[]>([]);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: number; expected: number } | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  // Discard-confirmation modal — replaces native confirm() so the dialog
  // matches the rest of the admin's visual language.
  const [discardOpen, setDiscardOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!kbId) return;
    listWikiPages(kbId)
      .then(setPages)
      .catch((err: ApiError) => setLoadError(err.message));
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
      setOriginalContent(null);
      return;
    }
    getDocumentContent(doc.id)
      .then((r) => {
        const d = doc as Document & {
          title: string | null;
          version: number;
          tags?: string | null;
        };
        setOriginalContent(r.content ?? '');
        setContent(r.content ?? '');
        setOriginalTitle(d.title ?? '');
        setTitle(d.title ?? '');
        const initial = parseTags(d.tags);
        setOriginalTags(initial);
        setTags(initial);
        setLoadedVersion(r.version);
      })
      .catch((err: ApiError) => setLoadError(err.message));
  }, [doc]);

  const dirty =
    originalContent !== null &&
    (content !== originalContent ||
      title !== originalTitle ||
      serializeTags(tags) !== serializeTags(originalTags));

  // beforeunload — browser-native "you have unsaved changes" prompt.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const html = useMemo(() => {
    if (!content) return '';
    const preprocessed = rewriteWikiLinks(content, kbId);
    return marked.parse(preprocessed, { async: false }) as string;
  }, [content, kbId]);

  const exitToReader = () => {
    location.route(location.path);
  };

  const handleCancel = () => {
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    exitToReader();
  };

  const confirmDiscard = () => {
    setDiscardOpen(false);
    exitToReader();
  };

  const handleSave = async () => {
    if (!doc || loadedVersion === null || saving) return;
    setSaving(true);
    setSaveError(null);
    setConflict(null);
    try {
      const serialized = serializeTags(tags);
      const result = await saveNeuronEdit(doc.id, {
        content,
        title: title.trim() || undefined,
        tags: serialized === '' ? null : serialized,
        expectedVersion: loadedVersion,
      });
      setOriginalContent(content);
      setOriginalTitle(title);
      setOriginalTags(tags);
      setLoadedVersion(result.version);
      setSavedToast(t('neuronEditor.savedToast'));
      setTimeout(() => setSavedToast(null), 2500);
    } catch (err) {
      if (err instanceof NeuronEditConflictError) {
        setConflict({ current: err.currentVersion, expected: err.expectedVersion });
      } else {
        setSaveError(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReloadConflict = async () => {
    if (!doc) return;
    setConflict(null);
    setSaveError(null);
    const r = await getDocumentContent(doc.id).catch((err: ApiError) => {
      setLoadError(err.message);
      return null;
    });
    if (!r) return;
    setOriginalContent(r.content ?? '');
    setContent(r.content ?? '');
    setLoadedVersion(r.version);
  };

  // ⌘+S / Ctrl+S saves. Esc exits edit mode (with discard confirm if dirty).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const d = doc as (Document & { filename: string; version: number; path?: string }) | null;

  if (loadError) {
    return (
      <div class="page-shell">
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {loadError}
        </div>
      </div>
    );
  }

  if (!d || originalContent === null) {
    return (
      <div class="page-shell">
        <div class="loading-delayed text-[color:var(--color-fg-muted)] text-sm">
          {t('common.loading')}
        </div>
      </div>
    );
  }

  return (
    <div class="page-shell">
      <header class="mb-4 flex items-baseline justify-between gap-4">
        <div class="font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
          {displayPath(d.path ?? '')} · v{loadedVersion ?? d.version}
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            class="px-3 py-1.5 rounded-md border border-[color:var(--color-border)] text-sm hover:bg-[color:var(--color-bg-card)] transition disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
            class="px-3 py-1.5 rounded-md bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] text-sm transition disabled:opacity-50"
          >
            {saving ? t('neuronEditor.saving') : t('common.save')}
          </button>
        </div>
      </header>

      <div class="mb-4 grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-3">
        <input
          type="text"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          placeholder={t('neuronEditor.titlePlaceholder')}
          class="px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-transparent text-lg font-semibold"
        />
        <TagChips mode="editable" tags={tags} onChange={setTags} />
      </div>

      {conflict ? (
        <div class="mb-4 border border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/5 rounded-md p-3 text-sm flex items-center justify-between gap-3">
          <span>
            {t('neuronEditor.conflictBanner', {
              current: conflict.current,
              expected: conflict.expected,
            })}
          </span>
          <button
            type="button"
            onClick={() => void handleReloadConflict()}
            class="px-3 py-1 rounded-md border border-[color:var(--color-border-strong)] text-xs hover:bg-[color:var(--color-bg-card)] transition"
          >
            {t('neuronEditor.reload')}
          </button>
        </div>
      ) : null}

      {saveError ? (
        <div class="mb-4 border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-3 text-sm">
          {saveError}
        </div>
      ) : null}

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <textarea
          ref={textareaRef}
          value={content}
          onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
          spellcheck={false}
          class="w-full min-h-[60vh] font-mono text-[13px] leading-relaxed p-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] resize-y"
        />
        <article
          class="prose-body text-[15px] leading-relaxed p-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] overflow-auto min-h-[60vh]"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      <footer class="mt-4 text-xs font-mono text-[color:var(--color-fg-subtle)]">
        {t('neuronEditor.footerHint')}
      </footer>

      {savedToast ? (
        <div class="fixed bottom-6 right-6 z-40 px-4 py-3 rounded-md border border-[color:var(--color-success)]/30 bg-[color:var(--color-success)]/10 text-[color:var(--color-fg)] text-sm shadow-lg">
          {savedToast}
        </div>
      ) : null}

      <Modal
        open={discardOpen}
        title={t('neuronEditor.discardTitle')}
        onClose={() => setDiscardOpen(false)}
        footer={
          <>
            <ModalButton onClick={() => setDiscardOpen(false)}>
              {t('common.cancel')}
            </ModalButton>
            <ModalButton variant="danger" onClick={confirmDiscard}>
              {t('neuronEditor.discardConfirm')}
            </ModalButton>
          </>
        }
      >
        <p class="text-sm text-[color:var(--color-fg-muted)] leading-relaxed">
          {t('neuronEditor.discardBody')}
        </p>
      </Modal>
    </div>
  );
}
