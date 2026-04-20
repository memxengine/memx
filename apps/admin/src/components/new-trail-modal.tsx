import { useMemo, useState } from 'preact/hooks';
import { slugify } from '@trail/shared';
import { Modal, ModalButton } from './modal';
import { createKnowledgeBase, ApiError } from '../api';
import { t, getLocale } from '../lib/i18n';

/**
 * "+ Ny Trail" quick-create modal surfaced from the Trails list.
 * Mirrors the S2Kb form in apps/onboarding: name → live slug preview →
 * description → language picker → submit → navigate. Backend route is
 * POST /api/v1/knowledge-bases which auto-picks a unique slug and
 * seeds the three hub Neurons (overview/log/glossary per F102).
 *
 * Slug preview is informational only — we don't send it up. The server
 * owns collision handling; showing the proposed slug just lets the
 * curator see what URL their Trail will live at before committing.
 */
export function NewTrailModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (kb: { id: string; slug: string; name: string }) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Default language follows the admin's active locale — a Danish
  // curator almost always starts a Danish KB. Radio still lets them
  // flip per-Trail without touching the global admin language.
  const [language, setLanguage] = useState<'da' | 'en'>(
    getLocale() === 'en' ? 'en' : 'da',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugPreview = useMemo(() => slugify(name), [name]);
  const canSubmit = name.trim().length > 0 && !busy;

  function reset() {
    setName('');
    setDescription('');
    setLanguage(getLocale() === 'en' ? 'en' : 'da');
    setError(null);
    setBusy(false);
  }

  function handleClose() {
    if (busy) return;
    reset();
    onClose();
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setBusy(true);
    setError(null);
    try {
      const kb = await createKnowledgeBase({
        name: trimmedName,
        description: description.trim() || null,
        language,
      });
      onCreated({ id: kb.id, slug: kb.slug, name: kb.name });
      reset();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : t('common.error'),
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t('kbs.newTrail.title')}
      onClose={handleClose}
      maxWidth="md"
      footer={
        <>
          <ModalButton onClick={handleClose} disabled={busy}>
            {t('common.cancel')}
          </ModalButton>
          <ModalButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? t('kbs.newTrail.creating') : t('kbs.newTrail.submit')}
          </ModalButton>
        </>
      }
    >
      <div class="space-y-4">
        <label class="block">
          <span class="block text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
            {t('kbs.newTrail.nameLabel')}
            <span class="text-[color:var(--color-danger)]"> *</span>
          </span>
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            placeholder={t('kbs.newTrail.namePlaceholder')}
            maxLength={100}
            class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)] transition"
          />
          {slugPreview ? (
            <div class="mt-1.5 text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
              {t('kbs.newTrail.slugPreview')}{' '}
              <span class="text-[color:var(--color-fg-muted)]">admin.trailmem.com/kb/</span>
              <span class="text-[color:var(--color-accent)]">{slugPreview}</span>
              <span class="ml-2 opacity-70">{t('kbs.newTrail.slugHint')}</span>
            </div>
          ) : null}
        </label>

        <label class="block">
          <span class="block text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
            {t('kbs.newTrail.descriptionLabel')}
            <span class="normal-case opacity-70"> · {t('common.optional')}</span>
          </span>
          <textarea
            value={description}
            onInput={(e) => setDescription((e.currentTarget as HTMLTextAreaElement).value)}
            placeholder={t('kbs.newTrail.descriptionPlaceholder')}
            maxLength={500}
            rows={3}
            class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)] transition resize-none"
          />
        </label>

        <div>
          <label class="block mb-2">
            <span class="text-sm font-medium">{t('settings.trail.languageLabel')}</span>
          </label>
          <div
            class="inline-flex items-center rounded-md border border-[color:var(--color-border)] overflow-hidden"
            role="group"
          >
            {(['da', 'en'] as const).map((code) => {
              const active = language === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLanguage(code)}
                  class={
                    'px-3 py-1.5 text-xs font-mono uppercase tracking-wide transition ' +
                    (active
                      ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                      : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-card)]')
                  }
                  aria-pressed={active}
                >
                  {code}
                </button>
              );
            })}
          </div>
          <p class="mt-1.5 text-[11px] text-[color:var(--color-fg-subtle)] max-w-md">
            {t('settings.trail.languageHint')}
          </p>
        </div>

        {error ? (
          <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md px-3 py-2 text-sm text-[color:var(--color-danger)]">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
