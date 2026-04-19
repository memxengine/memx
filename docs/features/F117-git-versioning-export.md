# F117 — Git-Versioning Export

*Planned. Tier: Pro+. Effort: 3 days.*

> Brugeren eksporterer sin KB som et fuldt git-repo med hver wiki_event som en commit. Resultat: cloneable repo hvor `git log`, `git blame`, `git diff` alle virker på Neuron-historikken. Matcher Karpathy's gist-bemærkning: "The wiki is just a git repo of markdown files. You get version history, branching, and collaboration for free."

## Problem

Trail har fuld version-historik via `wiki_events` + `contentSnapshot`, men den er DB-bundet. Avancerede brugere (udviklere, forskere) vil have git-native history for at kunne:
- `git log <neuron>.md` — se hele edit-historien
- `git blame` — hvilken source/candidate skabte hvilken linje
- `git diff main..feature` — eksperimentér med alternative compile-passes
- Push til egen GitHub for collab

## Solution

Ny endpoint `POST /api/v1/knowledge-bases/:kbId/export/git` (længe-løbende job):

1. Initialisér tom git-repo i tmp-dir
2. Iterate `wiki_events` kronologisk; for hvert event:
   - Checkout files til state efter event (via `contentSnapshot`)
   - `git add`, `git commit` med commit-besked genereret fra event-type + candidate-title:
     ```
     {event-type}: {candidate-title}
     
     Actor: {actor-kind}:{actor-id}
     Candidate: {candidate-id}
     Auto-approved: {yes|no}
     
     Co-Authored-By: Trail Ingest <trail@broberg.dk>
     ```
3. ZIP-pack repo med `.git`-mappe
4. Return til bruger

For store KBs: job-based (async), notification når klar.

## How

- Ny service `git-exporter.ts` bruger `isomorphic-git` (ren JS, ingen shell-exec) eller spawn'er system-git
- Commit-authorship mappes fra `actor_kind`: 'user' → user.email, 'llm' → "Trail LLM <trail-llm@broberg.dk>", 'system' → "Trail System"
- ZIP-output indeholder `.git/`-mappe så brugeren bare kan `unzip && git log`
- Performance: 10k events ≈ 2-5 min processeringstid

## Dependencies

- F100 (eksport-endpoint infrastruktur delvist genbrug)

## Success criteria

- Eksport producerer fuld git-repo cloneable lokalt
- `git log` viser kronologisk wiki-history
- `git blame` afslører hvilken candidate der skabte hvilken linje
- Upload af eksporteret repo til GitHub lader brugeren dele Neurons som normal software-repo
