# F31 — Reader Feedback Button → Queue

> `<trail-chat>` widget 👎 button åbner en "hvad var galt?" textarea. Submission bliver en `reader_feedback` candidate med fuld chat-kontekst attached. Lukker embed → curation loop.

## Problem

Når en bruger chatter med Trail via widgetten på en ekstern side, og svaret er forkert eller utilfredsstillende, har de ingen måde at rapportere det på. Chat-svaret forsvinder — ingen lærer af fejlen, ingen curator ser at der er et problem, og wiki'en forbedres ikke.

Karpathy's model har en lukket loop: ingest → query → curate → feed back. Uden reader feedback er loopet åbent — Trail ved ikke hvornår den tager fejl, og curatoren har ingen data om hvilke spørgsmål der ikke kunne besvares korrekt.

## Solution

En 👎 (thumbs down) knap i chat widgetten der:
1. Åbner en modal med textarea: "Hvad var galt?" + valgfri kategorier (forkert info, manglende info, irrelevant, andet)
2. Ved submit: POSTer til `/api/v1/queue/candidates` med `kind: 'reader_feedback'`
3. Candidate indeholder: fuld chat-kontekst (spørgsmål + svar + citations), brugerens feedback tekst, kategori, side-URL
4. Curatoren ser feedback i queue'en med "Se chat-kontekst" knap der viser den originale samtale

## Technical Design

### 1. Feedback Candidate Schema

```typescript
// packages/shared/src/reader-feedback.ts

export interface ReaderFeedbackMetadata {
  connector: 'reader-feedback';
  /** The user's question */
  question: string;
  /** The AI's answer (HTML) */
  answer: string;
  /** Citations from the answer */
  citations: ChatCitation[];
  /** User's feedback text */
  feedback: string;
  /** Feedback category */
  category: 'wrong-info' | 'missing-info' | 'irrelevant' | 'other';
  /** Page URL where the widget was embedded */
  pageUrl: string;
  /** KB and tenant context */
  kbId: string;
  tenantId: string;
  /** Chat session ID for reference */
  sessionId: string;
  /** Timestamp */
  submittedAt: string;
}
```

### 2. Widget Feedback UI

```typescript
// apps/widget/src/components/feedback-modal.tsx

import { h } from 'preact';
import { useState } from 'preact/hooks';

interface FeedbackModalProps {
  question: string;
  answer: string;
  citations: ChatCitation[];
  sessionId: string;
  onSubmit: (feedback: string, category: string) => Promise<void>;
  onClose: () => void;
}

export function FeedbackModal({ question, answer, citations, sessionId, onSubmit, onClose }: FeedbackModalProps) {
  const [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState('wrong-info');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!feedback.trim()) return;
    setSubmitting(true);
    await onSubmit(feedback, category);
    setSubmitting(false);
    onClose();
  };

  return h('div', { class: 'feedback-modal-overlay', onClick: onClose }, [
    h('div', { class: 'feedback-modal', onClick: (e) => e.stopPropagation() }, [
      h('h3', {}, 'Hvad var galt?'),

      h('div', { class: 'feedback-categories' }, [
        h('label', {}, [
          h('input', { type: 'radio', name: 'category', value: 'wrong-info', checked: category === 'wrong-info', onChange: () => setCategory('wrong-info') }),
          'Forkert information',
        ]),
        h('label', {}, [
          h('input', { type: 'radio', name: 'category', value: 'missing-info', checked: category === 'missing-info', onChange: () => setCategory('missing-info') }),
          'Manglende information',
        ]),
        h('label', {}, [
          h('input', { type: 'radio', name: 'category', value: 'irrelevant', checked: category === 'irrelevant', onChange: () => setCategory('irrelevant') }),
          'Irrelevant svar',
        ]),
        h('label', {}, [
          h('input', { type: 'radio', name: 'category', value: 'other', checked: category === 'other', onChange: () => setCategory('other') }),
          'Andet',
        ]),
      ]),

      h('textarea', {
        class: 'feedback-textarea',
        value: feedback,
        onInput: (e) => setFeedback((e.target as HTMLTextAreaElement).value),
        placeholder: 'Beskriv hvad der var galt...',
        rows: 4,
      }),

      // Show chat context summary
      h('details', { class: 'feedback-context' }, [
        h('summary', {}, 'Se chat-kontekst'),
        h('div', { class: 'context-question' }, h('strong', {}, 'Spørgsmål:'), ' ', question),
        h('div', { class: 'context-answer' }, h('strong', {}, 'Svar:'), ' ', answer.slice(0, 200) + '...'),
        citations.length > 0 && h('div', { class: 'context-citations' },
          'Citations: ', citations.map((c) => c.label).join(', ')
        ),
      ]),

      h('div', { class: 'feedback-actions' }, [
        h('button', { class: 'btn btn-secondary', onClick: onClose }, 'Annuller'),
        h('button', {
          class: 'btn btn-primary',
          disabled: !feedback.trim() || submitting,
          onClick: handleSubmit,
        }, submitting ? 'Sender...' : 'Send feedback'),
      ]),
    ]),
  ]);
}
```

### 3. Widget Integration

```typescript
// apps/widget/src/trail-chat.ts — add feedback button

import { FeedbackModal } from './components/feedback-modal.js';

// In the chat message component:
function ChatMessage({ message, onFeedback }: { message: ChatMessage; onFeedback: () => void }) {
  return h('div', { class: 'chat-message' }, [
    h('div', { class: 'message-content', dangerouslySetInnerHTML: { __html: message.answer } }),
    h('div', { class: 'message-actions' }, [
      h('button', {
        class: 'feedback-btn',
        title: 'Dette svar var ikke hjælpsomt',
        onClick: onFeedback,
      }, '👎'),
    ]),
  ]);
}
```

### 4. Server Endpoint (reuse queue API)

```typescript
// apps/server/src/routes/queue.ts — add reader feedback candidate creation

// POST /api/v1/queue/reader-feedback
// Uses existing POST /api/v1/queue/candidates endpoint with kind='reader_feedback'

const feedbackActions = [
  { id: 'create-source', label: 'Opret kilde baseret på feedback', effect: 'create-source' },
  { id: 'edit-neuron', label: 'Rediger neuron', effect: 'edit' },
  { id: 'dismiss', label: 'Afvis feedback', effect: 'dismiss' },
];

// In the queue candidate creation handler:
if (candidateKind === 'reader_feedback') {
  const metadata: ReaderFeedbackMetadata = {
    connector: 'reader-feedback',
    question: body.question,
    answer: body.answer,
    citations: body.citations,
    feedback: body.feedback,
    category: body.category,
    pageUrl: body.pageUrl,
    kbId,
    tenantId,
    sessionId: body.sessionId,
    submittedAt: new Date().toISOString(),
  };

  // Create candidate with reader_feedback kind
  await trail.db.insert(queueCandidates).values({
    id: crypto.randomUUID(),
    tenantId,
    knowledgeBaseId: kbId,
    kind: 'reader_feedback',
    status: 'pending',
    title: `Feedback: ${body.category} — ${body.question.slice(0, 80)}`,
    body: body.feedback,
    actions: JSON.stringify(feedbackActions),
    metadata: JSON.stringify(metadata),
    autoApproved: false,
  }).run();
}
```

### 5. Admin Queue Card for Reader Feedback

```typescript
// apps/admin/src/components/queue-card.tsx — reader_feedback rendering

// When candidate.kind === 'reader_feedback':
const meta = candidate.metadata as ReaderFeedbackMetadata;

h('div', { class: 'feedback-card' }, [
  h('div', { class: 'feedback-category-badge', `data-category=${meta.category}` },
    categoryLabels[meta.category]
  ),
  h('div', { class: 'feedback-question' }, [
    h('strong', {}, 'Spørgsmål: '),
    meta.question,
  ]),
  h('div', { class: 'feedback-answer' }, [
    h('strong', {}, 'AI svar: '),
    h('div', { dangerouslySetInnerHTML: { __html: meta.answer } }),
  ]),
  h('div', { class: 'feedback-user-text' }, [
    h('strong', {}, 'Bruger feedback: '),
    meta.feedback,
  ]),
  meta.citations?.length > 0 && h('div', { class: 'feedback-citations' }, [
    h('strong', {}, 'Citations: '),
    meta.citations.map((c) => h('a', { href: c.url }, c.label)).join(', '),
  ]),
  h('div', { class: 'feedback-source' }, [
    h('small', {}, `Fra: ${meta.pageUrl}`),
  ]),
]);
```

### 6. CSS for Feedback UI

```css
/* apps/widget/src/styles/feedback.css */

.feedback-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 4px 8px;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.feedback-btn:hover {
  opacity: 1;
}

.feedback-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.feedback-modal {
  background: var(--bg);
  border-radius: 12px;
  padding: 24px;
  max-width: 480px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
}

.feedback-categories {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}

.feedback-textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
}

.feedback-context {
  margin: 12px 0;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
  font-size: 12px;
}

/* Admin queue card styles */
.feedback-category-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
}

.feedback-category-badge[data-category="wrong-info"] {
  background: #fef2f2;
  color: #dc2626;
}

.feedback-category-badge[data-category="missing-info"] {
  background: #fefce8;
  color: #ca8a04;
}

.feedback-category-badge[data-category="irrelevant"] {
  background: #f0f9ff;
  color: #0284c7;
}
```

## Impact Analysis

### Files created (new)
- `packages/shared/src/reader-feedback.ts` — feedback metadata types
- `apps/widget/src/components/feedback-modal.tsx` — feedback modal UI
- `apps/widget/src/styles/feedback.css` — feedback styling
- `apps/admin/src/styles/feedback.css` — admin queue card styling for feedback

### Files modified
- `apps/widget/src/trail-chat.ts` — add 👎 button + modal integration
- `apps/server/src/routes/queue.ts` — handle reader_feedback candidate kind
- `apps/admin/src/components/queue-card.tsx` — render reader_feedback cards
- `packages/shared/src/connectors.ts` — add `reader-feedback` connector

### Downstream dependents for modified files

**`apps/server/src/routes/queue.ts`** is imported by 8 files (see grep results):
- `apps/server/src/app.ts` (1 ref) — mounts route, unaffected
- `apps/server/src/routes/documents.ts` (1 ref) — references queue types, unaffected
- `apps/server/src/routes/graph.ts` (1 ref) — references queue for graph data, unaffected
- `apps/server/src/routes/stream.ts` (1 ref) — broadcasts queue events, unaffected
- `apps/server/src/routes/knowledge-bases.ts` (1 ref) — references queue counts, unaffected
- `apps/server/src/routes/work.ts` (1 ref) — references queue, unaffected
- `apps/server/src/routes/chat.ts` (1 ref) — references queue, unaffected
- `apps/server/src/routes/lint.ts` (1 ref) — references queue, unaffected
Adding `reader_feedback` candidate kind is additive — existing candidate types unaffected.

**`apps/admin/src/panels/queue.tsx`** is imported by 1 file (1 ref):
- `apps/admin/src/app.tsx` (1 ref) — renders queue panel, unaffected by adding feedback card rendering

### Blast radius
- Feedback button is always visible on chat messages — may increase noise if users spam it
- Reader feedback candidates accumulate in queue — need auto-dismiss policy for low-value feedback
- Chat context stored in metadata can be large — consider truncating answer to first 2000 chars
- Widget CSS is self-contained — no impact on host page styles

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Feedback modal renders with correct categories
- [ ] Unit: Feedback submission creates correct metadata structure
- [ ] Integration: 👎 button opens modal in widget
- [ ] Integration: Submit feedback → candidate appears in queue with correct kind
- [ ] Integration: Admin queue card shows question, answer, feedback, category badge
- [ ] Integration: "Se chat-kontekst" expands to show full conversation
- [ ] Manual: Feedback from embedded widget on external site reaches Trail queue
- [ ] Regression: Chat without feedback button works unchanged
- [ ] Regression: Existing queue candidate types render unchanged

## Implementation Steps

1. Create `packages/shared/src/reader-feedback.ts` with metadata types
2. Create `apps/widget/src/components/feedback-modal.tsx` with modal UI
3. Add 👎 button to chat message component in widget
4. Add feedback CSS to widget
5. Add `reader-feedback` connector to connectors registry
6. Handle `reader_feedback` candidate kind in queue route
7. Add reader_feedback rendering to admin queue card
8. Add admin CSS for feedback category badges
9. Integration test: widget feedback → queue → admin display
10. Polish: animation, error handling, rate limiting (1 feedback per session)

## Dependencies

- F29 (Trail Chat Widget) — feedback is a widget feature
- F95 (Connectors) — `reader-feedback` connector for attribution
- F90 (Dynamic Curator Actions) — feedback candidates use F90 actions

## Effort Estimate

**Small** — 1-2 days

- Day 1: Widget feedback modal + 👎 button + CSS + server endpoint
- Day 2: Admin queue card rendering + integration testing + polish
