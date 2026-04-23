# F57 — Gap Suggestions from Low-Confidence Queries

> Low-confidence chat queries creates `gap_suggestion` candidates: "This query had no good answer. Consider adding a source on X." Curator sees gaps sorted by query frequency — user questions become the content roadmap.

## Problem

Når brugere chatter med Trail og får et svar med lav confidence (få eller ingen relevante Neurons fundet), ved curatoren ikke at der er et gap i wiki'en. Spørgsmålet forsvinder — men det repræsenterer en reel brugerbehov der ikke er dækket.

Karpathy's model har "gap detection" som en del af lint — AI finder områder hvor wiki'en er tynd. Men den mest værdifulde gap-data kommer fra faktiske bruger-spørgsmål, ikke fra AI-gætteri.

## Solution

Chat-endpointet evaluerer svar-confidence baseret på:
1. Antal fundne Neurons (0-2 = lav, 3-5 = medium, 6+ = høj)
2. FTS5 score af top matches
3. LLM's egen confidence (hvis tilgængelig)

Når confidence er under threshold, oprettes en `gap_suggestion` candidate med:
- Det originale spørgsmål
- Antal fundne Neurons
- Foreslået emne (LLM-extraheret fra spørgsmålet)
- Query frequency (hvor mange gange dette emne er blevet spurgt om)

## Technical Design

### 1. Confidence Evaluation

```typescript
// packages/core/src/chat/confidence.ts

export interface ConfidenceResult {
  score: number; // 0-1
  level: 'low' | 'medium' | 'high';
  reason: string;
  neuronCount: number;
  topScore: number;
}

export function evaluateConfidence(
  searchResults: SearchResult[],
  llmConfidence?: number,
): ConfidenceResult {
  const neuronCount = searchResults.length;
  const topScore = searchResults[0]?.score ?? 0;

  // Base score from search results
  let score = 0;
  if (neuronCount >= 6) score += 0.4;
  else if (neuronCount >= 3) score += 0.25;
  else if (neuronCount >= 1) score += 0.1;

  // Score from FTS5 relevance
  if (topScore > 5) score += 0.3;
  else if (topScore > 3) score += 0.15;
  else if (topScore > 1) score += 0.05;

  // LLM confidence bonus
  if (llmConfidence !== undefined) {
    score += llmConfidence * 0.3;
  }

  score = Math.min(1, score);

  let level: ConfidenceResult['level'];
  let reason: string;

  if (score < 0.3) {
    level = 'low';
    reason = neuronCount === 0
      ? 'No relevant Neurons found'
      : `Only ${neuronCount} weakly relevant Neuron(s)`;
  } else if (score < 0.6) {
    level = 'medium';
    reason = `${neuronCount} Neuron(s) with moderate relevance`;
  } else {
    level = 'high';
    reason = `${neuronCount} highly relevant Neuron(s)`;
  }

  return { score, level, reason, neuronCount, topScore };
}
```

### 2. Gap Suggestion Creation

```typescript
// packages/core/src/chat/gap-suggestion.ts

import { queueCandidates } from '@trail/db';

export async function createGapSuggestion(
  trail: TrailDatabase,
  kbId: string,
  tenantId: string,
  question: string,
  confidence: ConfidenceResult,
  sessionId: string,
): Promise<void> {
  // Extract topic from question using simple keyword extraction
  const topic = extractTopic(question);

  // Check if similar gap already exists (dedup by topic)
  const existing = await trail.db
    .select()
    .from(queueCandidates)
    .where(and(
      eq(queueCandidates.knowledgeBaseId, kbId),
      eq(queueCandidates.kind, 'gap_suggestion'),
      eq(queueCandidates.status, 'pending'),
      like(queueCandidates.title, `%${topic}%`),
    ))
    .get();

  if (existing) {
    // Increment frequency counter
    const meta = existing.metadata as any;
    meta.frequency = (meta.frequency ?? 1) + 1;
    meta.lastAskedAt = new Date().toISOString();

    await trail.db
      .update(queueCandidates)
      .set({ metadata: JSON.stringify(meta) })
      .where(eq(queueCandidates.id, existing.id))
      .run();
    return;
  }

  // Create new gap suggestion
  await trail.db.insert(queueCandidates).values({
    id: crypto.randomUUID(),
    tenantId,
    knowledgeBaseId: kbId,
    kind: 'gap_suggestion',
    status: 'pending',
    title: `Gap: "${topic}" — ${confidence.reason}`,
    body: `Question: "${question}"\n\nConfidence: ${(confidence.score * 100).toFixed(0)}%\nNeurons found: ${confidence.neuronCount}\n\nConsider adding a source on this topic.`,
    actions: JSON.stringify([
      { id: 'add-source', label: 'Add source on this topic', effect: 'acknowledge' },
      { id: 'dismiss', label: 'Not a gap', effect: 'dismiss' },
    ]),
    metadata: JSON.stringify({
      connector: 'chat',
      topic,
      question,
      confidence: confidence.score,
      neuronCount: confidence.neuronCount,
      sessionId,
      frequency: 1,
      createdAt: new Date().toISOString(),
    }),
    autoApproved: false,
  }).run();
}

function extractTopic(question: string): string {
  // Simple keyword extraction: remove stop words, take first 3 significant words
  const stopWords = new Set(['what', 'how', 'why', 'when', 'where', 'who', 'is', 'are', 'the', 'a', 'an', 'do', 'does', 'can', 'could', 'would', 'should']);
  const words = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  const significant = words.filter((w) => w.length > 3 && !stopWords.has(w));
  return significant.slice(0, 3).join(' ') || question.slice(0, 50);
}
```

### 3. Integration with Chat Endpoint

```typescript
// apps/server/src/routes/chat.ts

import { evaluateConfidence, createGapSuggestion } from '@trail/core';

// After generating chat response:
const confidence = evaluateConfidence(searchResults, llmResponse.confidence);

// If low confidence, create gap suggestion
if (confidence.level === 'low') {
  await createGapSuggestion(trail, kbId, tenant.id, question, confidence, sessionId);
}

return c.json({
  answer: renderedAnswer,
  citations,
  confidence: confidence.score,
  sessionId,
});
```

### 4. Gap Dashboard in Admin

```typescript
// apps/admin/src/components/gap-list.tsx

// Show gaps sorted by frequency (most asked = highest priority)
const gaps = queueCandidates
  .filter((c) => c.kind === 'gap_suggestion' && c.status === 'pending')
  .sort((a, b) => (b.metadata.frequency ?? 1) - (a.metadata.frequency ?? 1));

gaps.map((gap) => {
  const meta = gap.metadata as any;
  return h('div', { class: 'gap-item' }, [
    h('span', { class: 'gap-topic' }, meta.topic),
    h('span', { class: 'gap-frequency' }, `${meta.frequency}x asked`),
    h('span', { class: 'gap-confidence' }, `${(meta.confidence * 100).toFixed(0)}%`),
    h('button', { onClick: () => handleAddSource(meta.topic) }, 'Add source'),
  ]);
});
```

## Impact Analysis

### Files created (new)
- `packages/core/src/chat/confidence.ts` — confidence evaluation
- `packages/core/src/chat/gap-suggestion.ts` — gap suggestion creation
- `packages/core/src/chat/__tests__/confidence.test.ts`
- `apps/admin/src/components/gap-list.tsx` — gap list component

### Files modified
- `apps/server/src/routes/chat.ts` — evaluate confidence + create gap suggestions
- `packages/core/src/index.ts` — export chat modules

### Downstream dependents for modified files

**`apps/server/src/routes/chat.ts`** — adding gap suggestion is additive. Existing chat flow unchanged.

### Blast radius
- Gap suggestions accumulate in queue — need auto-dismiss for low-frequency gaps
- Topic extraction is simple (keyword-based) — may produce noisy topics
- Dedup by topic similarity prevents duplicate gaps for same question

### Breaking changes
None.

### Test plan
- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `evaluateConfidence` returns low for 0 results
- [ ] Unit: `evaluateConfidence` returns high for 6+ results with good scores
- [ ] Unit: `extractTopic` removes stop words correctly
- [ ] Integration: Low-confidence chat → gap suggestion created in queue
- [ ] Integration: Same question asked twice → frequency incremented, not duplicated
- [ ] Integration: Gap list shows gaps sorted by frequency
- [ ] Regression: High-confidence chat does NOT create gap suggestion

## Implementation Steps

1. Create confidence evaluation module + unit tests
2. Create gap suggestion module with dedup logic
3. Integrate into chat endpoint
4. Create gap list component for admin
5. Integration test: chat with no results → gap appears in queue
6. Test dedup: same question asked multiple times → frequency increases

## Dependencies

- F32 (Lint Pass) — gap suggestions are a lint finding type
- F12 (Chat Endpoint) — gap detection happens during chat

## Effort Estimate

**Small** — 1-2 days

- Day 1: Confidence evaluation + gap suggestion logic + unit tests
- Day 2: Chat integration + admin gap list + testing
