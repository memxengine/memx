# F160 — Three-tier integration contract + audience-aware chat

> Trail's eksterne API-kontrakt formaliseres i tre lag der hver har sin egen LLM-cost-profil og use case: **Lag 1 retrieval** (rå Neurons + chunks, 0 LLM-kald på Trail-siden), **Lag 2 knowledge-prose** (faktuel prosa, 1 LLM-kald), **Lag 3 render-ready** (varm slutbruger-prosa, 1 LLM-kald). Orthogonal til lagene løber **audience-aksen** — `curator` / `tool` / `public` — der styrer prose-tonen når der er prose involveret. Per-KB kan curator overskrive persona-templates pr. audience. Plus: et nyt `packages/sdk` der giver consumers en typed klient i stedet for håndskrevet fetch-kode. Tier: alle tenants. Effort: Medium-Large — 2-3 dage. Status: Planned.

## Problem

Trail's eksisterende `POST /chat` blev designet til admin-curatoren. Når Sanne Andersen's site (første eksterne integrations-customer) hitter samme endpoint får hendes kunder svar der er klinisk, akademisk, name-dropper KB-filer, og leder til "Hvis du gerne vil vide mere om hvilke specifikke zoner og teknikker..." — modsat retning af det en kunde har brug for.

Eksempel — kundens spørgsmål "Jeg sover ikke godt" returnerer noget som:

> Ifølge Zoneterapi-databasen nævner [Zoneterapi](/kb/UUID/neurons/zoneterapi) at forbedret søvn er en af de reaktioner... Fra et zoneterapeutisk perspektiv betragtes typisk... manuelle trykteknikker, særligt sedativt tryk (1-2 minutter)... Hvis du gerne vil vide mere om hvilke specifikke zoner og teknikker...
>
> Kilder: zoneterapi.md, jing-grundlæggende-energi.md, rab-registrering.md

Tre lag af problemer i én svar-blok:

1. **Tone:** "Ifølge databasen", "Fra et zoneterapeutisk perspektiv betragtes" — Wikipedia-tone, distancerende.
2. **Wiki-link URL'er:** peger på admin-routes (`/kb/UUID/neurons/...`) der ikke findes på Sanne's site.
3. **Citations som råfilnavne:** "zoneterapi.md", "jing-grundlæggende-energi.md" — interne Trail-konventioner som kunden ikke skal se.

Men det er **ikke kun et tone-problem**. Det er et arkitektonisk problem: Trail's chat har **ÉN type konsument indbygget i prompt'en** (admin-curatoren), og enhver anden integration mister enten kvalitet eller bliver tvunget til at bygge en site-LLM-orchestrator der parser Trail's prosa tilbage til facts og omformulerer. Det er en LLM-kæde for meget.

Sammenlagt blokerer det:
- **Sanne's site-integration** (første reelle kunde-test af eksterne integrations).
- **F29 widget** (planlagt embeddable chat — vil have samme tone-problem).
- **F62 demo.trailmem.com** (public reference site — kan ikke vise admin-tone til besøgende).
- **F38 Cross-Trail Search + Chat på app.trailmem.com** (multi-tenant SaaS-product — ditto).

## Secondary Pain Points

- **2-LLM-cost.** Hvis consumer bygger sin egen orchestrator (site-LLM med booking + shop + KB-tool) sender vi 2 LLM-kald per brugerprompt: Trail's chat-LLM syntetiserer KB → site-LLM parser prosa tilbage og omformulerer. Dobbelt latens, dobbelt cost, information-loss i mellem.
- **Trail kan aldrig integrere udadtil.** Trail vil aldrig vide om Sanne's kalender, hendes shop-produkter, hendes priser, hendes kampagner. Det er site-orchestratorens job at sammensætte. Trail leverer KB-viden — den primitive — men prøver i dag at lade som om den er hele assistenten.
- **Vi har ingen kontrakt for cc-sessioner i andre repos.** Sanne-andersen-cc skal læse Trail's source for at finde ud af endpoint-shapes. INTEGRATION-API.md er en start, men der er ikke en typed klient man kan importere.
- **`/search` er ikke designet til ekstern integration.** Den findes (FTS5 + tag-filter + seqId lookup) og fungerer, men eksternt-orienterede consumers vil have token-budget-control, audience-baseret filtering, og en stabilere kontrakt-shape end "DocumentSearchHit" vores admin-UI tilfældigvis bruger.
- **Kein konsekvent way at strippe admin-only Neurons.** Heuristik-Neurons (F139) under `/neurons/heuristics/` skal nok ikke vises eksternt. Curator kan have markeret bestemte Neurons som "intern". Vi har intet filter-lag for det.

## Solution

To orthogonale akser der definerer hele kontrakten.

### Akse 1: Lag — output-struktur + LLM-cost

| Lag | Endpoint(s) | LLM på Trail | Output | Cost | Use case |
|---|---|---|---|---|---|
| **1. Retrieval** | `GET /search`, `POST /retrieve` | **0** | Top-K Neurons + chunks med titler + excerpts + paths | DB-cost only — ~free credits | Site-LLM-orchestratorer (Sanne med booking/shop/etc.) — lav cost, max fleksibilitet |
| **2. Knowledge-prose** | `POST /chat` | **1** (Flash default) | Faktuel prosa + strukturerede citations | ~0.1 credit/turn | Sites med LLM der vil have prose-grundlag i stedet for rå chunks |
| **3. Render-ready** | `POST /chat` | **1** (Flash el. Sonnet) | Varm, du-form, action-orienteret | ~0.1-1.5 credit/turn | Direkte widget-integration, ingen orchestrator |

Lag-valget styres af **endpoint** (ikke parameter). Det gør kontrakten klart synlig i URL'en og lader os shippe Lag 1 før Lag 2/3 har fuldt audience-arbejde færdig.

### Akse 2: Audience — prose-tone (kun relevant for Lag 2/3)

| Audience | Bruger | Tone | Wiki-link-håndtering | Citations | Default for |
|---|---|---|---|---|---|
| `curator` | Sanne i admin (fagperson) | Detaljeret, klinisk OK, name-dropper KB | Admin-paths bevares | Inline + struktureret | Session-cookie auth (admin-UI) |
| `tool` | Site-LLM-orchestrator | Faktuel, neutral, ingen tone-skin, ingen "vil du booke" | Stripped (ren tekst) | Kun strukturerede `citations[]` array | Bearer-auth uden eksplicit override |
| `public` | Slutbruger-kunde direkte | Varm, du-form, maks 3-4 sætninger, action-orienteret | Stripped eller `linkBase`-resolved | Skjult eller minimalt | Eksplicit `audience: "public"` |

Audience er en **request-parameter** på `/chat`, ikke en URL-konvention — så samme key kan bruge begge modes (et site kan have en widget-chat på `audience: "public"` og en research-tool i samme stack på `audience: "tool"`).

### Per-KB persona-overskrivning

Pr. KB kan curator nuancere `tool`- og `public`-audience-templates:

```sql
ALTER TABLE knowledge_bases ADD COLUMN chat_persona_tool TEXT;
ALTER TABLE knowledge_bases ADD COLUMN chat_persona_public TEXT;
```

For Sanne's KB sætter hun fx `chat_persona_public = "Du er Sanne Andersen, zoneterapeut i Aalborg. Booking: sanne-andersen.dk/book. Tone: varm, dansk, du-form."`. Det appendes til base-templaten. Default-templates er generiske og fungerer out-of-the-box for KB'er der ikke har persona sat.

`curator`-audience har ikke per-KB overskrivning — admin-tone er fælles på tværs af KB'er.

## Non-Goals

- **Lag 1 returnerer ikke prose.** Punktum. Hvis consumer vil have prose, brug Lag 2/3. Dette er hele værdien af layer-separation; vi skal ikke gradvist føje "lidt LLM-syntese" ind i `/search` fordi det er bekvemt.
- **Ingen JSON-schema for `audience: "tool"`.** Vi returnerer prosa, ikke structured facts. Site-LLM omformulerer prosa bedre end den humanizes en facts-array. Hvis consumer vil have JSON-schema, brug Lag 1 og lad deres LLM strukturere. Tilføjes evt. som `format: "facts"` flag senere kun hvis reel use-case opstår.
- **Ingen booking / shop / FAQ-tools på Trail-siden.** Trail er KB. Site-orchestrator integrerer mod Cal.com/Google Calendar/Shopify/etc. — ikke Trail.
- **Ingen `audience: "tool"` med tone-skin.** Hele pointen med tool-mode er at site-LLM'en kontrollerer tonen. Trail må ikke prøve at "hjælpe" ved at appendere "Vil du vide mere?" i tool-prosa.
- **Ingen runtime-skift mellem audiences i samme session.** En `chat_session` har samme audience hele vejen igennem. Hvis consumer skifter modus skal de starte ny session. Forhindrer at konversations-historik fra `tool`-mode kontaminerer en `public`-mode session med klinisk fagsprog.
- **Ingen public-keys.** API-keys er fortsat per-user (F111.1). Vi indfører ikke "anonymous public read-only keys" — for offentlig embedding skal man stadig få en key, og rate-limit håndteres via credits (F156).
- **SDK er ikke client-side i v1.** `packages/sdk` er Node/Bun-først (server-side fetches). Browser-kompatibel build-target tilføjes når F29 widget kræver det.
- **Ingen GraphQL.** REST + JSON er kontrakten. Det er stabilt, debuggable, browser-friendly, og enhver SDK-skabelon (TypeScript types) er triviel at generere. GraphQL ville være over-engineering for en KB-API.

## Technical Design

### Endpoint 1 — `GET /api/v1/knowledge-bases/:kbId/search` (existing)

Eksisterer allerede og fungerer. F160 ændringer:

- **Audience-filter:** ny query-param `?audience=curator|tool|public` (default `tool` for Bearer). Filtrerer hvilke Neurons der returneres:
  - `curator`: alt
  - `tool`: alt undtagen `/neurons/heuristics/*`, `/neurons/internal/*` og Neurons markeret med tag `internal`
  - `public`: ditto + filtrer på Neuron-type (kun "kanonisk" content, ingen lint-output, ingen meta-Neurons)
- **Token-budget:** `?max_chars=N` (default 2000) — total karakter-budget for alle excerpts kombineret. Hvis vi overskrider, prioriter højere-rank hits.
- **Stabil response shape:** vi promiser at `documents[]` og `chunks[]` shape ikke ændrer sig på en breaking måde uden `/v2/`. SeqId tilføjes som primær id (`seqId: "sanne_00000042"`) for stabile cross-session-references.
- **Audience-aware excerpts:** for `tool`/`public` strippes excerpt for admin-paths og wiki-link `[[]]` notation (consumer's LLM får ren tekst at arbejde med).

### Endpoint 2 — `POST /api/v1/knowledge-bases/:kbId/retrieve` (new)

Optimeret for context-stuffing i en site-LLM. Forskellen fra `/search`:
- Body i stedet for query-string (større `query`-felter, structured filters)
- Returnerer kun `chunks[]` med fuld content (op til `max_chars` token-budget) — dvs. site-LLM kan stuffe dem direkte ind i sin prompt uden et second-pass `read`-kald.
- Inkluderer `formattedContext: string` — alle chunks slået sammen i en pre-formatteret blok klar til at indsætte i system-prompt eller user-message.

```typescript
POST /api/v1/knowledge-bases/:kbId/retrieve
{
  query: "klienten sover ikke godt",
  audience: "tool",          // optional, default tool for Bearer
  maxChars: 2000,            // optional, default 2000
  topK: 5,                   // optional, default 5
  tagFilter: ["sleep"],      // optional, AND-semantics like /search
}

→ {
  chunks: [
    { documentId, seqId, title, neuronPath, content, headerBreadcrumb, rank }
  ],
  formattedContext: "## Zoneterapi\n\nZoneterapi arbejder...\n\n## Jing — grundlæggende energi\n\n...",
  totalChars: 1843,
  hitCount: 3
}
```

Dette er **det primære integrations-endpoint** for site-LLM-orchestratorer.

### Endpoint 3 — `POST /api/v1/chat` (existing — extended)

Tilføj `audience` parameter:

```typescript
POST /api/v1/chat
{
  message: "Jeg sover ikke godt",
  knowledgeBaseId: "sanne-andersen",
  sessionId?: string,
  audience?: "curator" | "tool" | "public"   // default: tool for Bearer, curator for session-cookie
}
```

Server-side template-resolution:

```typescript
// apps/server/src/services/chat/persona.ts
function resolveSystemPrompt(audience: Audience, kb: KnowledgeBase): string {
  const base = PERSONA_TEMPLATES[audience];  // markdown string
  const override = audience === 'curator' ? null : kb[`chatPersona${capitalize(audience)}`];
  if (!override) return base;
  return `${base}\n\n## KB-specific persona\n\n${override}`;
}
```

PERSONA_TEMPLATES lever som markdown-filer i `apps/server/src/data/personas/`:
- `chat-curator.md` — den nuværende prompt (lift-and-shift)
- `chat-tool.md` — ny: "Du udleder fakta fra KB. Skriv almindelig prosa. Aldrig 'ifølge databasen'. Aldrig kilder inline. Aldrig 'vil du booke'."
- `chat-public.md` — ny: "Du taler direkte til en kunde. Varm tone, du-form, maks 4 sætninger. Slut evt. med naturlig action-prompt."

Output-postprocessing per audience i `chat.ts`:

| Audience | Wiki-links | Kilder-sektion | Citations array |
|---|---|---|---|
| curator | rewrite til admin-paths (current behaviour) | bevar i prosa hvis LLM emitter | bevar |
| tool | strip til ren tekst (`[[Zoneterapi]]` → `Zoneterapi`) | strip "Kilder:"-sektion fra body | beriges m/ titles + excerpts |
| public | strip eller resolve via `linkBase`-param | strip "Kilder:"-sektion fra body | minimal — kun titles |

### SDK — `packages/sdk` → `@trailmem/sdk` på npm

Ny pnpm-workspace-pakke. NPM-org `@trailmem/` er reserveret af Christian (ægte `@trail/` var taget på npm). Layout:

```
packages/sdk/
├── package.json           — @trailmem/sdk, exports both ESM + CJS
├── src/
│   ├── client.ts          — TrailClient class
│   ├── types.ts           — alle response/request shapes
│   ├── search.ts          — search(opts) → SearchResponse
│   ├── retrieve.ts        — retrieve(opts) → RetrieveResponse
│   ├── chat.ts            — chat(opts) → ChatResponse
│   └── index.ts           — re-exports
├── tsconfig.json
└── README.md              — quick-start + 3 layer-eksempler
```

API-shape:

```typescript
import { TrailClient } from '@trailmem/sdk';

const trail = new TrailClient({
  baseUrl: 'https://app.trailmem.com',  // eller localhost:58021 i dev
  apiKey: process.env.TRAIL_API_KEY,
  knowledgeBaseId: 'sanne-andersen',
});

// Lag 1 — retrieval
const { chunks, formattedContext } = await trail.retrieve('klienten sover ikke godt');

// Lag 2 — knowledge-prose (default audience='tool')
const { answer, citations } = await trail.chat('Jeg sover ikke godt');

// Lag 3 — render-ready
const { answer, sessionId } = await trail.chat('Jeg sover ikke godt', { audience: 'public' });
```

Public types fanger turnsUsed/turnsLimit (F156 turn-cap), error-koder (`session_turn_cap_reached`), og audience-enum.

Built i monorepo via Turbo. Publishing til npm som `@trailmem/sdk` er **ikke** del af F160 v1 — det er en separat senere beslutning. Indtil da kan integrators i monorepo eller adjacent-monorepo importere via path-reference, eller npm-installere direkte fra GitHub.

### Trail integration-doc

`docs/INTEGRATION-API.md` udvides med (eller erstattes af):
- **Beslutningstræ** øverst: "Har du allerede en site-LLM? → Lag 1. Vil du have render-ready chat? → Lag 3. Imellem? → Lag 2."
- **3 sektioner** (én per lag) med fuld endpoint-spec, audience-matrix, eksempler.
- **Cost-eksempler** ("1000 chats/måned koster X credits på Lag 3, Y på Lag 2, Z på Lag 1").
- **Anti-patterns:** "Brug ikke Lag 2 hvis du allerede har site-LLM — det er bare ekstra omkostning."
- **`@trailmem/sdk` quick-start** når SDK-pakken lander.

## Rollout

Fasevis så vi får Sanne-andersen unblocked først.

### Phase 1 — Lag 1 retrieval (Day 1)

- [ ] `/search` audience-filter parameter
- [ ] `/retrieve` nyt endpoint med `formattedContext`
- [ ] Audience-baseret Neuron-filtering (heuristics, internal-tags ekskluderet for tool/public)
- [ ] Verify-script: roundtrip via Bearer, audience-filter virker, token-budget respekteres
- [ ] INTEGRATION-API.md Lag 1 sektion

**Christian giver besked til sanne-andersen-cc** at Lag 1 er klar. De kan begynde at bygge orchestrator mod `/retrieve`.

### Phase 2 — Lag 2/3 audience-aware chat (Day 2)

- [ ] Migration: `chat_persona_tool` + `chat_persona_public` på `knowledge_bases`
- [ ] Persona-templates: `chat-curator.md` (lift), `chat-tool.md` (new), `chat-public.md` (new)
- [ ] `audience` parameter på `POST /chat`
- [ ] Output-postprocessing per audience (wiki-link strip, "Kilder:"-strip)
- [ ] Per-KB persona-edit i admin Settings → Trail
- [ ] Verify-script: alle 3 audiences returnerer korrekt formede svar; per-KB override appendes til template
- [ ] INTEGRATION-API.md Lag 2/3 sektioner

### Phase 3 — SDK package (Day 3)

- [ ] `packages/sdk` scaffolded med pnpm-workspace + Turbo
- [ ] `TrailClient` med metoder for `search`, `retrieve`, `chat`
- [ ] Types-eksport for alle responses + audiences
- [ ] README.md quick-start + 3-layer-eksempler
- [ ] `apps/admin` skifter sin egen api.ts til at importere fra `@trailmem/sdk` (eat your own dogfood — fanger fejl tidligt)

### Phase 4 — Followups (out of v1 scope)

- npm publish af `@trailmem/sdk`
- Browser-bundle-target for F29 widget
- `format: "facts"` flag på chat hvis reel use-case opstår
- Per-key rate-limit på retrieve (F44 territorium)

## Dependencies

- F111.1 ✅ (Bearer-token auth)
- F111.2 ✅ (multi-origin CORS, admin API-key panel)
- F156 ✅ (credits — vi skal stadig stamp cost på Lag 2/3 chats)
- F159 ✅ (pluggable chat backends — vi skal kunne route audience+model gennem chain)
- Eksisterende `/search` ✅ (FTS5, tag-filter, seqId lookup)

## Verify plan

- **Lag 1 retrieval:** `/search` + `/retrieve` returnerer korrekte chunks scoped til tenant; audience=public filtrerer heuristik-Neurons væk; max_chars-budget respekteres; cross-tenant kbId returnerer 404.
- **Lag 2/3 chat:** alle 3 audiences returnerer prosa der matcher template-tone (LLM-as-judge eller manual spot-check med 5 test-prompts); per-KB persona-override appendes; tool/public-mode strip wiki-links og "Kilder:"-sektioner.
- **F156 cost stamping:** chat med `audience=tool` debiterer credits identisk med admin-chat (audience er en tone-shaper, ikke en cost-shaper).
- **SDK:** typecheck + en runtime-roundtrip-test der hitter alle 3 lag via klienten og asserterer response-shapes.

## Open questions

- **Skal Lag 1 fortsat scope per-KB eller åbne tværs af tenants KBs?** Nuværende `/search` scopes per kb-id i URL. For en site-LLM der laver tool-call kunne det være bekvemt at søge på tværs af alle tenant'ens KBs i én call. Beslut når F38 cross-Trail-search lander; v1 fortsat per-KB.
- **Skal `audience` på chat være en property på sessionen (locked first turn) eller per-request?** Plan-doc siger locked; men technically per-request giver mere fleksibilitet. Bekymring: en `tool`-session der pludselig får et `public`-svar vil have inkonsistent prose-historie i replay. Locked vinder for nu.
- **Skal `/retrieve` semantic search eller bare FTS5?** FTS5 er det vi har. Semantic embeddings kræver vector-DB-migration (Milvus, sqlite-vss, ...). Out of scope for F160; FTS5 + tag-filter rækker langt.

## Effort estimate

- Phase 1 (Lag 1): 0.5-1 dag
- Phase 2 (Lag 2/3): 1 dag
- Phase 3 (SDK): 0.5-1 dag
- I alt: **2-3 dage**

## Related Features

- **F111.1, F111.2** — Bearer auth + admin API-key panel + multi-origin CORS (foundation)
- **F156** — Credits-based metering (chat-cost stamping bevares for Lag 2/3)
- **F159** — Pluggable chat backends (audience-aware prompt går gennem samme chain)
- **F29** — `<trail-chat>` Embeddable Widget (vil bruge SDK'en, evt. browser-bundle)
- **F38** — Cross-Trail Search + Chat (cross-KB scoping af `/search` er det)
- **F44** — Usage Metering (per-key rate-limits, Phase 2 territorium)
