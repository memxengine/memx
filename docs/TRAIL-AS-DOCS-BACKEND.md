# Trail som chat-motor for @webhouse/cms docs

*Tillæg til prissætnings-planen. Skrevet 2026-04-19, revideret samme dag efter scope-afklaring. Besvarer: hvordan bruger vi Trail som chat-engine bag docs.webhouse.app (og trail.broberg.dk) uden at @webhouse/cms behøver bygge sin egen RAG.*

## Scope-afklaring

**Trail driver ikke docs-sitet.** @webhouse/cms fortsætter som rendering-laget (SSG, CDN, custom theme, i18n, public access) — det virker, det er hurtigt, det er public. Ingen grund til at røre ved det.

**Trail er chat-motor bag kulissen.** I @webhouse/cms admin tilføjes et chat-panel. Brugeren (kurator / content-editor) kan stille spørgsmål til hele docs-korpussen og få svar med citations. Chat-panelet kalder Trail's `POST /api/v1/chat` med bearer-auth. Trail holder en synkroniseret kopi af alle docs og genererer svarene.

**Trail's core-værdi her:**
- FTS5-søgning er færdig (ingen need to build)
- Chat-API med citations og [[wiki-links]] er færdig
- Contradiction-lint fanger modsigelser på tværs af docs (fx når to docs siger forskellige ting om samme API)
- Curation-queue lader kurator kontrollere hvad der indekseres

**@webhouse/cms slipper for:** at bygge embedding-pipeline, vector-DB-drift, chunking-strategier, RAG-prompt engineering, citation-logic. Estimeret besparelse: 2-4 ugers arbejde + løbende vedligehold.

## Arkitektur

### Flow-diagram

```
┌──────────────────────┐                    ┌──────────────────────┐
│ @webhouse/cms admin  │                    │       Trail          │
│                      │                    │                      │
│  [Doc-editor]        │                    │  ┌────────────────┐  │
│       │              │                    │  │ webhouse-docs  │  │
│       ▼              │                    │  │  -en KB        │  │
│  [Save] ─────────────┼──POST /documents───┼─▶│                │  │
│                      │   (bearer)         │  │ 89 sources     │  │
│                      │                    │  │ → compile      │  │
│                      │                    │  │ → N Neurons    │  │
│                      │                    │  │                │  │
│  [Chat panel] ───────┼──POST /chat────────┼─▶│ FTS + LLM      │  │
│       ▲              │   (bearer)         │  │                │  │
│       └──────────────┼──answer + cites────┼──│                │  │
│                      │                    │  └────────────────┘  │
│                      │                    │  ┌────────────────┐  │
│                      │                    │  │ webhouse-docs  │  │
│                      │                    │  │  -da KB        │  │
│                      │                    │  │ 84 sources ... │  │
│                      │                    │  └────────────────┘  │
└──────────────────────┘                    └──────────────────────┘
```

### Sync-sti (CMS → Trail)

Ved hvert doc-save i @webhouse/cms trigger en async POST til Trail:

```
POST https://trail.broberg.dk/api/v1/knowledge-bases/{kbId}/documents/upload
Authorization: Bearer $TRAIL_INGEST_TOKEN
Content-Type: multipart/form-data

file: <doc.md som binary>
path: /docs/<slug>
```

Trail's eksisterende upload-route (`apps/server/src/routes/uploads.ts`) accepterer markdown-filer (text-ext → status='ready' direkte, ingen PDF-pipeline). Derpå fires `triggerIngest` der spawner en claude-subprocess med ingest-prompten — output er en source-summary + 2-5 koncept-Neurons pr. dokument.

**Idempotens via sti:** når samme doc gemmes igen, matcher Trail på `(kbId, path, filename)` og enten:
- Opdaterer eksisterende source (via ny re-ingest-endpoint landet for nylig), eller
- Opretter som ny version (via wiki_events-chain der bibeholder historikken)

Alternativ i stedet for upload-endpoint: en dedikeret POST til `queue/candidates` med `kind='external-feed'` og markdown-body direkte. Vælges baseret på om vi vil have ingest-compile per doc eller ej — se næste sektion.

### Chat-sti (CMS → Trail)

Brugeren skriver et spørgsmål i admin-chat-panelet:

```
POST https://trail.broberg.dk/api/v1/chat
Authorization: Bearer $TRAIL_INGEST_TOKEN
Content-Type: application/json

{
  "knowledgeBaseId": "kb_webhouse_docs_da",
  "message": "Hvordan tilføjer jeg custom field-types?",
  "locale": "da"
}
```

Returnerer:

```json
{
  "answer": "For at tilføje custom field-types registrerer du dem i cms.config.ts ...",
  "citations": [
    { "documentId": "doc_abc", "filename": "field-types-reference.md", "slug": "field-types-reference" },
    { "documentId": "doc_xyz", "filename": "cms-config.md", "slug": "cms-config" }
  ]
}
```

Admin-panelet renderer svaret + clickable citations der linker tilbage til den relevante docs-side i @webhouse/cms.

## LLM-compile (sources → Neurons) anbefales

**Valget:** indeks docs som `kind='source'` (med LLM-compile til Neurons) i stedet for `kind='wiki'` (direkte som færdige Neurons).

**Begrundelse** (pragmatisk mens vi er på Max-subscription):
1. **Compile er "gratis"** på Max. Ingen marginal cost. Vi får LLM-analyse-værdien uden regning.
2. **Contradiction-lint får rigtigt stof at arbejde med.** Når en docs-opdatering introducerer et begreb der modsiger en anden page, fyrer contradiction-alerten. Eksempel: v0.2 docs siger `useCms()` returnerer array, v0.3 docs siger det returnerer objekt — lint fanger det før kunde-support gør.
3. **Neurons er sub-dokument-granuleret.** Ét 2000-ord docs-stykke kan compiles til 3-4 koncept-Neurons (fx "AI Lock System" + "Visibility Scoring" + "Build-pipeline"). Chat-svar bliver mere fokuserede fordi FTS kan ramme netop den Neuron der dækker spørgsmålet, ikke bare hele artiklen.
4. **Cross-ref-backlinks bygges automatisk.** Reference-extractor + backlink-extractor kører allerede. Docs-korpussen får et kobberspind af `[[wiki-links]]` uden manuelt arbejde.

**Omvendt** (argumentet for `kind='wiki'` direkte):
- Ingen compile-latency (Neurons klar øjeblikkeligt efter save, ikke 60-180s senere)
- Ingen risk for LLM-destillation-fejl (hvad hvis compile forstår docs forkert?)
- Simpelthen færre bevægelige dele

**Kompromis vi lander på:** `kind='source'` med compile, **men** compile-promptet tilpasses til markdown-docs-kilder (ikke PDF-papers). Ny kind-variant `source-kind: 'docs-md'` som en metadata-hint der styrer compile-prompten.

**Compile-prompten for docs-md skal:**
- Bevare originale kode-blokke eksakt (`\`\`\`ts ... \`\`\``) — disse er API-eksempler, ikke noget at omformulere
- Respektere header-hierarkiet som eksisterende struktur
- Compile-output er **højest 1-2 Neurons pr. docs-page** (mindre aggressiv splitting end for PDF-sources, fordi docs allerede har fornuftig struktur)
- Ekstraher cross-references som `sources: [...]` frontmatter + `[[wiki-links]]` i body
- Bevare versions-marker: "deprecated i v0.2", "ny i v0.3" — disse skal overleve compile

### Når vi flytter til API (fremtidig beslutning)

Når Trail migreres fra CLI til Anthropic API (estimated 2026Q2, se PRICING-PLAN.md): 

- **Re-evaluér compile-compile-værdi vs. cost.** Hver docs-save koster så penge. Ved 40 opdateringer/måned × $0,25 pr. compile = $10/mdr. Stadig minimal, behold compile.
- **Eller skift til `kind='wiki'` direkte** hvis API-kosten er mærkbar og contradiction-værdi er lav. Begge modeller kan sameksistere via `source-kind`-hint.

Nu på Max er valget enkelt: compile alt.

## Multi-KB: to separate KBs for EN og DA

To KBs: `webhouse-docs-en` + `webhouse-docs-da`. Chat-panelet respekterer brugerens admin-locale.

**Hvorfor ikke én KB med sprog-tags?**
- Chat-LLM'en kan ende med at blande sprog i svar hvis begge er i samme FTS-pool
- Contradiction-lint ville flagge "dansk siger A, engelsk siger A" som modsigelse fordi indholdet er forskelligt på overfladen men matcher semantisk
- Search-ranking på FTS5 er sprogspecifik; blandet korpus giver degraderet ranking på begge sprog

**Trade-off:**
- Cross-sprog-konsistens er ikke automatisk. Hvis DA-docs aftter bagud for EN, opdager Trail det ikke. Håndteres i stedet via content-editor-workflow i @webhouse/cms.

**Kvota-konsekvens:**
- 89 EN-sources → ~150-180 Neurons efter compile
- 84 DA-sources → ~140-170 Neurons
- Total: ~290-350 Neurons fordelt på 2 KBs
- På Starter $20 med **1 KB** limit passer det ikke. Skal på **Pro $75** (3 KBs, 5k Neurons cap).

Pro-tierens ekstra værdi her er ugentlig sampling på contradiction-lint — hver uge scanner den hele korpussen for drift. Ved 300 Neurons tager det under 5 minutter og fanger docs-regressioner før kunden opdager dem.

## Auth-model

Bearer-token fra @webhouse/cms server til Trail. Admin-UI taler aldrig direkte med Trail — serveren proxier.

**Setup:**

1. Trail provisionerer en service-user for webhouse-tenant'en. Bearer token stored i `@webhouse/cms`-server-env:
   ```
   TRAIL_INGEST_TOKEN=<32-byte hex>
   TRAIL_BASE_URL=https://trail.broberg.dk
   TRAIL_KB_ID_EN=kb_...
   TRAIL_KB_ID_DA=kb_...
   ```

2. @webhouse/cms admin-UI kalder sin egen backend:
   ```
   POST /api/chat
   Cookie: session (fra eksisterende @webhouse/cms-auth)
   Body: { message, locale }
   ```

3. @webhouse/cms-server proxier til Trail med bearer:
   ```
   POST trail.broberg.dk/api/v1/chat
   Authorization: Bearer $TRAIL_INGEST_TOKEN
   ```

4. @webhouse/cms-server auditerer kaldet (hvem stillede hvilket spørgsmål hvornår) før det returnerer svaret til klienten.

**Hvorfor ikke direkte UI → Trail?**
- Token-rotation er nemmere når det kun er server-env der kender den
- Rate-limiting kan ske i @webhouse/cms-layer
- Audit-trail konsolideres i @webhouse/cms-DB i stedet for Trail (kunde-support-brugbart)
- CORS undgås

## llms.txt — stadig relevant, nu internt

Selvom Trail ikke eksponerer docs-siten public, er **llms.txt-endpoint på Trail stadig værdifuldt** for cc-sessioner, Cursor, Windsurf m.fl. der arbejder med @webhouse/cms-kildekode og har brug for at slå docs op.

**Scope:**
- Trail eksponerer `GET /api/v1/kb/:kbId/llms.txt` + `llms-full.txt`
- Authenticated endpoints (bearer-token) — ikke public
- cc-sessions der har `TRAIL_INGEST_TOKEN` i deres .mcp.json kan kalde endpoint'et

**Brugsscenarie:**

```bash
curl -H "Authorization: Bearer $TRAIL_INGEST_TOKEN" \
  https://trail.broberg.dk/api/v1/kb/webhouse-docs-da/llms-full.txt \
  > /tmp/docs-full.md
```

En cc-session i @webhouse/cms-repo der er i gang med at implementere en ny feature kan pipe hele docs-korpussen ind i context og bede LLM "check at din implementation er konsistent med det der står i docs" — før PR-submission.

**Generering:** simpelt script der læser alle `kind='wiki'` Neurons i KB'en, sorterer per path, outputter markdown. Cache-TTL 5 min.

## Implementerings-plan

**Total: ~4 arbejdsdage** (én person, fuld fokus).

### Dag 1 — Trail-siden

1. Provision 2 KBs i Trail: `webhouse-docs-en`, `webhouse-docs-da`
2. Opret service-user med bearer token for webhouse-tenant
3. Tilføj `source-kind: 'docs-md'` metadata-hint i ingest-pipeline
4. Tilpas ingest-prompt til docs-md (bevar code-blocks, mindre aggressive splitting)

### Dag 2 — @webhouse/cms sync-sti

1. Webhook på doc-save i @webhouse/cms → POST til Trail upload-endpoint
2. Idempotens: match på `(kbId, path, filename)`, re-ingest eksisterende
3. Initial backfill: script der iterer alle eksisterende 173 docs og POSTer dem én gang
4. Monitoring: log sync-fejl til @webhouse/cms DB, retry med backoff

### Dag 3 — Chat-panel i @webhouse/cms admin

1. Ny route `POST /api/chat` på @webhouse/cms-server der proxier til Trail
2. UI-komponent: chat-panel med input, svar-markdown, citations-liste
3. Citations bliver `<a>` der åbner doc-siden i ny tab
4. Locale-detection: hvis admin-UI er på `da`, kald `webhouse-docs-da` KB

### Dag 4 — Polish + test

1. Rate-limiting på @webhouse/cms-backend (10 q/min per admin-user)
2. Audit-logging: gem spørgsmål + svar til intern analyse
3. Contradiction-alerts-visning: når Trail emitter `candidate_created` med kind='contradiction-alert' → vis toast i @webhouse/cms-admin ("Modsigelse opdaget mellem docs/A og docs/B")
4. E2E-test: gem doc, vent 3 min, stil spørgsmål der kun kan besvares med nyt indhold, verifikér citation

## Cost (mens vi er på Max)

Marginal compute-cost for Trail-siden: **~$0/mdr** (alt kører på Max-subscription). 

| Trail-post | Marginal cost |
|---|---:|
| 173 docs compile (initial backfill) | $0 |
| 40 opdateringer/mdr × compile | $0 |
| Chat-queries (20/dag) | $0 |
| Contradiction-lint (on-mutation + ugentlig sampling) | $0 |

Plan-tier-cost (det vi køber adgang til):
- Pro $75/mdr for 2 KBs + 5k Neurons cap + ugentlig sampling
- I 2026Q2 når API-migration lander: compute-cost stiger fra $0 til ca. $10-15/mdr — stadig godt inden for Pro's budget

**Total stack-cost:** $75/mdr Trail + eksisterende @webhouse/cms infra. Meget lavt for "vores docs får AI-chat + tværgående contradiction-detection".

## Decision log

- **Docs-sitet forbliver på @webhouse/cms** — ingen flyt til Trail. Kun chat-motoren delegeres.
- **LLM-compile via `kind='source'`** — fordi Max gør det gratis + contradiction-lint får rigtigt stof at arbejde med. Flip-switch til `kind='wiki'` hvis API-cost bliver relevant.
- **To KBs (EN + DA)**, ikke én med sprog-tag — bedre chat-kvalitet, bedre FTS-ranking, semantisk renere contradiction-lint.
- **Bearer-auth via CMS-server proxy**, ikke direkte UI→Trail — enklere rotation, bedre rate-limiting, centraliseret audit.
- **llms.txt på authenticated endpoint** — ikke public, men brugbart for cc/cursor-sessioner med token.

## Åbne spørgsmål

1. **Sync-timing**: skal sync være synkron (admin venter på Trail-respons før "gemt"-bekræftelse) eller async (vis "gemmer til søgeindex..." progress)? Anbefaling: async med optimistisk "gemt lokalt, indekseres nu"-feedback.
2. **Sletning**: hvad sker når en docs-page slettes i @webhouse/cms? Send DELETE til Trail? Eller soft-archive så søgning returnerer "denne side er fjernet"? Anbefaling: soft-archive via Trail's eksisterende archive-flow, så chat-historik bevarer referencer.
3. **Skal trail.broberg.dk selv også drives som webhouse-docs-en KB i Trail?** (meta-dogfood) Anbefaling: ja, efter F100-API-migration. Trail docs → Trail selv, eneste sted på nettet hvor dogfooding er fuldkommen.
4. **Contradiction-lint alerts i @webhouse/cms admin**: skal de vises som system-notifikationer (invasive) eller kun i en dedikeret "Docs Quality"-dashboard-side? Anbefaling: dashboard + opt-in toast.
