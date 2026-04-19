# F106 — Solo Mode

*Planned. Tier: Free (tvunget), Starter (default), Pro (toggle). Effort: 1-2 days.*

> "Release the tyranny" af queue-mediated curation. Solo-brugere stoler på LLM'en — alle auto-approves, queue-tab skjules, contradiction-toasts dæmpes. Samme audit-trail under motorhjelmen, bare usynlig som default. Kan toggles tilbage til Curator når som helst.

## Problem

Queue-mediated writes, pending candidates, auto-approval-thresholds, contradiction-alerts-på-skema — alt er value-add for professionelle kurator-teams men tyranni for enkeltbrugere der stoler på deres LLM. Karpathy skriver wiki-siden direkte; vi tvinger godkendelses-ceremoni per default. Det frastøder Free/Starter-segmentet.

## Solution

Ny kolonne på users:

```sql
ALTER TABLE users ADD COLUMN mode TEXT
  CHECK (mode IN ('solo', 'curator'))
  NOT NULL DEFAULT 'curator';
```

Når `users.mode = 'solo'` ændres følgende defaults UDEN at fjerne underliggende funktionalitet:

| Surface | Curator-default | Solo-default |
|---|---|---|
| F19 auto-approval threshold | 0.8 for LLM, blokeret for user | 0.0 for user (auto-approver alt) |
| Nav: Queue-tab | synlig med pending-badge | skjult; erstattes af Audit-link i Settings |
| Chat Save as Neuron | modal → queue | auto-approver direkte, toast |
| Re-ingest knap | bekræftelses-modal | ingen modal, direkte udfør |
| Scheduled contradiction-scan | aktiv | deaktiv (manuel via Settings-knap) |
| On-mutation contradiction-scan | aktiv | deaktiv (toggle-able) |
| Contradiction-findings | som pending candidates i queue | samles i Settings > Potentielle modsigelser |
| Auto-fix lint-findings (F113) | deaktiv | aktiv på høj-confidence |

## How

- Schema migration + F19 policy patch (læs actor-mode, juster threshold)
- Admin-UI: conditional nav-rendering baseret på `useCurrentUser().mode`
- Settings > Account tilføjer mode-toggle med forklarende copy + "du kan skifte når som helst"
- Queue-komponent genbruges som Audit-view med label-swap + kronologisk sortering
- Wiki_events + queue_candidates bevarer fuld audit — intet skjules, kun UI-defaults ændres

## Tier policy

| Tier | Solo-adgang |
|---|---|
| Free | Tvunget Solo (ingen Queue-UI overhovedet) |
| Starter | Default Solo, kan skifte til Curator i Settings |
| Pro | Default Curator, kan skifte til Solo |
| Business | Kun Curator (compliance-rammer tillader ikke trust-LLM) |
| Enterprise | Custom per kontrakt |

## Dependencies

Ingen. Bygger direkte på eksisterende F17 Queue + F19 Policy.

## Success criteria

- Solo-bruger ingester source → ser Neurons live i wiki-tree uden nogensinde at åbne Queue-tab
- Skift til Curator-mode viser fuld historik af auto-approves som accepterbar audit
- Re-ingest kan udføres i ét klik i Solo, kræver modal-bekræftelse i Curator
