import { useEffect, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import type { KnowledgeBase } from '@trail/shared';
import { listKnowledgeBases, updateKnowledgeBase, ApiError } from '../api';
import { matchKb } from '../lib/kb-cache';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';

/**
 * Per-Trail settings at `/kb/:kbId/settings`. Home for all configuration
 * that belongs to a single Trail: description, language, lint-policy.
 * Form submits on save; edits don't auto-save so a curator scrolling
 * through doesn't accidentally change anything.
 *
 * Lint-policy ALSO has the inline toggle on the Trails listing — the
 * same field, two surfaces. Dedicated settings page is the canonical
 * home; the listing toggle stays because it's useful to flip without
 * drilling in.
 */
export function SettingsTrailPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  useLocale();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<string>('da');
  const [lintPolicy, setLintPolicy] = useState<'trusting' | 'strict'>('trusting');
  // F160 Phase 2 — per-KB persona overrides for tool/public chat audiences.
  // Empty string in the UI maps to null on save (= "clear back to default").
  const [chatPersonaTool, setChatPersonaTool] = useState('');
  const [chatPersonaPublic, setChatPersonaPublic] = useState('');

  useEffect(() => {
    listKnowledgeBases()
      .then((list) => {
        // kbId from the route may be a UUID or a slug (F135). Match both
        // so slug-routed URLs don't freeze the panel on a null kb.
        const match = matchKb(list, kbId);
        setKb(match);
        if (match) {
          setName(match.name);
          setDescription(match.description ?? '');
          setLanguage(match.language ?? 'da');
          setLintPolicy(match.lintPolicy ?? 'trusting');
          setChatPersonaTool(match.chatPersonaTool ?? '');
          setChatPersonaPublic(match.chatPersonaPublic ?? '');
        }
      })
      .catch((err: ApiError) => setError(err.message));
  }, [kbId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const trimmedName = name.trim();
  const nameChanged = kb !== null && trimmedName !== kb.name;
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 100;
  const dirty =
    kb !== null &&
    (nameChanged ||
      (kb.description ?? '') !== description ||
      (kb.language ?? 'da') !== language ||
      (kb.lintPolicy ?? 'trusting') !== lintPolicy ||
      (kb.chatPersonaTool ?? '') !== chatPersonaTool ||
      (kb.chatPersonaPublic ?? '') !== chatPersonaPublic);

  const onSave = async () => {
    if (!kb || busy || !dirty || !nameValid) return;
    setBusy(true);
    try {
      const updated = await updateKnowledgeBase(kb.id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        description: description.trim() === '' ? null : description,
        language,
        lintPolicy,
        // Empty string maps to null on the wire = "clear back to default
        // template". Server PATCH treats null + empty equivalently.
        chatPersonaTool: chatPersonaTool.trim() === '' ? null : chatPersonaTool,
        chatPersonaPublic: chatPersonaPublic.trim() === '' ? null : chatPersonaPublic,
      });
      setKb(updated);
      setToast({ kind: 'success', text: t('settings.savedToast') });
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : t('common.error'),
      });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div class="page-shell">
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-4 text-sm">
          {error}
        </div>
      </div>
    );
  }

  if (!kb) {
    return (
      <div class="page-shell">
        <CenteredLoader />
      </div>
    );
  }

  return (
    <div class="page-shell">
      <header class="mb-6">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">
          {t('settings.trail.title')}
        </h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {t('settings.trail.subtitle', { name: kb.name })}
        </p>
      </header>

      <div class="space-y-8 max-w-2xl">
        <section>
          <label class="block mb-2">
            <span class="text-sm font-medium">{t('settings.trail.nameLabel')}</span>
          </label>
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            maxLength={100}
            class={
              'w-full px-3 py-2 rounded-md border bg-transparent text-sm ' +
              (nameValid
                ? 'border-[color:var(--color-border)]'
                : 'border-[color:var(--color-danger)]')
            }
          />
          <p class="mt-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
            {t('settings.trail.nameHint')}
          </p>
        </section>

        <section>
          <label class="block mb-2">
            <span class="text-sm font-medium">{t('settings.trail.descriptionLabel')}</span>
            <span class="ml-2 text-[11px] text-[color:var(--color-fg-subtle)]">
              {t('common.optional')}
            </span>
          </label>
          <textarea
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            placeholder={t('settings.trail.descriptionPlaceholder')}
            rows={3}
            class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-transparent text-sm resize-y"
          />
        </section>

        <section>
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
          <p class="mt-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
            {t('settings.trail.languageHint')}
          </p>
        </section>

        <section>
          <label class="block mb-2">
            <span class="text-sm font-medium">{t('kbs.lintPolicy.label')}</span>
          </label>
          <div
            class="inline-flex items-center rounded-md border border-[color:var(--color-border)] overflow-hidden"
            role="group"
          >
            {(['trusting', 'strict'] as const).map((p) => {
              const active = p === lintPolicy;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setLintPolicy(p)}
                  title={t(`kbs.lintPolicy.${p}Hint`)}
                  class={
                    'px-3 py-1.5 text-xs font-mono uppercase tracking-wide transition ' +
                    (active
                      ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                      : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-card)]')
                  }
                  aria-pressed={active}
                >
                  {t(`kbs.lintPolicy.${p}`)}
                </button>
              );
            })}
          </div>
          <p class="mt-1.5 text-[11px] text-[color:var(--color-fg-subtle)] max-w-md">
            {t(`kbs.lintPolicy.${lintPolicy}Hint`)}
          </p>
        </section>

        <section class="pt-2 border-t border-[color:var(--color-border)]">
          <div class="mb-3">
            <h2 class="text-sm font-medium">{t('settings.trail.personas.title')}</h2>
            <p class="mt-1 text-[11px] text-[color:var(--color-fg-subtle)] max-w-md">
              {t('settings.trail.personas.subtitle')}
            </p>
          </div>

          <label class="block mb-2">
            <span class="text-sm font-medium">{t('settings.trail.personas.toolLabel')}</span>
            <span class="ml-2 text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
              audience: tool
            </span>
          </label>
          <textarea
            value={chatPersonaTool}
            onInput={(e) => setChatPersonaTool((e.target as HTMLTextAreaElement).value)}
            placeholder={t('settings.trail.personas.toolPlaceholder')}
            maxLength={4000}
            rows={4}
            class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-transparent text-sm font-mono leading-relaxed resize-y focus:outline-none focus:border-[color:var(--color-accent)] transition"
          />
          <p class="mt-1 mb-4 text-[11px] text-[color:var(--color-fg-subtle)]">
            {t('settings.trail.personas.toolHint')}
          </p>

          <label class="block mb-2">
            <span class="text-sm font-medium">{t('settings.trail.personas.publicLabel')}</span>
            <span class="ml-2 text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
              audience: public
            </span>
          </label>
          <textarea
            value={chatPersonaPublic}
            onInput={(e) => setChatPersonaPublic((e.target as HTMLTextAreaElement).value)}
            placeholder={t('settings.trail.personas.publicPlaceholder')}
            maxLength={4000}
            rows={5}
            class="w-full px-3 py-2 rounded-md border border-[color:var(--color-border)] bg-transparent text-sm font-mono leading-relaxed resize-y focus:outline-none focus:border-[color:var(--color-accent)] transition"
          />
          <p class="mt-1 text-[11px] text-[color:var(--color-fg-subtle)]">
            {t('settings.trail.personas.publicHint')}
          </p>
        </section>

        <div class="pt-4 border-t border-[color:var(--color-border)]">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!dirty || busy}
            class="px-4 py-2 rounded-md bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] text-sm font-medium disabled:opacity-50 transition"
          >
            {busy ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>

      {toast ? (
        <div
          class={
            'fixed bottom-6 right-6 z-40 px-4 py-3 rounded-md border text-sm shadow-lg ' +
            (toast.kind === 'success'
              ? 'border-[color:var(--color-success)]/30 bg-[color:var(--color-success)]/10'
              : 'border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/10')
          }
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
