# F105 — Proactive Save Suggestions in Chat

*Planned. Tier: alle. Effort: 1 day.*

> Når chat-LLM'en producerer et svar der syntetiserer flere Neurons på ny måde, foreslår den **proaktivt**: "💡 Skal jeg gemme dette som Neuron 'X'?". Brugeren klikker Ja/Nej. Matcher Balu's query-workflow og forvandler Trail-chat fra "stil spørgsmål" til "opbyg compounding viden".

## Problem

Vi har i dag `saveChatAsNeuron`-knap i chat-panelet. Brugeren skal selv huske at klikke. Gode svar der kombinerer 4 kilder på nye måder forsvinder i chat-historik. Karpathy's pattern fremhæver at "good answers can be filed back into the wiki" — vores UX hjælper ikke brugeren med at gøre det systematisk.

## Solution

Chat-API's response-JSON udvides med valgfri `suggestedSave`:

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

LLM-prompten i `services/chat.ts` udvides til eksplicit at overveje save-suggestion efter hvert svar:

> "Efter du har produceret dit svar, overvej: syntetiserede du indhold på en ny måde? Blev flere Neurons forbundet? Hvis ja, foreslå save med en kort begrundelse. Hvis svaret bare er et direkte lookup, returnér `suggestedSave: null`."

Admin-UI rendrer suggestion som indbygget prompt under svaret med [Ja, gem] / [Nej] knapper.

## How

- Udvid ChatResponseSchema i `packages/shared/src/schemas.ts`
- Chat-prompt i `services/chat.ts` tilføjer suggestion-evaluation-trin
- Admin's ChatPanel rendrer suggestion-banner under svar
- Ja-klik kalder `saveChatAsNeuron` med LLM-foreslåede title+path
- Solo-mode auto-approver direkte; Curator-mode sender til queue

## Dependencies

- F106 (Solo-mode) — save-path adfærd afhænger af mode

## Success criteria

- LLM returnerer `suggestedSave` på ~30-50 % af svar (de syntetiserende ones)
- Brugeren klikker Ja på ≥60 % af suggestions (hvis lavere, prompt-tuning)
- Solo-mode auto-approver, Curator-mode sender til queue med pre-udfyldt title/path
