# F105 — Proactive Save Suggestions in Chat

> Når chat-LLM'en producerer et svar der syntetiserer flere Neurons på ny måde, foreslår den **proaktivt**: "💡 Skal jeg gemme dette som Neuron 'X'?". Brugeren klikker Ja/Nej. Matcher Balu's query-workflow og forvandler Trail-chat fra "stil spørgsmål" til "opbyg compounding viden". Tier: alle. Effort: Small (1 day). Status: Planned.

## Problem

Vi har i dag `saveChatAsNeuron`-knap i chat-panelet. Brugeren skal selv huske at klikke. Gode svar der kombinerer 4 kilder på nye måder forsvinder i chat-historik. Karpathy's pattern fremhæver at "good answers can be filed back into the wiki" — vores UX hjælper ikke brugeren med at gøre det systematisk.

## Secondary Pain Points

- Valuable synthesized knowledge is lost when users don't manually save.
- No signal to the system about which chat answers are worth preserving.
- Curator-mode users must navigate the queue to save; solo-mode users have no save path at all.

## Solution

Chat-API's response-JSON is extended with an optional `suggestedSave`:

```ts
interface ChatResponse {
  answer: string;
  citations: ChatCitation[];
  suggestedSave?: {
    title: string;          // LLM-foreslået title
    path: string;           // typisk '/neurons/analyses/' eller '/neurons/synthesis/'
    reason: string;         // "This synthesizes X, Y, Z from 4 different Neurons"
    confidence: number;     // 0-1, bruges til UI-prioritering
  } | null;
}
```

The LLM prompt in `services/chat.ts` is extended to explicitly consider save-suggestion after each answer:

> "Efter du har produceret dit svar, overvej: syntetiserede du indhold på en ny måde? Blev flere Neurons forbundet? Hvis ja, foreslå save med en kort begrundelse. Hvis svaret bare er et direkte lookup, returnér `suggestedSave: null`."

Admin-UI renders the suggestion as an inline banner below the answer with [Ja, gem] / [Nej] buttons.

## Non-Goals

- Auto-saving without user confirmation (user always clicks Ja/Nej).
- Saving every chat answer (only synthesis-worthy answers get suggestions).
- Batch save suggestions (one suggestion per answer, not accumulated).
- Customizing the suggestion threshold per KB or per user.

## Technical Design

### ChatResponse schema extension

```ts
// packages/shared/src/schemas.ts
export const SuggestedSaveSchema = z.object({
  title: z.string(),
  path: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

export const ChatResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(ChatCitationSchema),
  suggestedSave: SuggestedSaveSchema.nullable().optional(),
});
```

### LLM prompt extension

The chat prompt in `services/chat.ts` adds a post-answer evaluation step:

```
After producing your answer, consider: did you synthesize content in a new way?
Were multiple Neurons connected? If yes, suggest a save with a brief rationale.
If the answer is just a direct lookup, return suggestedSave: null.
```

### Admin UI rendering

The ChatPanel renders a suggestion banner below the answer when `suggestedSave` is present:

```
💡 Skal jeg gemme dette som Neuron "Akupunktur vs. Fysioterapi"?
This synthesizes concepts from 4 different Neurons about treatment approaches.
[Ja, gem] [Nej]
```

Ja-click calls `saveChatAsNeuron` with LLM-suggested title+path. Solo-mode auto-approves directly; Curator-mode sends to queue.

## Interface

### Chat API response

```ts
// POST /api/v1/knowledge-bases/:kbId/chat
// Response:
{
  answer: string;
  citations: ChatCitation[];
  suggestedSave?: { title: string; path: string; reason: string; confidence: number } | null;
}
```

## Rollout

**Single-phase deploy.** The `suggestedSave` field is optional — existing chat clients that don't render it are unaffected. LLM prompt change takes effect immediately.

## Success Criteria

- LLM returns `suggestedSave` on ~30-50% of answers (the synthesizing ones).
- User clicks Ja on ≥60% of suggestions (if lower, prompt-tuning needed).
- Solo-mode auto-approves directly; Curator-mode sends to queue with pre-filled title/path.
- No regression in chat answer quality or latency.

## Impact Analysis

### Files created (new)

None.

### Files modified

- `packages/shared/src/schemas.ts` (add `SuggestedSaveSchema`, extend `ChatResponseSchema`)
- `apps/server/src/services/chat.ts` (add suggestion-evaluation step to LLM prompt)
- `apps/admin/src/components/chat-panel.tsx` (render suggestion banner + Ja/Nej buttons)

### Downstream dependents

`packages/shared/src/schemas.ts` — Central schema file. Adding `SuggestedSaveSchema` and extending `ChatResponseSchema` is additive; existing schema consumers are unaffected (new field is optional).

`apps/server/src/services/chat.ts` — Chat service. Adding suggestion-evaluation step changes LLM prompt but not the API surface. Downstream consumers (chat route, admin chat panel) receive the new optional field.

`apps/admin/src/components/chat-panel.tsx` — Admin chat panel. Rendering suggestion banner is additive; users without suggestions see no change.

### Blast radius

- LLM prompt change may increase token usage slightly (extra evaluation step).
- `suggestedSave` is optional — existing clients that don't render it are unaffected.
- Solo-mode auto-approve vs Curator-mode queue behavior depends on F106.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `SuggestedSaveSchema` validates correct payloads, rejects invalid ones
- [ ] Unit: chat prompt includes suggestion-evaluation step
- [ ] Integration: chat API returns `suggestedSave` for synthesis-worthy answers
- [ ] Integration: chat API returns `suggestedSave: null` for direct lookup answers
- [ ] Manual: admin ChatPanel renders suggestion banner with Ja/Nej buttons
- [ ] Manual: Ja-click saves Neuron with LLM-suggested title+path
- [ ] Regression: chat answer quality and latency unchanged for answers without suggestions

## Implementation Steps

1. Add `SuggestedSaveSchema` to `packages/shared/src/schemas.ts`, extend `ChatResponseSchema`.
2. Update chat prompt in `apps/server/src/services/chat.ts` to include suggestion-evaluation step.
3. Update admin ChatPanel in `apps/admin/src/components/chat-panel.tsx` to render suggestion banner + Ja/Nej buttons.
4. Wire Ja-click to call `saveChatAsNeuron` with LLM-suggested title+path (Solo: auto-approve, Curator: queue).
5. Test: verify `suggestedSave` appears on synthesis-worthy answers, not on direct lookups.

## Dependencies

- F106 (Solo-mode) — save-path behavior depends on mode (auto-approve vs queue)

## Open Questions

1. **Confidence threshold.** Should we only show suggestions above a certain confidence (e.g., 0.7)? Leaning: show all suggestions, let user decide.
2. **Suggestion frequency.** If LLM suggests saves too often, it becomes noise. Should we rate-limit suggestions per session? Leaning: no rate-limit for MVP, monitor and adjust.
3. **Custom paths.** Should users be able to edit the suggested path before saving? Leaning: yes, but out of scope for MVP.

## Related Features

- **F106** (Solo Mode) — save-path behavior depends on mode
- **F107** (Marp Slide Output) — LLM can suggest saving slides as Neuron
- **F17** (Curation Queue API) — Curator-mode saves go through queue

## Effort Estimate

**Small** — 1 day.

- Schema extension: 30 min
- Chat prompt update: 30 min
- Admin UI banner + buttons: 2 hours
- Wiring + testing: 2 hours
