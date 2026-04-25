# F47 — Audio Transcription Pipeline

> **Status: Shipped 2026-04-25.** OpenAI Whisper-1 audio-pipeline drop-in via F28 registry. `apps/server/src/services/transcription.ts` wrapper sender audio til `https://api.openai.com/v1/audio/transcriptions` med `response_format=verbose_json` for at få duration + auto-detected language. Cost beregnet som `duration_seconds × 0.01¢/sec`, rounded up, stamped på `documents.extract_cost_cents`. Per-tenant API-key via `tenant_secrets.openai_api_key` (F149-pattern), fallback til `process.env.OPENAI_API_KEY`. Verified live mod Sanne's `Dit_3_minutters_pusterum.wav` (3 min dansk meditation): 1248 chars korrekt transkription, 2¢ cost, sub-15s Whisper response. uploads.ts udvidet med audio-extensions + `transcribeAudio` callback wired ind i dispatch — F28-vinden bekræftet. Plus: `scripts/trail` launcher fixet til at source root `.env` så provider-keys er synlige for engine-process. Verification: `apps/server/scripts/verify-f47-audio-pipeline.ts` — 7 asserts grønne.
>
> Accepter audio-filer (.wav, .mp3, .m4a, .ogg, .flac) som sources. Audio sendes til OpenAI Whisper for transkription → markdown med tale-til-tekst → wiki page. Cost stamped på `documents.extract_cost_cents` for F156 credits-deduktion. Tier: Phase 1 · Effort: Small · Status: Planned.

## Problem

Trail accepterer i dag tekst, dokumenter (PDF/DOCX/PPTX/XLSX) og billeder (efter F25). Mange kilder er **lyd**: podcasts, interviews, klient-konsultationer (Sanne's healthcare-domæne), forelæsninger, Voice Memos fra iPhone, mobile recordings. I dag kan en bruger ikke uploade en `.wav` eller `.mp3` og få den transcriberet til søgbar viden.

Sanne's konkrete eksempel: hun optager guided meditation-sessioner som `.wav` (3-15 minutter dansk tale, evt. med musik i bunden). Uden audio-pipeline er der ingen vej til at gøre disse opnåelige som Neuron-content.

## Secondary Pain Points

- **Ingen vej til Voice Memos.** F147 Share Extension (mobile) vil sende lyd-filer fra iPhone Voice Memos, men uden F47 har modtager-siden intet at gøre med dem.
- **Manglende dansk-support.** Dansk er en lille sprog-marked; mange transcription-tjenester degraderer kvalitet for dansk. Whisper-large-v3 er state-of-the-art for dansk og bag flere kommercielle tjenester.
- **Cost-uforudsigelighed for tenants.** Uden F47-cost-tracking + F156 credits ville en uvidende bruger kunne uploade 10 timers podcast-batch og bombe vores LLM-budget.

## Solution

Drop-in pipeline via F28 registry. Audio sendes til OpenAI Whisper (`https://api.openai.com/v1/audio/transcriptions`) med `model: 'whisper-1'`. Returnerer plain text, hvor vi wrapper i en markdown-shell med metadata (filename, duration, language). Cost beregnes som `duration_seconds × $0.006/60 = $0.0001/sec` og stamples på `documents.extract_cost_cents`.

Provider-valget: **OpenAI Whisper-1** som default fordi:
- Højeste dansk-kvalitet i evidens-baserede sammenligninger (april 2026)
- Rimelig pris ($0.006/min) — sub-1¢ for typiske 1-3 min recordings
- Ingen separat audio-billing (samme OpenAI-konto kan bruges til andre formål)
- Industri-standard format der gør migration til andre providere triviel

Future: åbn for Deepgram (real-time + bedre diarization) eller AssemblyAI (chapter-detection + sentiment) som per-tenant valg når en kunde efterspørger det.

## Non-Goals

- **Diarization (hvem-siger-hvad).** Whisper-1 producerer en flad tekst uden speaker-labels. Når en kunde har brug for det → tilføj Deepgram eller AssemblyAI som pluggable provider, ikke som default-upgrade.
- **Real-time transcription.** Trail's audio-flow er batch-only. Live-stream er F46 video's territorium hvis vi nogensinde lander det.
- **Audio editing eller noise-reduction.** Vi sender filen som-uploaded til Whisper. Hvis kvalitet er dårlig pga støj, er det brugerens ansvar at clean'e først.
- **Audio playback i Trail-readeren.** F25 SVG vises inline; F47 audio gør ikke det samme. Audio-bytes ligger i storage, kan downloades, men reader-viewen viser kun transcription-tekst. Future feature hvis ønsket.
- **Auto-summary efter transcription.** Pipelinen producerer transcription-text. F06 ingest-pipeline kører bagefter og compiler den til Neurons med summary-kvalitet. Ingen separat audio-summary step.
- **Per-segment timestamps inline.** Whisper API returnerer timestamps når vi beder om `response_format=verbose_json`, men de bloater markdown'en og ingest-pipelinen bruger dem ikke. Default = plain text. Per-tenant opt-in til segment-format hvis nogen ønsker det.
- **Live progress-bar under transcription.** Whisper API er synkron — 3-min audio tager ~10-30 sek. Brugeren ser standard processing-spinner, ingen percent-meter.

## Technical Design

### Whisper API call

```typescript
// apps/server/src/services/transcription.ts

const OPENAI_AUDIO_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'whisper-1';
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS ?? 180_000);

// $0.006/minute = $0.0001/second = 0.01 cent/second
const WHISPER_CENT_PER_SECOND = 0.01;

export interface TranscriptionResult {
  text: string;
  language: string;            // ISO-639-1, from Whisper's auto-detection
  durationSeconds: number;
  costCents: number;
  model: string;
}

export async function transcribeAudio(
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<TranscriptionResult | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json'); // for duration + language

  const res = await fetch(OPENAI_AUDIO_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json() as {
    text: string;
    language?: string;
    duration?: number;
  };

  const durationSeconds = data.duration ?? 0;
  return {
    text: data.text,
    language: data.language ?? 'unknown',
    durationSeconds,
    costCents: Math.ceil(durationSeconds * WHISPER_CENT_PER_SECOND),
    model: WHISPER_MODEL,
  };
}
```

### Audio pipeline

```typescript
// packages/pipelines/src/audio/pipeline.ts

export const audioPipeline: Pipeline = {
  name: 'audio',
  accepts: (filename, mime) => {
    if (mime?.startsWith('audio/')) return 1;
    if (/\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(filename)) return 0.95;
    return 0;
  },
  handle: async (input) => {
    if (!input.transcribeAudio) {
      throw new Error('[audio-pipeline] requires transcribeAudio callback');
    }
    const result = await input.transcribeAudio(input.buffer, input.filename, input.mime);
    if (!result) throw new Error('[audio-pipeline] transcription returned null (missing OPENAI_API_KEY?)');

    const stem = input.filename.replace(/\.[a-z0-9]+$/i, '');
    const minutes = Math.round(result.durationSeconds / 60 * 10) / 10;
    const markdown = `# ${stem}

**Type:** Audio recording (transcription)
**Varighed:** ${minutes} minut${minutes === 1 ? '' : 'ter'}
**Sprog:** ${result.language}

---

${result.text}
`;

    return {
      markdown,
      title: stem,
      warnings: [],
      extractCostCents: result.costCents,
      extractModel: result.model,
    };
  },
};
```

### Pipeline-input extension

```typescript
// packages/pipelines/src/interface.ts

export interface PipelineInput {
  // ... existing fields
  transcribeAudio?: (
    buffer: Buffer,
    filename: string,
    contentType?: string,
  ) => Promise<{
    text: string;
    language: string;
    durationSeconds: number;
    costCents: number;
    model: string;
  } | null>;
}
```

### Wire-up in uploads.ts

The orchestrator passes `transcribeAudio` callback to dispatch — same pattern as `describeImageAsSource` for F25. Allowed-extensions list adds `wav`, `mp3`, `m4a`, `ogg`, `flac`, `aac`.

### File-size limit

Whisper-1 max upload = 25MB per request. For larger files (long lectures, audiobooks) we error gracefully with a clear message: *"Audio file exceeds 25MB Whisper limit — split via Audacity or wait for chunked-upload (F47b)."* Chunked-upload + reassembly is a follow-up feature, not F47 v1.

### Per-tenant API key

Per F149's `tenant_secrets` pattern, the orchestrator first checks `tenant_secrets.openai_api_key` (encrypted) before falling back to `process.env.OPENAI_API_KEY`. Production tenants bring their own keys; dev tenant uses Christian's shared key.

## Interface

### Endpoints

No new endpoints — `POST /api/v1/knowledge-bases/:kbId/documents/upload` accepts audio MIME-types after the allowed-list extension.

### Shared types

```typescript
// packages/pipelines/src/interface.ts (extension)
export type TranscribeAudio = (
  buffer: Buffer,
  filename: string,
  contentType?: string,
) => Promise<TranscriptionResult | null>;

export interface TranscriptionResult {
  text: string;
  language: string;
  durationSeconds: number;
  costCents: number;
  model: string;
}
```

## Rollout

**Single-phase.** F47 lands as a drop-in pipeline. No migration (extract_cost_cents column already exists from F25 migration 0018). No new tables. Existing F156 plan covers audio-credit-deduction the same way as image-credit-deduction.

## Success Criteria

1. **3-min Danish WAV transcribes correctly.** Sanne's `Dit_3_minutters_pusterum.wav` (180s) transcribes to coherent Danish text with no missed sentences.
2. **Cost stamped accurately.** `documents.extract_cost_cents` for the above ≈ 2¢ (180s × 0.01¢/sec, rounded up).
3. **Whisper API errors surface to curator.** Bad audio file → status='failed' with the API error message, not a silent zero-content row.
4. **F28 win demonstrated.** uploads.ts touched only to add allowed extensions + transcribeAudio callback wire-up — no per-format if-block (per F28's contract).
5. **End-to-end via verify script.** `bun run apps/server/scripts/verify-f47-audio-pipeline.ts` posts the test fixture, asserts status='ready', content > 500 chars, cost in 1-5¢ range.

## Impact Analysis

### Files created (new)

- `packages/pipelines/src/audio/pipeline.ts` — Pipeline implementation
- `apps/server/src/services/transcription.ts` — Whisper API client
- `apps/server/scripts/verify-f47-audio-pipeline.ts` — end-to-end probe
- `apps/server/test-fixtures/sanne-pusterum.wav` — test asset (copied from `~/Documents/Projects/Sanne Andersen/SOUND/Dit_3_minutters_pusterum.wav`)
- `docs/features/F47-audio-transcription-pipeline.md` (this document)

### Files modified

- `packages/pipelines/src/index.ts` — register audioPipeline
- `packages/pipelines/src/interface.ts` — add TranscribeAudio callback type
- `apps/server/src/routes/uploads.ts` — extend ALLOWED_EXTENSIONS + IMAGE_TIMEOUT_MS sibling AUDIO_TIMEOUT_MS + wire transcribeAudio into dispatch
- `docs/FEATURES.md` + `docs/ROADMAP.md` — mark F47 Done
- `.env` — add OPENAI_API_KEY (already set; documented in this doc)

### Downstream dependents

- `packages/pipelines/src/index.ts` — no consumer changes; one new `registerPipeline()` call.
- `apps/server/src/routes/uploads.ts` — touched but pattern-matches F25's approach; recover-pending-sources.ts auto-handles audio because RECOVERABLE_EXTENSIONS already pulls from registered pipelines.

### Blast radius

- **OpenAI rate limits.** Whisper-1 default = 50 RPM per key. Christian's key is shared with other tools; if it hits rate-limit, Trail audio uploads return 429. Mitigation: per-tenant key in `tenant_secrets` (already supported via F149 pattern).
- **25MB upload cap.** Files larger than that fail with API-level 400. Mitigation: clear error message; chunking is a follow-up.
- **Audio storage cost.** WAVs are 16MB for 3 minutes; bigger files mean meaningful storage cost. F156 credits-tracking covers LLM cost; storage cost remains absorbed in tier subscription. Acceptable until any single tenant uploads gigabytes of raw WAV.

### Breaking changes

None. New extensions added to the allowed list.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: `transcribeAudio` returns null when OPENAI_API_KEY unset
- [ ] Unit: cost calculation: 60s → 1¢, 180s → 2¢ (rounded up from 1.8)
- [ ] Integration: upload Sanne's 3-min WAV → status='ready' within 60s → content has Danish text > 500 chars → extract_cost_cents in [1, 5]
- [ ] Integration: upload bad-audio file (truncated header) → status='failed' with Whisper error
- [ ] Integration: upload .mp3 + .m4a (different containers) — both succeed
- [ ] Manual: Drag-and-drop WAV in admin UI → see pending → ready → expand source → see transcription
- [ ] Regression: F25 image upload still works (same dispatch path)
- [ ] Regression: F08 PDF still works

## Implementation Steps

1. Add `OPENAI_API_KEY` to `.env` (already done) + document the pricing source in `apps/server/src/services/transcription.ts`.
2. Create `transcription.ts` service with Whisper API client + cost calculator.
3. Extend `PipelineInput` with `transcribeAudio` callback + matching type.
4. Create `packages/pipelines/src/audio/pipeline.ts` and register it in `packages/pipelines/src/index.ts`.
5. Wire `transcribeAudio` into `dispatch()` call in `apps/server/src/routes/uploads.ts`. Add audio extensions to `ALLOWED_EXTENSIONS`. Add `AUDIO_TIMEOUT_MS = 180_000`.
6. Write `apps/server/scripts/verify-f47-audio-pipeline.ts` mirroring F25's probe.
7. Copy Sanne's wav into `apps/server/test-fixtures/sanne-pusterum.wav` for repeatability.
8. Run probe + manual UI smoke test.

## Dependencies

- **F28** Pipeline Interface — F47 is a Pipeline; pre-F28 it'd require touching uploads.ts heavily
- **F25** prep work — extract_cost_cents column already lands in migration 0018
- **F156 (Planned)** Credits-Based Metering will deduct on the cost stamped here

## Open Questions

1. **Storage of original audio bytes after transcription.** Keep forever? Auto-delete after 30 days to save space? Recommend: keep — same as PDF/image policy. Audit-trail value.
2. **Should Whisper auto-language-detect or force `language: 'da'`?** Sanne's content is Danish; auto-detect is robust but fails to catch Danish-with-English-loanwords misdetected as English. Recommend: auto-detect for v1, add per-KB override later.
3. **`response_format=verbose_json` exposes segment-timestamps. Discard?** Yes for v1 — markdown stays clean. If a future feature needs segment-anchors (audiobook chapter-jumping), revisit.
4. **What if an uploaded audio is silent / sub-1-second?** Whisper-1 charges minimum 1¢ regardless. Curator pays the floor for trash inputs. Acceptable; cheap enough not to over-engineer.

## Related Features

- **Depends on:** F28, F25 (extract_cost_cents column)
- **Enables:** F46 Video pipeline (extracts audio track + uses F47 to transcribe), F147 Share Extension (mobile audio uploads)
- **Cross-cuts:** F156 Credits-Based Metering, F151 Cost Dashboard

## Effort Estimate

**Small** — 0.5-1 day.

- Service + pipeline + wire-up: 2-3 hours
- Verify script + fixture: 1 hour
- Manual UI smoke + edge-case tests: 1 hour
