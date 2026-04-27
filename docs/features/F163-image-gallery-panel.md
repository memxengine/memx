# F163 — Image Gallery panel (curator-facing browse + search)

> Et nyt admin-panel `/kb/<kbId>/images` der lader Trail-ejeren (terapeut, researcher, journalist, lærer) browse + søge ALLE billeder fra deres kilde-materiale uden at skulle chatte sig frem til dem. Grid-view med Vision-genererede alt-tekster som hover/caption, FTS-search over `vision_description`, klik for fuld-størrelse + spring-til-kilde-dokument. Bygger på F161's `document_images`-tabel + image-search endpoint — ingen ny backend nødvendig udover et lille per-image "open in source"-link. Tier: alle tenants. Effort: Small-to-Medium — ~4-5 timer (det er rent UI-arbejde mod et eksisterende endpoint). Status: Planned.

## Problem

F161 lagde rørene: alle PDF-extraherede + standalone billeder bor i `document_images` med Vision-genererede beskrivelser, FTS5-search over disse beskrivelser, og audience-filtreret API. Men curator-fladen til faktisk at **bruge** billederne mangler.

I dag, hvis Sanne (terapeut) vil finde "det der diagram med refleksologi-zoner under foden":

1. Hun kan **chatte** med Eir og håbe at chatten henter et relevant billede — men chat returnerer pt. kun prose; billeder hentes parallelt af integratoren, ikke surfacet i admin-chat.
2. Hun kan åbne hver Source-PDF og scrolle gennem 124 sider manuelt.
3. Hun kan querye `/api/v1/knowledge-bases/sanne-andersen/images?q=zoner` direkte med curl + et Bearer-token hun ikke har.

Ingen af de tre er en realistisk workflow for en terapeut der bare vil "se mine billeder". Browse + visual-search er en **separat user-job** fra "stille spørgsmål til indhold". Trail er positioneret som AI-native KB, men en KB hvor du ikke kan se dine egne billeder uden at chatte er en degraderet oplevelse.

Konkret katalysator: Sanne uploadede sin Zoneterapi-bog (124 sider, 224 billeder). Når Vision-rerun (F161 follow-up) har annoteret dem alle, har hun et image-corpus der er værdifuldt **i sin egen ret** — ikke kun som chat-supplement. Hun bør kunne åbne admin'en og browse dem som hun ville browse Photos.app, med søgning oven i.

Bredere: enhver Trail-ejer der har uploadet kilder med billeder (slides, lærebøger, scannede dokumenter, fotos fra felt-arbejde, screenshots fra software-dokumentation) har samme behov. Image-corpus er en almindelig artefakt af knowledge-work; visning af det er en almindelig forventning.

## Secondary Pain Points

- **Vision-beskrivelser er usynlige i dag** udenfor det de bruges til (RAG-context, /retrieve images[]). Hvis Vision skriver noget mærkeligt eller forkert om et billede har curator ingen vej til at opdage det. Et gallery med beskrivelser som captions afslører dårlige beskrivelser organisk.
- **Ingen "find this image again"-mønster.** Hvis Sanne har set et billede én gang og vil finde det igen, har hun intet bookmark / favorit / recent-viewed. Out of scope for v1 (favorit-system er F18x territory) men gallery'et lægger fundamentet — alle billeder har stable IDs allerede.
- **Source-doc context går tabt** når et billede vises i isolation. Et meridian-diagram giver mere mening når man kan klikke "vis i kapitel 4 af bogen". Per-image action skal linke tilbage til `<doc>`-rowen i Sources-panelet på den rigtige scroll-position.
- **Cross-document patterns** er usynlige uden gallery: "alle mine fod-billeder" på tværs af 5 kilder kan kun findes med Vision-FTS-query, men curator kan ikke nemt explorere det.
- **Filer uden Vision-beskrivelse** (NULL `vision_description` — fx Sanne-bogens 224 billeder før rerun) skal også vises, ellers fremstår billed-corpus mindre end det er. Fallback-caption: `<filename>` + page + size. Operator skal kunne se "ahh, Vision er ikke kørt på de her endnu".

## Non-goals (v1)

- **Ingen edit-mode for Vision-beskrivelser.** Hvis curator finder en dårlig beskrivelse skal de re-køre Vision (F161 follow-up button) — ikke håndredigere. v2 kan tilføje "rewrite description"-modal hvis behovet viser sig.
- **Ingen sletning** af individuelle billeder. Source-arkivering er den korrekte sletnings-vej; image-billeder følger source-doc'ets archived-status (allerede dækket af F161's audience-filter).
- **Ingen tagging / collections / favoritter.** Tilføj som F163.x follow-up hvis browse-mønstret faktisk bruges.
- **Ingen drag-upload-til-gallery.** Standalone image-upload sker via Sources-panelet (F161 backfill håndterede legacy markdown-embedded billeder; nye image-uploads går samme vej). Gallery er read-only views over `document_images`.
- **Ingen multi-select / bulk-actions.** YAGNI indtil curator faktisk siger "jeg vil gerne arkivere 30 billeder på én gang", og når de gør det, er rettighed til at arkivere et **billede** (ikke source-doc'et) selv en separat designbeslutning.

## Solution

### Backend — let mod eksisterende endpoint

Vi bruger `GET /api/v1/knowledge-bases/:kbId/images?q=&limit=&audience=curator` direkte. Curator-audience returnerer alle billeder inkl. heuristics + internal — hvilket er det rigtige for ejeren af KB'en.

**Lille tilføjelse** til endpointet: support for `?cursor=` pagination så grid'et kan loade flere når curator scroller. Pagination-kontrakt:

```
GET /knowledge-bases/:kbId/images?limit=48&cursor=<base64-encoded-created-at>
→ { hits: [...], nextCursor: "..." | null }
```

Cursor er `created_at + id` base64-encoded (stable sort på desc created_at). Tomt `nextCursor` = ingen flere.

For empty-query (browse-mode) sorterer vi DESC created_at. For FTS-mode sorterer vi `rank` (BM25-ish) og pagination via offset er acceptabelt (FTS-resultater er typisk få nok at offset-cost er ubetydeligt).

**Per-image "open in source" link** behøver ingen backend-ændring — `documentId` er allerede i response. Vi linker direkte til `/kb/<kbId>/sources?expanded=<docId>` og lader Sources-panelet auto-expand row'en (kræver lille addition i sources.tsx — læs `expanded` fra query-string ved mount).

### Frontend — `apps/admin/src/panels/images.tsx`

Nyt panel registreret i admin-router (`apps/admin/src/main.tsx` route-table) på `/kb/:kbId/images`. Tilføjet til Trail-nav (`apps/admin/src/components/trail-nav.tsx`) som tab "Images" mellem "Sources" og "Neurons" — det er det naturlige sted i flow'et: source → images → neurons.

Layout-spec:

```
┌─────────────────────────────────────────────────────────────┐
│ [Search: vision-beskrivelse...] [Filter: source ▾]  [count] │
├─────────────────────────────────────────────────────────────┤
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│  │     │ │     │ │     │ │     │ │     │ │     │           │
│  │ img │ │ img │ │ img │ │ img │ │ img │ │ img │           │
│  │     │ │     │ │     │ │     │ │     │ │     │           │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
│  caption caption caption caption caption caption            │
│  page 4  page 7  page 12 page 15 page 21 page 23           │
│  ┌─────┐ ┌─────┐ ...                                        │
│                                                              │
│              [Load more (1247 remaining)]                    │
└─────────────────────────────────────────────────────────────┘
```

Grid: CSS-grid `auto-fill, minmax(180px, 1fr)`. Aspect-ratio container med `object-fit: cover` så grid'et er roligt — billeder med vild aspekt fitter ind uden at bryde rytmen. Caption under: 2-line clamp af `vision_description`, faded når NULL ("no description yet"). Page-badge i overlayet på billedet.

Klik på billede → modal med:
- Fuld-størrelse view (max-w-90vw, max-h-85vh)
- Komplet `vision_description` (ikke clamped)
- Metadata: source-doc filename + page, dimensions, vision_model, created_at
- Actions: "Open source", "Copy URL", "Re-run Vision" (hvis F161-rerun-flag = on)

Search-input: debounced (250ms) input → query string `?q=` → re-fetch. Tom query = browse-mode (created_at DESC).

Filter (per-source): dropdown med liste over Sources i KB'en der har mindst ét billede. Ved valg, append `?docId=<id>` til API-call. Empty = alle.

Tom-state: hvis KB ingen billeder har endnu (eller kun NULL-Vision og search returnerer 0 hits), vis instruktioner: "Upload PDF/image-kilder til at se dem her" + link til Sources.

### F161 follow-up — fix audience i image-search for curator

Quick check: `parseAudienceParam` accepterer `curator` (eksisterende). Default for session-cookie er `curator`. Bekræft at det også er korrekt hjemme i `/images?audience=curator` så heuristic-stien ikke filtreres væk fra ejerens egen browse.

### Routing tilføjelse i Sources-panelet

For "open source"-knappen: når sources.tsx mounter, læs `?expanded=<docId>` query-string og initialiser `expanded`-state med dette ID. Tilføj scrollIntoView på element. Trivial 5-line ændring i sources.tsx — men hører hjemme i F163-commit'et fordi det er det nye browse-flow der introducerer behovet.

### i18n keys

`images.title`, `images.summary`, `images.summaryPlural`, `images.searchPlaceholder`, `images.filterAllSources`, `images.empty`, `images.emptySearch`, `images.noDescription`, `images.openSource`, `images.copyUrl`, `images.copied`, `images.runVision`, `images.loadMore`, `images.modalActions`. Begge da/en — Sanne læser dansk, integratorer kan vælge en.

## Architecture sketch

```
Browser /kb/:kbId/images
   │
   ▼
images.tsx (new panel)
   │ debounced search + pagination
   ▼
api.listImages(kbId, { q, docId, cursor, limit })
   │
   ▼
GET /api/v1/knowledge-bases/:kbId/images?q=…&docId=…&cursor=…
   │
   ▼
images-search.ts (existing F161 endpoint, +cursor support)
   │
   ▼
document_images_fts MATCH ?  ←— FTS path
   │  (or)
   ▼
document_images ORDER BY created_at DESC  ←— browse path
   │
   ▼
JOIN documents → audience-filter → return hits + nextCursor
```

## Dependencies

- **F161 (Inline media)** — `document_images` table, image-search endpoint, image-proxy URL. Hard dep; F163 er i sin natur en visning oven på F161's data.
- **F161 follow-up (Vision-rerun)** — ikke en hård dep, men gallery er meget lidt nyttigt på Sanne's KB indtil de 224 billeder har Vision-beskrivelser. Plan: ship F163 efter Vision-rerun har kørt mindst én gang på Sanne's KB.
- **F39 (Connectors)** — ingen direkte dep, men gallery skal vise connector-badge på source-doc i modal'en.

## Rollout

1. **Phase 1 — backend**: Tilføj cursor-pagination til `images-search.ts` (eksisterende endpoint, additive). Verify-script: `apps/server/scripts/verify-f163-pagination.ts` der seeder 100 fake image-rows og verificerer at `?cursor=` returnerer next-page'en uden duplikater og uden manglede rows. ~1h.
2. **Phase 2 — frontend grid**: `apps/admin/src/panels/images.tsx` med browse-mode + search, modal-view, no filter. Tilføj til router + nav. ~2h.
3. **Phase 3 — filter + open-source**: Source-filter dropdown + "open in source"-link med expanded-id query-string. ~1h.
4. **Phase 4 — i18n + polish**: Danske + engelske strenge, empty-states, loading-skeletons, hover-states (ALDRIG `:hover` uden `:active` — CLAUDE.md regel). ~1h.

Kan landes i én commit eller fire afhængigt af review-præference; intern testet via Sanne's KB i hele forløbet.

## Open questions

- **Image preloading**: skal vi brug `<img loading="lazy">` (browser-native) eller IntersectionObserver-based prefetching? Native lazy er trivielt + godt nok for v1.
- **Modal-navigation**: når en bruger har åbnet billede A i modal, skal pil-venstre/højre navigere til naboer i grid'et? Lille UX-vinder, kan tilføjes i v1 hvis tiden tillader; ellers v1.5.
- **Performance på 10k+ images**: pagination + lazy-load skulle dække det, men hvis FTS-queries på vision_description bliver langsomme på fuldt-populerede tenants skal vi måle. Out of scope for v1; mål når det bliver et reelt problem.
- **Embedding-based "find similar images"** (ikke vision-tekst-match): er en interessant feature hvis Vision-beskrivelser ikke fanger semantisk lighed nok. F18x territory.
