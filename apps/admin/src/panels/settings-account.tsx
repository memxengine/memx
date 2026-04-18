import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { t, useLocale } from '../lib/i18n';
import { ambientEnabled, ambientVolume } from '../lib/ambient-store';
import { CenteredLoader } from '../components/centered-loader';

interface Me {
  id: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantPlan: string;
}

/**
 * Account settings at `/settings`. Per-user and per-device configuration
 * that isn't Trail-scoped: who you are, which tenant, and device-local
 * preferences (currently ambient audio).
 *
 * Ambient lives here rather than in the header because F94 proved that
 * hover-popover sliders race badly. A settings row with an always-
 * visible slider is the right control weight for a setting that's used
 * rarely.
 */
export function SettingsAccountPanel() {
  useLocale();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = ambientEnabled.value;
  const volume = ambientVolume.value;

  useEffect(() => {
    api<Me>('/api/v1/me')
      .then(setMe)
      .catch((err: ApiError) => setError(err.message));
  }, []);

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      window.location.href = '/';
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

  if (!me) {
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
          {t('settings.account.title')}
        </h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          {t('settings.account.subtitle')}
        </p>
      </header>

      <div class="space-y-8 max-w-2xl">
        <section>
          <h2 class="text-sm font-medium mb-3">{t('settings.account.profile')}</h2>
          <dl class="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt class="text-[color:var(--color-fg-subtle)]">{t('settings.account.name')}</dt>
            <dd>{me.displayName || me.email}</dd>
            <dt class="text-[color:var(--color-fg-subtle)]">{t('settings.account.email')}</dt>
            <dd class="font-mono text-[13px]">{me.email}</dd>
          </dl>
        </section>

        <section>
          <h2 class="text-sm font-medium mb-3">{t('settings.account.tenant')}</h2>
          <dl class="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt class="text-[color:var(--color-fg-subtle)]">{t('settings.account.tenantName')}</dt>
            <dd>{me.tenantName}</dd>
            <dt class="text-[color:var(--color-fg-subtle)]">{t('settings.account.tenantSlug')}</dt>
            <dd class="font-mono text-[13px]">{me.tenantSlug}</dd>
            <dt class="text-[color:var(--color-fg-subtle)]">{t('settings.account.plan')}</dt>
            <dd>
              <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wider bg-[color:var(--color-bg-card)] border border-[color:var(--color-border)]">
                {me.tenantPlan}
              </span>
            </dd>
          </dl>
        </section>

        <section>
          <h2 class="text-sm font-medium mb-3">{t('settings.account.ambient')}</h2>
          <div class="space-y-3">
            <label class="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  ambientEnabled.value = (e.target as HTMLInputElement).checked;
                }}
                class="accent-[color:var(--color-accent)]"
              />
              <span class="text-sm">{t('settings.account.ambientEnabled')}</span>
            </label>
            <div class="flex items-center gap-3">
              <label class="text-sm text-[color:var(--color-fg-muted)] w-[140px]">
                {t('settings.account.ambientVolume')}
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(volume * 100)}
                onInput={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  ambientVolume.value = Math.max(0, Math.min(1, v / 100));
                }}
                disabled={!enabled}
                class="flex-1 max-w-xs accent-[color:var(--color-accent)] disabled:opacity-50"
              />
              <span class="font-mono text-[11px] text-[color:var(--color-fg-subtle)] w-10 text-right">
                {Math.round(volume * 100)}
              </span>
            </div>
          </div>
        </section>

        <section class="pt-4 border-t border-[color:var(--color-border)]">
          <button
            type="button"
            onClick={() => void handleSignOut()}
            class="px-4 py-2 rounded-md border border-[color:var(--color-border-strong)] text-sm hover:border-[color:var(--color-danger)] hover:text-[color:var(--color-danger)] transition"
          >
            {t('nav.signOut')}
          </button>
        </section>
      </div>
    </div>
  );
}
