/**
 * F138 — Work Layer panel.
 *
 * Kanban on documents.kind='work'. Four columns (open / in-progress /
 * done / blocked). Drag-to-move fires updateWorkState which does a
 * direct documents UPDATE — see routes/work.ts for why state mutations
 * live outside the queue.
 *
 * Click a card → wiki-reader at the item's slug (Work items are
 * documents, so the existing reader renders their content). Creation
 * happens via the "+ Ny" button; no separate editor yet — the reader's
 * edit flow handles content edits via submitCuratorEdit.
 */
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import {
  listWorkItems,
  createWorkItem,
  updateWorkState,
  ApiError,
  type WorkItem,
  type WorkStatus,
  type WorkKind,
} from '../api';
import { t, useLocale } from '../lib/i18n';
import { CenteredLoader } from '../components/centered-loader';
import { Modal, ModalButton } from '../components/modal';

const COLUMNS: ReadonlyArray<{ status: WorkStatus; labelKey: string }> = [
  { status: 'open', labelKey: 'work.status.open' },
  { status: 'in-progress', labelKey: 'work.status.in-progress' },
  { status: 'blocked', labelKey: 'work.status.blocked' },
  { status: 'done', labelKey: 'work.status.done' },
];

const KINDS: ReadonlyArray<WorkKind> = ['task', 'bug', 'milestone', 'decision'];

export function WorkPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  useLocale();

  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<WorkKind | null>(null);

  const reload = useCallback(() => {
    if (!kbId) return;
    listWorkItems(kbId, {})
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((err: ApiError) => {
        setError(err.message);
        // Flip out of the loader even on failure so the Kanban frame
        // renders with the empty columns plus an error banner — without
        // this the spinner spins forever on a 404/500.
        setItems([]);
      });
  }, [kbId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filtered = useMemo(() => {
    if (!items) return null;
    if (!kindFilter) return items;
    return items.filter((it) => it.workKind === kindFilter);
  }, [items, kindFilter]);

  const byStatus = useMemo(() => {
    const map = new Map<WorkStatus, WorkItem[]>();
    for (const col of COLUMNS) map.set(col.status, []);
    if (!filtered) return map;
    for (const item of filtered) {
      const bucket = map.get((item.workStatus ?? 'open') as WorkStatus);
      if (bucket) bucket.push(item);
    }
    return map;
  }, [filtered]);

  const assignees = useMemo(() => {
    if (!items) return [];
    const seen = new Set<string>();
    for (const it of items) {
      if (it.workAssignee) seen.add(it.workAssignee);
    }
    return [...seen].sort();
  }, [items]);

  const onDrop = useCallback(
    async (nextStatus: WorkStatus) => {
      if (!draggingId || !items) return;
      const current = items.find((it) => it.id === draggingId);
      setDraggingId(null);
      if (!current || current.workStatus === nextStatus) return;
      // Optimistic — re-fetch truth on error.
      setItems((prev) =>
        prev?.map((it) =>
          it.id === draggingId ? { ...it, workStatus: nextStatus } : it,
        ) ?? null,
      );
      try {
        await updateWorkState(draggingId, { workStatus: nextStatus });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Update failed');
        reload();
      }
    },
    [draggingId, items, reload],
  );

  if (!kbId) return null;

  return (
    <div class="page-shell">
      <header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight mb-1">{t('work.title')}</h1>
          <p class="text-[color:var(--color-fg-muted)] text-sm">{t('work.subtitle')}</p>
        </div>
        <div class="flex items-center gap-3">
          <KindFilter value={kindFilter} onChange={setKindFilter} />
          <button
            type="button"
            onClick={() => setCreating(true)}
            class="shrink-0 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md border border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] transition"
          >
            {t('work.new')}
          </button>
        </div>
      </header>

      {error ? (
        <div class="mb-4 px-3 py-2 text-sm rounded bg-red-500/10 text-red-400 border border-red-500/30">
          {error}
        </div>
      ) : null}

      {items === null ? <CenteredLoader /> : null}

      {items !== null ? (
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {COLUMNS.map((col) => {
            const bucket = byStatus.get(col.status) ?? [];
            return (
              <WorkColumn
                key={col.status}
                status={col.status}
                label={t(col.labelKey)}
                count={bucket.length}
                items={bucket}
                kbId={kbId}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
                onDrop={() => onDrop(col.status)}
                draggingId={draggingId}
              />
            );
          })}
        </div>
      ) : null}

      {creating ? (
        <CreateWorkModal
          kbId={kbId}
          assignees={assignees}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function KindFilter({
  value,
  onChange,
}: {
  value: WorkKind | null;
  onChange: (next: WorkKind | null) => void;
}) {
  return (
    <div
      class="inline-flex items-center rounded-md border border-[color:var(--color-border)] overflow-hidden text-[11px] font-mono uppercase tracking-wider"
      role="group"
      aria-label={t('work.filter.kind')}
    >
      <button
        type="button"
        onClick={() => onChange(null)}
        class={
          'px-2 py-1 transition ' +
          (value === null
            ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
            : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
        }
        aria-pressed={value === null}
      >
        {t('common.all')}
      </button>
      {KINDS.map((k) => {
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange(active ? null : k)}
            class={
              'px-2 py-1 transition border-l border-[color:var(--color-border)] ' +
              (active
                ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
            }
            aria-pressed={active}
          >
            {t(`work.kind.${k}`)}
          </button>
        );
      })}
    </div>
  );
}

function WorkColumn({
  status,
  label,
  count,
  items,
  kbId,
  onDragStart,
  onDragEnd,
  onDrop,
  draggingId,
}: {
  status: WorkStatus;
  label: string;
  count: number;
  items: WorkItem[];
  kbId: string;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: () => void;
  draggingId: string | null;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      class={
        'rounded-lg border p-3 min-h-[200px] transition ' +
        (dragOver
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/30')
      }
      onDragOver={(e) => {
        if (draggingId) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDrop();
      }}
    >
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-xs font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)]">
          {label}
        </h2>
        <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">{count}</span>
      </div>
      <ul class="space-y-2">
        {items.map((item) => (
          <WorkCard
            key={item.id}
            item={item}
            kbId={kbId}
            onDragStart={() => onDragStart(item.id)}
            onDragEnd={onDragEnd}
          />
        ))}
        {items.length === 0 ? (
          <li class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] italic py-2 text-center">
            —
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function WorkCard({
  item,
  kbId,
  onDragStart,
  onDragEnd,
}: {
  item: WorkItem;
  kbId: string;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const slug = item.filename.replace(/\.md$/, '');
  const href = `/kb/${kbId}/neurons/${slug}`;
  const dueClass = overdueClass(item.workDueAt, item.workStatus);
  return (
    <li>
      <a
        draggable
        onDragStart={(e) => {
          e.dataTransfer?.setData('text/plain', item.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        href={href}
        class="block rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 hover:border-[color:var(--color-border-strong)] transition cursor-grab active:cursor-grabbing"
      >
        <div class="flex items-start justify-between gap-2 mb-1">
          <span class="text-sm font-medium text-[color:var(--color-fg)] leading-snug">
            {item.title ?? item.filename}
          </span>
          <KindBadge kind={item.workKind} />
        </div>
        <div class="flex items-center justify-between text-[11px] font-mono text-[color:var(--color-fg-muted)] mt-2">
          <span>{item.workAssignee ?? '—'}</span>
          {item.workDueAt ? <span class={dueClass}>{item.workDueAt}</span> : null}
        </div>
      </a>
    </li>
  );
}

function KindBadge({ kind }: { kind: WorkKind | null }) {
  if (!kind) return null;
  const palette: Record<WorkKind, string> = {
    task: 'text-blue-400 border-blue-400/40',
    bug: 'text-red-400 border-red-400/40',
    milestone: 'text-amber-400 border-amber-400/40',
    decision: 'text-purple-400 border-purple-400/40',
  };
  return (
    <span
      class={`shrink-0 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider rounded border ${palette[kind]}`}
    >
      {t(`work.kind.${kind}`)}
    </span>
  );
}

function overdueClass(due: string | null, status: WorkStatus | null): string {
  if (!due || status === 'done') return '';
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d < today) return 'text-red-400 font-semibold';
  return '';
}

function CreateWorkModal({
  kbId,
  assignees,
  onClose,
  onCreated,
}: {
  kbId: string;
  assignees: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [workKind, setWorkKind] = useState<WorkKind>('task');
  const [assignee, setAssignee] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await createWorkItem(kbId, {
        title: title.trim(),
        content,
        workKind,
        workStatus: 'open',
        workAssignee: assignee.trim() || null,
        workDueAt: dueAt || null,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
      setBusy(false);
    }
  }, [title, content, workKind, assignee, dueAt, busy, kbId, onCreated]);

  return (
    <Modal
      open
      title={t('work.createTitle')}
      onClose={onClose}
      footer={
        <div class="flex items-center gap-2 justify-end">
          <ModalButton onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </ModalButton>
          <ModalButton variant="primary" onClick={submit} disabled={!title.trim() || busy}>
            {busy ? t('common.loading') : t('work.create')}
          </ModalButton>
        </div>
      }
    >
      <div class="space-y-3">
        <label class="block">
          <span class="block text-xs font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)] mb-1">
            {t('work.field.title')}
          </span>
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            class="w-full px-3 py-2 rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-accent)]"
            autoFocus
            maxLength={200}
          />
        </label>

        <label class="block">
          <span class="block text-xs font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)] mb-1">
            {t('work.field.kind')}
          </span>
          <div class="inline-flex rounded-md border border-[color:var(--color-border)] overflow-hidden text-[11px] font-mono uppercase tracking-wider">
            {KINDS.map((k) => {
              const active = workKind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setWorkKind(k)}
                  class={
                    'px-2 py-1 transition border-l border-[color:var(--color-border)] first:border-l-0 ' +
                    (active
                      ? 'bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]'
                      : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
                  }
                >
                  {t(`work.kind.${k}`)}
                </button>
              );
            })}
          </div>
        </label>

        <label class="block">
          <span class="block text-xs font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)] mb-1">
            {t('work.field.assignee')}
          </span>
          <input
            type="text"
            list="work-assignees"
            value={assignee}
            onInput={(e) => setAssignee((e.target as HTMLInputElement).value)}
            class="w-full px-3 py-2 rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-accent)]"
            maxLength={200}
          />
          <datalist id="work-assignees">
            {assignees.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </label>

        <label class="block">
          <span class="block text-xs font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)] mb-1">
            {t('work.field.dueAt')}
          </span>
          <input
            type="date"
            value={dueAt}
            onInput={(e) => setDueAt((e.target as HTMLInputElement).value)}
            class="w-full px-3 py-2 rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-accent)]"
          />
        </label>

        <label class="block">
          <span class="block text-xs font-mono uppercase tracking-wider text-[color:var(--color-fg-muted)] mb-1">
            {t('work.field.content')}
          </span>
          <textarea
            value={content}
            onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
            rows={5}
            class="w-full px-3 py-2 rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-border)] focus:outline-none focus:border-[color:var(--color-accent)] resize-y font-mono text-sm"
            placeholder={t('work.field.contentHint')}
          />
        </label>

        {err ? <div class="text-sm text-red-400">{err}</div> : null}
      </div>
    </Modal>
  );
}
