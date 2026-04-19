# F112 — User Notes / "Your Take" Field (Luhmann friction)

*Planned. Tier: alle. Effort: 2-3 days.*

> Hver Neuron får et dedikeret **"Din tanke"**-felt der er uafhængigt af LLM-compileret body. UX opfordrer brugeren til at tilføje sin egen synthesis — Luhmann-kritikken: LLM er god til reconnaissance, mennesket skal gøre synthesis-arbejdet.

## Problem

Trail's Neuron-reader viser kun LLM's output. Brugeren har ingen vej til at tilføje sin egen refleksion **uden at edit selve Neuron-content'et** (som så risikerer at blive overskrevet ved næste ingest/compile). Karpathy's artikel citerer Luhmann-kritikken: *"Reading someone else's summary is not the same as formulating the idea yourself."* Vi signalerer implicit at Trail erstatter brugerens tænkning — det er forkert positionering.

## Solution

Ny kolonne på documents:

```sql
ALTER TABLE documents ADD COLUMN user_note TEXT;
```

Admin's Neuron-reader rendrer feltet som dedikeret sektion ("**Din tanke**") under LLM-body'en. Brugeren kan redigere det inline — det gemmes automatisk via dedikeret endpoint `PUT /api/v1/documents/:docId/user-note` (bypasser queue, user-note er eksplicit ikke LLM-compileret indhold).

Eksport (F100) inkluderer user-note som separat markdown-sektion:

```markdown
<!-- auto-generated LLM body above -->

---

## Din tanke

{user_note content — fremhævet med blockquote eller andet visuelt anker}
```

## How

- Schema-migration (kolonne kan være null)
- Ny endpoint bypasser queue (user-note er ikke wiki-content, det er meta-anotation)
- Neuron-reader tilføjer redigerbar sektion med "Skriv din egen take her…" placeholder
- LLM-prompten i F103 instrueres til **aldrig** at modificere user-note-feltet
- F115 public gist kan eksempligere: "LLM's job: compile. Your job: think. Trail gives you a dedicated place for both."

## Dependencies

Ingen. Standalone-feature.

## Success criteria

- Brugeren kan tilføje / redigere note uden at trigge queue
- Noten bevares på tværs af re-ingest og compile-runs
- Eksport (F100) inkluderer noter som separat markdown-sektion
- Settings tooltip/help: "Luhmann-pattern: write in your own words to understand"
