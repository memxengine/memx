import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import {
  chat,
  saveChatAsNeuron,
  listChatSessions,
  getChatSession,
  patchChatSession,
  deleteChatSession,
  ApiError,
  type ChatResponse,
  type ChatCitation,
  type ChatSession,
  type ChatTurnRow,
} from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { Modal, ModalButton } from '../components/modal';
import { ThinkingAnimation } from '../components/thinking-animation';
import { CenteredLoader } from '../components/centered-loader';

/**
 * F144 — Chat-against-a-Trail with persistent history.
 *
 * Layout: sidebar (sessions grouped by recency) + active feed. Each session
 * holds the Q+A turns for a conversation, persisted server-side so a route-
 * change or reload no longer wipes a useful answer. The old single-feed
 * behaviour is gone — there is always exactly one active session at a time.
 *
 * Writing: POST /chat auto-creates a session on first turn when no sessionId
 * is in-flight, then returns the session id so the client pins to it for
 * subsequent turns.
 *
 * Citations: stored as { neuronId, path, filename } JSON. neuronId is the
 * stable UUID, so a Neuron rename doesn't break the citation link.
 */

interface LocalTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: ChatCitation[];
  createdAt: string;
  /** UI-only: set when the turn is freshly in-flight (local id, no server id). */
  pending?: boolean;
  /** UI-only: surface network errors next to the turn that failed. */
  error?: string;
  /** UI-only: marker after Save-as-Neuron succeeded. */
  savedAs?: string;
}

/** Decode a turn row from the server into the UI shape. */
function turnFromRow(row: ChatTurnRow): LocalTurn {
  let citations: ChatCitation[] = [];
  if (row.citations) {
    try {
      const parsed = JSON.parse(row.citations) as Array<{
        neuronId?: string;
        documentId?: string;
        path: string;
        filename: string;
      }>;
      citations = parsed.map((c) => ({
        documentId: c.neuronId ?? c.documentId ?? '',
        path: c.path,
        filename: c.filename,
      }));
    } catch {
      // Stored blob is malformed — render without citations rather than
      // erroring the whole load. Non-fatal.
    }
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations,
    createdAt: row.createdAt,
  };
}

type DayGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

function groupSessionByDay(updatedAt: string, now: Date): DayGroup {
  const u = new Date(updatedAt);
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = now.getTime() - u.getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (u.getTime() >= startOfToday) return 'Today';
  if (u.getTime() >= startOfToday - dayMs) return 'Yesterday';
  if (diff < 7 * dayMs) return 'This week';
  return 'Earlier';
}

export function ChatPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<LocalTurn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [askStartTime, setAskStartTime] = useState<number | null>(null);
  const [saveTarget, setSaveTarget] = useState<LocalTurn | null>(null);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [renameTarget, setRenameTarget] = useState<ChatSession | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const reloadSessions = useCallback(() => {
    if (!kbId) return;
    listChatSessions(kbId, 'false')
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [kbId]);

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions]);

  // Load turns when active session changes. null → fresh empty feed.
  useEffect(() => {
    if (!activeId) {
      setTurns([]);
      return;
    }
    setTurnsLoading(true);
    getChatSession(activeId)
      .then((d) => {
        setTurns(d.turns.map(turnFromRow));
      })
      .catch(() => setTurns([]))
      .finally(() => setTurnsLoading(false));
  }, [activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const ask = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    const localQid = `u_${Date.now()}`;
    const localAid = `a_${Date.now()}`;
    const now = new Date().toISOString();
    setInput('');
    setTurns((prev) => [
      ...prev,
      {
        id: localQid,
        role: 'user',
        content: q,
        citations: [],
        createdAt: now,
        pending: true,
      },
      {
        id: localAid,
        role: 'assistant',
        content: '',
        citations: [],
        createdAt: now,
        pending: true,
      },
    ]);
    setBusy(true);
    setAskStartTime(Date.now());
    try {
      const res: ChatResponse = await chat(kbId, q, activeId ?? undefined);
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id === localAid) {
            return {
              ...t,
              content: res.answer,
              citations: res.citations ?? [],
              pending: false,
            };
          }
          if (t.id === localQid) {
            return { ...t, pending: false };
          }
          return t;
        }),
      );
      // Pin the session id the server landed on (auto-created or echoed).
      if (res.sessionId && res.sessionId !== activeId) {
        setActiveId(res.sessionId);
      }
      reloadSessions();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setTurns((prev) =>
        prev.map((t) => (t.id === localAid ? { ...t, error: msg, pending: false } : t)),
      );
    } finally {
      setBusy(false);
      setAskStartTime(null);
    }
  }, [input, busy, kbId, activeId, reloadSessions]);

  const startNewChat = useCallback(() => {
    setActiveId(null);
    setTurns([]);
    setInput('');
    setSidebarOpen(false);
  }, []);

  const openSaveDialog = useCallback(
    (turn: LocalTurn) => {
      setSaveTarget(turn);
      const paired = findUserTurn(turns, turn);
      const base = paired?.content ?? turn.content;
      setSaveTitle(base.length > 70 ? base.slice(0, 67) + '…' : base);
      setSaveError(null);
    },
    [turns],
  );

  const confirmSave = useCallback(async () => {
    const turn = saveTarget;
    if (!turn || !turn.content || saveBusy) return;
    const title = saveTitle.trim();
    if (!title) {
      setSaveError('Title is required');
      return;
    }
    const paired = findUserTurn(turns, turn);
    setSaveBusy(true);
    setSaveError(null);
    try {
      await saveChatAsNeuron({
        kbId,
        question: paired?.content ?? '',
        answer: turn.content,
        citations: turn.citations,
        title,
      });
      setTurns((prev) => prev.map((t) => (t.id === turn.id ? { ...t, savedAs: title } : t)));
      setToast({ kind: 'success', text: 'Saved to queue — review in Queue tab.' });
      setSaveTarget(null);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  }, [saveTarget, saveTitle, kbId, turns, saveBusy]);

  const confirmRename = useCallback(async () => {
    if (!renameTarget) return;
    const title = renameTitle.trim();
    if (!title) return;
    try {
      await patchChatSession(renameTarget.id, { title });
      setRenameTarget(null);
      reloadSessions();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof ApiError ? err.message : String(err) });
    }
  }, [renameTarget, renameTitle, reloadSessions]);

  const confirmArchive = useCallback(
    async (session: ChatSession) => {
      try {
        await patchChatSession(session.id, { archived: true });
        if (activeId === session.id) startNewChat();
        reloadSessions();
      } catch (err) {
        setToast({ kind: 'error', text: err instanceof ApiError ? err.message : String(err) });
      }
    },
    [activeId, reloadSessions, startNewChat],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteChatSession(deleteTarget.id);
      if (activeId === deleteTarget.id) startNewChat();
      setDeleteTarget(null);
      reloadSessions();
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof ApiError ? err.message : String(err) });
    }
  }, [deleteTarget, activeId, reloadSessions, startNewChat]);

  // Group sessions by day label for the sidebar headings.
  const groupedSessions = useMemo(() => {
    if (!sessions) return null;
    const now = new Date();
    const groups = new Map<DayGroup, ChatSession[]>();
    for (const s of sessions) {
      const key = groupSessionByDay(s.updatedAt, now);
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }
    const order: DayGroup[] = ['Today', 'Yesterday', 'This week', 'Earlier'];
    return order
      .filter((k) => groups.has(k))
      .map((k) => ({ label: k, sessions: groups.get(k)! }));
  }, [sessions]);

  const activeSession = sessions?.find((s) => s.id === activeId) ?? null;

  return (
    <div class="page-shell">
      <div class="flex gap-6 min-h-[calc(100vh-10rem)]">
        <Sidebar
          sidebarOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
          groupedSessions={groupedSessions}
          activeId={activeId}
          onPick={(id) => {
            setActiveId(id);
            setSidebarOpen(false);
          }}
          onNew={startNewChat}
          onRename={(s) => {
            setRenameTarget(s);
            setRenameTitle(s.title ?? '');
          }}
          onArchive={confirmArchive}
          onDelete={(s) => setDeleteTarget(s)}
        />

        <main class="flex-1 flex flex-col min-w-0">
          <header class="mb-4 flex items-baseline gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              class="md:hidden text-xs font-mono text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] transition"
              aria-label="Toggle sessions"
            >
              ☰ sessions
            </button>
            <h1 class="text-2xl font-semibold tracking-tight">
              {activeSession?.title ?? 'New chat'}
            </h1>
          </header>

          <div ref={scrollRef} class="flex-1 overflow-y-auto space-y-6 pb-4">
            {turnsLoading ? (
              <CenteredLoader />
            ) : turns.length === 0 ? (
              <EmptyHint />
            ) : (
              renderPairs(turns).map((pair) => (
                <TurnPair key={pair.assistantTurn?.id ?? pair.userTurn.id} pair={pair} kbId={kbId} onSave={openSaveDialog} />
              ))
            )}
            {busy ? (
              <div class="pt-2">
                <ThinkingAnimation label="Thinking…" startTime={askStartTime} />
              </div>
            ) : null}
          </div>

          <form
            class="sticky bottom-0 bg-[color:var(--color-bg)]/90 backdrop-blur-sm pt-4 pb-6"
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
          >
            <div class="flex gap-2">
              <textarea
                rows={2}
                placeholder="Ask the Trail…"
                value={input}
                disabled={busy}
                onInput={(e) => setInput((e.currentTarget as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    ask();
                  }
                }}
                class="flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)]/80 px-4 py-2.5 text-sm focus:outline-none focus:border-[color:var(--color-accent)] transition resize-none disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!input.trim() || busy}
                class="px-5 py-2 rounded-md bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] font-medium text-sm hover:brightness-105 active:scale-[0.98] disabled:bg-[color:var(--color-border)] disabled:text-[color:var(--color-fg-muted)] disabled:cursor-not-allowed transition"
              >
                {busy ? '…' : 'Ask'}
              </button>
            </div>
            <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] mt-1">
              Enter to send · Shift+Enter for newline
            </div>
          </form>
        </main>
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

      <Modal
        open={saveTarget !== null}
        title="Save as Neuron"
        // Block backdrop-close while the queue POST is in flight — the modal
        // is showing progress, closing it would strand the user not knowing
        // whether the save landed.
        onClose={() => {
          if (!saveBusy) setSaveTarget(null);
        }}
        footer={
          <>
            <ModalButton onClick={() => setSaveTarget(null)} disabled={saveBusy}>
              Cancel
            </ModalButton>
            <ModalButton
              variant="primary"
              onClick={confirmSave}
              disabled={!saveTitle.trim() || saveBusy}
            >
              {saveBusy ? 'Sending…' : 'Send to queue'}
            </ModalButton>
          </>
        }
      >
        {saveTarget ? (
          <div class="space-y-3">
            <div>
              <label
                for="save-title"
                class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)]"
              >
                Neuron title
              </label>
              <input
                id="save-title"
                type="text"
                value={saveTitle}
                onInput={(e) => setSaveTitle((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    confirmSave();
                  }
                }}
                class="mt-1 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 px-3 py-2 text-sm focus:outline-none focus:border-[color:var(--color-accent)] transition"
              />
            </div>
            {saveError ? (
              <div class="text-sm text-[color:var(--color-danger)]">{saveError}</div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={renameTarget !== null}
        title="Rename chat"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <ModalButton onClick={() => setRenameTarget(null)}>Cancel</ModalButton>
            <ModalButton variant="primary" onClick={confirmRename} disabled={!renameTitle.trim()}>
              Save
            </ModalButton>
          </>
        }
      >
        <input
          type="text"
          value={renameTitle}
          onInput={(e) => setRenameTitle((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              confirmRename();
            }
          }}
          autoFocus
          class="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/60 px-3 py-2 text-sm focus:outline-none focus:border-[color:var(--color-accent)] transition"
        />
      </Modal>

      <Modal
        open={deleteTarget !== null}
        title="Delete this chat?"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <ModalButton onClick={() => setDeleteTarget(null)}>Cancel</ModalButton>
            <ModalButton variant="danger" onClick={confirmDelete}>
              Delete
            </ModalButton>
          </>
        }
      >
        <p class="text-sm text-[color:var(--color-fg-muted)]">
          Deletes <strong>"{deleteTarget?.title ?? 'Untitled'}"</strong> and all its turns.
          Not reversible. Use Archive if you want to keep it hidden but recoverable.
        </p>
      </Modal>
    </div>
  );
}

/** Find the user turn that precedes an assistant turn in the feed. */
function findUserTurn(turns: LocalTurn[], assistant: LocalTurn): LocalTurn | null {
  const i = turns.findIndex((t) => t.id === assistant.id);
  for (let j = i - 1; j >= 0; j--) {
    if (turns[j]!.role === 'user') return turns[j]!;
  }
  return null;
}

interface RenderedPair {
  userTurn: LocalTurn;
  assistantTurn: LocalTurn | null;
}

/** Pair sequential user+assistant turns so each question renders with its answer below. */
function renderPairs(turns: LocalTurn[]): RenderedPair[] {
  const pairs: RenderedPair[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== 'user') continue;
    const next = turns[i + 1];
    pairs.push({ userTurn: t, assistantTurn: next?.role === 'assistant' ? next : null });
  }
  return pairs;
}

function Sidebar({
  sidebarOpen,
  onCloseMobile,
  groupedSessions,
  activeId,
  onPick,
  onNew,
  onRename,
  onArchive,
  onDelete,
}: {
  sidebarOpen: boolean;
  onCloseMobile: () => void;
  groupedSessions: Array<{ label: DayGroup; sessions: ChatSession[] }> | null;
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (s: ChatSession) => void;
  onArchive: (s: ChatSession) => void;
  onDelete: (s: ChatSession) => void;
}) {
  const baseClasses =
    'w-64 shrink-0 border-r border-[color:var(--color-border)] pr-4 flex flex-col';
  return (
    <>
      {sidebarOpen ? (
        <div
          class="fixed inset-0 bg-black/40 z-30 md:hidden"
          onClick={onCloseMobile}
          aria-hidden
        />
      ) : null}
      <aside
        class={
          'z-40 bg-[color:var(--color-bg)] md:bg-transparent md:static md:block transition-transform ' +
          baseClasses +
          (sidebarOpen
            ? ' fixed top-0 left-0 bottom-0 p-4 md:p-0 translate-x-0'
            : ' fixed -translate-x-full md:translate-x-0')
        }
      >
        <button
          type="button"
          onClick={onNew}
          class="mb-4 px-3 py-2 rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-card)] text-sm font-medium transition text-left"
        >
          + New chat
        </button>
        <div class="flex-1 overflow-y-auto space-y-4">
          {groupedSessions === null ? (
            <div class="text-xs font-mono text-[color:var(--color-fg-subtle)]">Loading…</div>
          ) : groupedSessions.length === 0 ? (
            <div class="text-xs font-mono text-[color:var(--color-fg-subtle)]">
              No chats yet.
            </div>
          ) : (
            groupedSessions.map((group) => (
              <div key={group.label}>
                <div class="text-[10px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
                  {group.label}
                </div>
                <ul class="space-y-1">
                  {group.sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={activeId === s.id}
                      onPick={() => onPick(s.id)}
                      onRename={() => onRename(s)}
                      onArchive={() => onArchive(s)}
                      onDelete={() => onDelete(s)}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}

function SessionRow({
  session,
  active,
  onPick,
  onRename,
  onArchive,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onPick: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li class="relative group">
      <button
        type="button"
        onClick={onPick}
        class={
          'w-full text-left px-2 py-1.5 rounded text-sm truncate transition ' +
          (active
            ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-fg)]'
            : 'hover:bg-[color:var(--color-bg-card)] text-[color:var(--color-fg-muted)]')
        }
      >
        {session.title ?? 'Untitled'}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        aria-label="Session actions"
        class="absolute right-1 top-1 opacity-0 group-hover:opacity-100 px-1 text-xs text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] transition"
      >
        ⋯
      </button>
      {menuOpen ? (
        <>
          <div class="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div class="absolute right-1 top-6 z-20 w-32 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-card)] shadow-lg py-1 text-xs font-mono">
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 hover:bg-[color:var(--color-bg)] transition"
              onClick={() => {
                setMenuOpen(false);
                onRename();
              }}
            >
              Rename
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 hover:bg-[color:var(--color-bg)] transition"
              onClick={() => {
                setMenuOpen(false);
                onArchive();
              }}
            >
              Archive
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-1.5 text-[color:var(--color-danger)] hover:bg-[color:var(--color-bg)] transition"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        </>
      ) : null}
    </li>
  );
}

function TurnPair({
  pair,
  kbId,
  onSave,
}: {
  pair: RenderedPair;
  kbId: string;
  onSave: (t: LocalTurn) => void;
}) {
  return (
    <div>
      <div class="mb-2">
        <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
          Question
        </div>
        <div class="text-sm">{pair.userTurn.content}</div>
      </div>

      {pair.assistantTurn === null ? (
        <div class="text-[color:var(--color-fg-subtle)] text-sm">…</div>
      ) : pair.assistantTurn.error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-3 text-sm">
          {pair.assistantTurn.error}
        </div>
      ) : pair.assistantTurn.content ? (
        <AnswerView turn={pair.assistantTurn} kbId={kbId} onSave={() => onSave(pair.assistantTurn!)} />
      ) : (
        <div class="text-[color:var(--color-fg-subtle)] text-sm">…</div>
      )}
    </div>
  );
}

function AnswerView({
  turn,
  kbId,
  onSave,
}: {
  turn: LocalTurn;
  kbId: string;
  onSave: () => void;
}) {
  const html = marked.parse(rewriteWikiLinks(turn.content, kbId), { async: false }) as string;
  return (
    <div class="border border-[color:var(--color-border)] rounded-md bg-[color:var(--color-bg-card)]/80 p-4">
      <div
        class="prose-body text-sm leading-relaxed"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {turn.citations.length > 0 ? (
        <div class="mt-3 flex flex-wrap items-center gap-1.5">
          <span class="text-[10px] font-mono text-[color:var(--color-fg-subtle)] uppercase tracking-wider mr-1 flex-shrink-0">
            Sources
          </span>
          {turn.citations.map((c) => {
            const slug = c.filename.replace(/\.md$/i, '');
            const name = c.filename.replace(/\.md$/i, '');
            return (
              <a
                key={c.documentId}
                href={`/kb/${kbId}/neurons/${encodeURIComponent(slug)}`}
                title={c.path}
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-[color:var(--color-bg)]/80 border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-accent)] hover:border-[color:var(--color-accent)]/50 transition"
              >
                <span class="opacity-50 select-none">[[</span>
                <span>{name}</span>
                <span class="opacity-50 select-none">]]</span>
              </a>
            );
          })}
        </div>
      ) : null}

      <div class="mt-4 pt-3 border-t border-[color:var(--color-border)] flex items-center justify-between gap-3">
        {turn.savedAs ? (
          <span class="text-[11px] font-mono text-[color:var(--color-success)]">
            ✓ saved to queue as "{turn.savedAs}"
          </span>
        ) : (
          <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
            Useful? Promote it to a Neuron.
          </span>
        )}
        <div class="flex items-center gap-2">
          <CopyAnswer text={turn.content} />
          <button
            onClick={onSave}
            disabled={!!turn.savedAs}
            class="text-xs px-3 py-1.5 rounded-md border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)] disabled:opacity-50 transition"
          >
            {turn.savedAs ? 'Saved' : 'Save as Neuron'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (): Promise<void> => {
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Silent fallback — user can drag-select the answer body above.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!text}
      title={copied ? 'Copied' : 'Copy answer'}
      class={
        'text-xs px-3 py-1.5 rounded-md border transition ' +
        (copied
          ? 'border-[color:var(--color-success)]/40 text-[color:var(--color-success)]'
          : 'border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg)]') +
        ' disabled:opacity-50'
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function EmptyHint() {
  return (
    <div class="text-center py-16 text-[color:var(--color-fg-subtle)] text-sm">
      Ask a question to get started — answers are grounded in the Neurons + Sources in this Trail.
    </div>
  );
}
