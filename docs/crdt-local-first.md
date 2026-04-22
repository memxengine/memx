# CRDTs og local-first sync

> **Promoted to F146** — see [F146 plan doc](features/F146-local-first-native-app-sync.md)
> for the implementation plan. This page stays as the user-facing explainer.


> "Built on CRDTs. Your knowledge graph lives locally for zero-latency access, syncing securely to the cloud when connected."

Kort fortalt: din data bor på din egen enhed først, og synkronisering til skyen sker i baggrunden — uden konflikter, selv hvis du har været offline.

## Built on CRDTs

CRDT står for *Conflict-free Replicated Data Type*. Det er en datastruktur designet sådan, at flere kopier af den samme data kan opdateres uafhængigt af hinanden (fx på din laptop, din telefon og en server) — og når de så mødes igen, kan de altid flettes sammen automatisk uden konflikter.

Matematikken bag garanterer, at alle kopier ender i samme tilstand, uanset i hvilken rækkefølge ændringerne kom ind.

Det er den samme teknologi, som ligger bag værktøjer som Linear, Figma og Apples Notes-synkronisering. Alternativet er typisk "last-write-wins" eller manuel konfliktløsning ("nogen ændrede dette samtidig — vælg en version"), som CRDTs helt undgår.

## Your knowledge graph lives locally

Din viden (noter, relationer, entiteter) gemmes primært i en lokal database på din enhed. Det betyder:

- **Zero-latency**: Når du åbner eller redigerer noget, går det ikke over netværket — det læses direkte fra disk. Ingen spinner, ingen venten.
- **Offline-first**: Du kan arbejde i toget, på et fly, hvor som helst. Appen er ligeglad.
- **Sync når forbundet**: Så snart du har net igen, sender den ændringerne til skyen (krypteret), og henter også ændringer fra dine andre enheder. Takket være CRDTs fletter det hele automatisk.

Det står i kontrast til traditionelle cloud-apps (Notion, Google Docs i gamle dage), hvor hver handling kræver et kald til serveren og derfor føles langsommere — og fejler, hvis du er offline.

## Relevante biblioteker

CRDT-biblioteker er blevet meget modne og bruges aktivt i JS/TS-stakke:

- **[Yjs](https://github.com/yjs/yjs)** — højtydende CRDT til delte dokumenter og strukturerede data
- **[Automerge](https://github.com/automerge/automerge)** — JSON-lignende CRDT med fokus på local-first applikationer

Begge egner sig godt til en Next.js / React stack.
