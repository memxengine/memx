import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useRoute } from 'preact-iso';
import { marked } from 'marked';
import { chat, saveChatAsNeuron, ApiError, type ChatResponse, type ChatCitation } from '../api';
import { rewriteWikiLinks } from '../lib/wiki-links';
import { Modal, ModalButton } from '../components/modal';
import { ThinkingAnimation } from '../components/thinking-animation';

/**
 * Chat-against-a-Trail. Retrieves from the KB's FTS index + asks Claude via
 * the engine, then renders the answer with `[[wiki-links]]` turned into
 * navigable Neuron links and citations pinned at the bottom. The same
 * /api/v1/chat endpoint that an embed widget or CMS adapter would hit.
 *
 * Feedback loop (the Sanne pattern): a good answer can be promoted to a
 * Neuron via "Save as Neuron" — the question+answer is POSTed to the queue
 * as a kind='chat-answer' candidate, lands pending, and the curator commits
 * it to the wiki from the Queue tab. This is what the llmwiki-ts prototype
 * demonstrated and what makes the chat a contributor to the Trail rather
 * than a dead-end consumer of it.
 */

interface Turn {
  id: string;
  question: string;
  answer: string | null;
  citations: ChatCitation[];
  error: string | null;
  savedAs: string | null;
}

export function ChatPanel() {
  const route = useRoute();
  const kbId = route.params.kbId ?? '';
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [askStartTime, setAskStartTime] = useState<number | null>(null);
  const [saveTarget, setSaveTarget] = useState<Turn | null>(null);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the feed pinned to the bottom as new turns land.
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
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setInput('');
    setTurns((prev) => [
      ...prev,
      { id: turnId, question: q, answer: null, citations: [], error: null, savedAs: null },
    ]);
    setBusy(true);
    setAskStartTime(Date.now());
    try {
      const res: ChatResponse = await chat(kbId, q);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? { ...t, answer: res.answer, citations: res.citations ?? [] }
            : t,
        ),
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, error: msg } : t)));
    } finally {
      setBusy(false);
      setAskStartTime(null);
    }
  }, [input, busy, kbId]);

  const openSaveDialog = useCallback((turn: Turn) => {
    setSaveTarget(turn);
    // Default title = question, trimmed. Curator can edit in dialog.
    setSaveTitle(turn.question.length > 70 ? turn.question.slice(0, 67) + '…' : turn.question);
    setSaveError(null);
  }, []);

  const confirmSave = useCallback(async () => {
    const turn = saveTarget;
    if (!turn || !turn.answer) return;
    const title = saveTitle.trim();
    if (!title) {
      setSaveError('Title is required');
      return;
    }
    try {
      await saveChatAsNeuron({
        kbId,
        question: turn.question,
        answer: turn.answer,
        citations: turn.citations,
        title,
      });
      setTurns((prev) => prev.map((t) => (t.id === turn.id ? { ...t, savedAs: title } : t)));
      setToast({ kind: 'success', text: 'Saved to queue — review in Queue tab.' });
      setSaveTarget(null);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    }
  }, [saveTarget, saveTitle, kbId]);

  return (
    <div class="page-shell flex flex-col" style={{ minHeight: 'calc(100vh - 10rem)' }}>
      <header class="mb-4">
        <h1 class="text-2xl font-semibold tracking-tight mb-1">Chat</h1>
        <p class="text-[color:var(--color-fg-muted)] text-sm">
          Ask this Trail a question — grounded in its Neurons + Sources. Good answers can be promoted to new Neurons.
        </p>
      </header>

      <div
        ref={scrollRef}
        class="flex-1 overflow-y-auto space-y-6 pb-4"
      >
        {turns.length === 0 ? (
          <EmptyHint />
        ) : (
          turns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              kbId={kbId}
              onSave={() => openSaveDialog(turn)}
            />
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
        onClose={() => setSaveTarget(null)}
        footer={
          <>
            <ModalButton onClick={() => setSaveTarget(null)}>Cancel</ModalButton>
            <ModalButton variant="primary" onClick={confirmSave} disabled={!saveTitle.trim()}>
              Send to queue
            </ModalButton>
          </>
        }
      >
        {saveTarget ? (
          <div class="space-y-3">
            <div>
              <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
                Question
              </div>
              <div class="text-sm truncate">{saveTarget.question}</div>
            </div>
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
              <div class="text-[11px] font-mono text-[color:var(--color-fg-subtle)] mt-1">
                Lands as a pending `chat-answer` candidate at /neurons/queries/. Review + approve in Queue.
              </div>
            </div>
            {saveError ? (
              <div class="text-sm text-[color:var(--color-danger)]">{saveError}</div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function TurnView({ turn, kbId, onSave }: { turn: Turn; kbId: string; onSave: () => void }) {
  return (
    <div>
      <div class="mb-2">
        <div class="text-[11px] font-mono uppercase tracking-wider text-[color:var(--color-fg-subtle)] mb-1">
          Question
        </div>
        <div class="text-sm">{turn.question}</div>
      </div>

      {turn.error ? (
        <div class="border border-[color:var(--color-danger)]/30 bg-[color:var(--color-danger)]/5 rounded-md p-3 text-sm">
          {turn.error}
        </div>
      ) : turn.answer === null ? (
        <div class="text-[color:var(--color-fg-subtle)] text-sm">…</div>
      ) : (
        <AnswerView turn={turn} kbId={kbId} onSave={onSave} />
      )}
    </div>
  );
}

function AnswerView({
  turn,
  kbId,
  onSave,
}: {
  turn: Turn;
  kbId: string;
  onSave: () => void;
}) {
  const html = marked.parse(rewriteWikiLinks(turn.answer ?? '', kbId), { async: false }) as string;
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
            ✓ saved to queue as “{turn.savedAs}”
          </span>
        ) : (
          <span class="text-[11px] font-mono text-[color:var(--color-fg-subtle)]">
            Useful? Promote it to a Neuron.
          </span>
        )}
        <div class="flex items-center gap-2">
          <CopyAnswer text={turn.answer ?? ''} />
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
      // Silent — user can always drag-select the answer body above.
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
