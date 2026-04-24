# Trail — Non-Goals Index

**Last updated:** 2026-04-24

Denne fil er et kurateret register over ting vi **bevidst IKKE gør** som del af en given F-plan. Formålet er at bevare rationalet ("vi valgte IKKE X fordi Y") så senere sessioner ikke genopfinder skippede retninger — og at give os én overblikplads hvis et parkeret non-goal bliver modent nok til at forfremmes til sit eget F-nummer.

Status-flags:
- **parked** — anerkendt som ikke-for-nu; kan genoptages senere
- **promoted-to-F<nn>** — non-goalet blev sit eget F-nummer
- **declined** — aktivt fravalg (vi gør det aldrig)
- **covered-by-F<nn>** — dækket af eksisterende feature; non-goalet var dobbelt-arbejde
- **workflow** — håndteres via proces, ikke kodeplan

---

## Index

| Fra F | Non-Goal | Status |
|---|---|---|
| F148 | Rewriting eksisterende Neuron-filnavne in-place | parked (curator-drevet batch-rename kan komme som nice-to-have) |
| F148 | Cross-KB link-resolution | declined (F23 `[[kb:]]`-syntaks er det rigtige sted; ikke link-checker) |
| F148 | Sproggenkendelse fra kildeindhold | declined (`knowledge_bases.language` er autoritativ) |
| F148 | Fuzzy/ML-matching hinsides deterministiske ord-folds | declined (F148 skal være LLM-fri; Levenshtein ≤ 2 er grænsen) |
| F148 | Fikse link-tekst i andre Neuroner når et filnavn renames | parked (rename-flow ikke specificeret) |
| F148 | Slug-normalization for ekstern content (web-clipper, RSS) | declined (fold er kun intra-KB) |
| F149 | Runtime UI-switch af backend/model | promoted-to-F152 |
| F149 | Streaming tokens til admin UI under ingest | parked (bundt evt. med F136 compile-log card) |
| F149 | Per-tenant billing aggregation + fakturaer | covered-by-F43 + F44 |
| F149 | To-backend voting / konsensus-ingest | parked (eksperimentelt, ikke behov endnu) |
| F149 | Auto-retraining af billingsmodellen baseret på historiske cost_cents | declined (pricing-tier sættes manuelt via F43; ingen business-case for auto-retrain) |
| F149 | Backend for ikke-OpenRouter-cloud-providers (Anthropic API direkte, Vertex AI, Bedrock) | arkitektur-åbnet (interfacet understøtter det, v1 shipper kun 2 backends) |
| F150 | Auto-accept uden curator-indblanding | declined (F148 Lag 2 håndterer deterministiske tilfælde; al broken-link-accept kræver curator-skøn) |
| F150 | Fuzzy search i findings | parked (findings per KB bounded; grov filtrering tilstrækkelig) |
| F150 | Cross-KB link-report | parked (Phase 2+ scope) |
| F150 | Bulk-accept af findings | parked (risikabelt før vi har false-positive-rate-data) |
| F150 | Historisk graf af link-integrity over tid | parked (nice-to-have; samme mønster som F141 kunne bruges) |
| F150 | Editable `suggested_fix` før accept | parked (v2 hvis brugere efterspørger) |
| F151 | Budget-alerts / threshold-notifications | covered-by-F44 (Usage Metering) |
| F151 | Stripe-invoice-generation | covered-by-F43 + F44 |
| F151 | Auto-modelselection baseret på quality-historik | parked (data-grundlag ligger klar; beslutnings-logik er F152's domæne hvis autonom) |
| F151 | Cross-tenant cost-aggregation | parked (Phase 2+ ownership-dashboard) |
| F151 | Forecasting af fremtidig cost | parked (trend-analyse er nice-to-have) |
| F151 | Retroaktiv cost-attribution for pre-F149-jobs | declined (viser som "gratis (Max)" eller "—", aldrig som gæt) |
| F152 | Mid-job curator-initieret model-switch | parked (F149's fallback-chain håndterer fejl-drevne mid-job-switches; manuelt ikke behøvd) |
| F152 | Cross-KB bulk-switch af model | parked (nyttigt ved mange KBs; ikke v1) |
| F152 | A/B-test-orchestration på tværs af modeller | parked (dyb feature; kunne bygge på F151) |
| F152 | Per-source model-override | parked (v1 er KB-level) |
| F152 | Persisted audit-trail af model-ændringer | parked (nice for enterprise-tier) |

---

## Konventioner

- **Nye F-planer skal appende deres non-goals hertil** i samme commit som F-planen landes. `/feature`-skill håndhæver dette.
- **Ved forfremmelse**: opdater status til `promoted-to-F<nn>` med den nye F-nummers link.
- **Ved declined**: behold rækken — det er præcis pointen, at begrundelsen bevares.
- **Ved covered-by**: behold og peg på den dækkende feature.

## Hvorfor dette dokument eksisterer

2026-04-23-auditen fandt 43 feature-entries i indekset uden plan-dokument bag. Hele idégrundlaget var tabt fordi planerne aldrig blev skrevet. Non-goals-rationalet er ligeså sårbart — "vi valgte IKKE X" er usynligt i git-history men vitalt når en fremtidig session overvejer X igen.

Ved at kuratere non-goals i én fil undgår vi at:
- Gensøge gamle plan-docs for at finde "gjorde vi allerede denne diskussion?"
- Genopfinde skippede retninger
- Shippe features der dobbelt-dækker hinanden
