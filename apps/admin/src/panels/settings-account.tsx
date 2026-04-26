import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  ApiError,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  type ApiKeyRow,
  type ApiKeyCreated,
} from '../api';
import { t, useLocale } from '../lib/i18n';
import { ambientEnabled, ambientVolume } from '../lib/ambient-store';
import { CenteredLoader } from '../components/centered-loader';
import { Modal, ModalButton } from '../components/modal';

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

        <ApiKeysSection />

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

/**
 * F111.2 — API Keys section. Lists this user's non-revoked Bearer
 * tokens, lets them mint a new key (raw value shown ONCE in a modal
 * the curator must explicitly acknowledge), and revoke existing keys.
 *
 * Lives under Settings → Account because keys are per-user. When we
 * grow tenant-scoped service accounts the section moves to a tenant
 * settings panel; the surface is small enough that a redesign moving
 * it costs nothing.
 */
function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const refresh = useCallback(() => {
    listApiKeys()
      .then((rows) => {
        setKeys(rows);
        setLoadError(null);
      })
      .catch((err: ApiError) => {
        setKeys([]);
        setLoadError(err.message);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openCreate = () => {
    setCreateName('');
    setCreateError(null);
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError(t('settings.account.apiKeys.nameRequired'));
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await createApiKey(name);
      setCreateOpen(false);
      setRevealKey(created);
      setCopied(false);
      setCopyFailed(false);
      refresh();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const copyKey = async () => {
    if (!revealKey) return;
    try {
      await navigator.clipboard.writeText(revealKey.key);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard rejected (permissions denied, non-secure context,
      // or browser restriction). Surface the failure so the curator
      // knows to select-and-copy from the visible <code> block —
      // silent failure here would mean someone could close the modal
      // thinking the key was on their clipboard.
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      await revokeApiKey(revokeTarget.id);
      setRevokeTarget(null);
      refresh();
    } catch (err) {
      // Re-use the same error surface as the load error so curator
      // sees something even if revoke fails.
      setLoadError(err instanceof ApiError ? err.message : String(err));
      setRevokeTarget(null);
    } finally {
      setRevokeBusy(false);
    }
  };

  return (
    <section>
      <h2 class="text-sm font-medium mb-1">{t('settings.account.apiKeys.title')}</h2>
      <p class="text-xs text-[color:var(--color-fg-muted)] mb-3">
        {t('settings.account.apiKeys.subtitle')}
      </p>

      {loadError ? (
        <div class="mb-3 rounded-md border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 px-3 py-2 text-xs">
          {loadError}
        </div>
      ) : null}

      {keys === null ? (
        <div class="py-4">
          <CenteredLoader />
        </div>
      ) : keys.length === 0 ? (
        <p class="text-sm text-[color:var(--color-fg-muted)] mb-3">
          {t('settings.account.apiKeys.empty')}
        </p>
      ) : (
        <div class="border border-[color:var(--color-border)] rounded-md overflow-hidden mb-3">
          <table class="w-full text-sm">
            <thead class="bg-[color:var(--color-bg-card)]/60 text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
              <tr>
                <th class="text-left px-3 py-2">{t('settings.account.apiKeys.colName')}</th>
                <th class="text-left px-3 py-2">{t('settings.account.apiKeys.colLastUsed')}</th>
                <th class="text-left px-3 py-2">{t('settings.account.apiKeys.colCreated')}</th>
                <th class="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  class="border-t border-[color:var(--color-border)]"
                >
                  <td class="px-3 py-2">{k.name}</td>
                  <td class="px-3 py-2 text-[color:var(--color-fg-muted)] text-xs">
                    {k.lastUsedAt ? formatDate(k.lastUsedAt) : t('settings.account.apiKeys.neverUsed')}
                  </td>
                  <td class="px-3 py-2 text-[color:var(--color-fg-muted)] text-xs">
                    {formatDate(k.createdAt)}
                  </td>
                  <td class="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setRevokeTarget(k)}
                      class="text-xs px-2 py-1 rounded border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-danger)] hover:text-[color:var(--color-danger)] transition"
                    >
                      {t('settings.account.apiKeys.revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        type="button"
        onClick={openCreate}
        class="px-4 py-2 rounded-md bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] font-medium text-sm hover:brightness-105 active:scale-[0.98] transition"
      >
        {t('settings.account.apiKeys.create')}
      </button>

      <Modal
        open={createOpen}
        title={t('settings.account.apiKeys.createTitle')}
        onClose={() => (createBusy ? null : setCreateOpen(false))}
        footer={
          <>
            <ModalButton onClick={() => setCreateOpen(false)} disabled={createBusy}>
              {t('common.cancel')}
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => void submitCreate()}
              disabled={createBusy || !createName.trim()}
            >
              {createBusy ? '…' : t('settings.account.apiKeys.create')}
            </ModalButton>
          </>
        }
      >
        <p class="text-sm text-[color:var(--color-fg-muted)] mb-3">
          {t('settings.account.apiKeys.createHint')}
        </p>
        <input
          type="text"
          value={createName}
          onInput={(e) => setCreateName((e.currentTarget as HTMLInputElement).value)}
          placeholder={t('settings.account.apiKeys.namePlaceholder')}
          class="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/80 px-3 py-2 text-sm focus:outline-none focus:border-[color:var(--color-accent)] transition"
        />
        {createError ? (
          <div class="mt-2 text-xs text-[color:var(--color-danger)]">{createError}</div>
        ) : null}
      </Modal>

      <Modal
        open={revealKey !== null}
        title={t('settings.account.apiKeys.revealTitle')}
        onClose={() => setRevealKey(null)}
        maxWidth="md"
        footer={
          <ModalButton variant="primary" onClick={() => setRevealKey(null)}>
            {t('settings.account.apiKeys.acknowledge')}
          </ModalButton>
        }
      >
        <div class="rounded-md border border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10 px-3 py-2 text-xs mb-3">
          {t('settings.account.apiKeys.revealWarning')}
        </div>
        <div class="text-xs text-[color:var(--color-fg-muted)] mb-1">
          {revealKey?.name}
        </div>
        <div class="flex items-center gap-2">
          <code class="flex-1 font-mono text-[12px] bg-[color:var(--color-bg-card)] border border-[color:var(--color-border)] rounded px-3 py-2 break-all">
            {revealKey?.key}
          </code>
          <button
            type="button"
            onClick={() => void copyKey()}
            class="px-3 py-2 rounded-md text-xs border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] transition whitespace-nowrap"
          >
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
        {copyFailed ? (
          <div class="mt-2 text-xs text-[color:var(--color-danger)]">
            {t('settings.account.apiKeys.copyFailed')}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={revokeTarget !== null}
        title={t('settings.account.apiKeys.revokeTitle')}
        onClose={() => (revokeBusy ? null : setRevokeTarget(null))}
        footer={
          <>
            <ModalButton onClick={() => setRevokeTarget(null)} disabled={revokeBusy}>
              {t('common.cancel')}
            </ModalButton>
            <ModalButton
              variant="danger"
              onClick={() => void submitRevoke()}
              disabled={revokeBusy}
            >
              {revokeBusy ? '…' : t('settings.account.apiKeys.confirmRevoke')}
            </ModalButton>
          </>
        }
      >
        <p class="text-sm">
          {t('settings.account.apiKeys.revokeBody', { name: revokeTarget?.name ?? '' })}
        </p>
      </Modal>
    </section>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
