# F125 — CMS Chat-Proxy with Citation-Enriched Response

*Planned. Tier: Business default, Pro som add-on. Effort: 1 day.*

> CMS-admin bruger kalder Trail's chat-API gennem sin egen server (bearer-auth), får svar + citations der inkluderer **både** Trail's `documentId` og den originale `cms-id`. CMS'en kan derfor linke citations direkte tilbage til sine egne docs-routes.

## Problem

F124 CMS-content-sync sender artikler ind. Chat-API returnerer citations — men citations indeholder kun Trail's `documentId`, ikke CMS'ens stable `cms-id`. CMS-sitet kan ikke nemt mappe citation → /docs-url uden at lave en ekstra lookup.

## Solution

Ingen ny endpoint — udvid eksisterende `/api/v1/chat` response:

```json
{
  "answer": "...",
  "citations": [
    {
      "documentId": "doc_abc",
      "filename": "field-types-reference.md",
      "slug": "field-types-reference",
      "cmsId": "art_xyz",         // ← NY: from documents.metadata.cmsId
      "locale": "en"              // ← NY
    }
  ]
}
```

`documents.metadata` JSON er populated af F124 med `cmsId + locale`. Chat-service's citation-serialisering udvides til at læse disse felter.

## How

- Citation-serializer i `services/chat.ts` læser `metadata.cmsId` (safe JSON parse)
- Null cmsId → udelades fra response (for ikke-CMS-sources)
- Schema-dokumentér i OpenAPI-spec
- @trail/cms-connector-sdk (F127) wrapper adder auto-type `ChatCitation<CmsContext>`

## Dependencies

- F124 (CMS content-sync populerer cmsId)

## Success criteria

- @webhouse/cms admin-chat viser citations som clickable links til /docs/<slug>
- Non-CMS-sources i samme KB returneres uden cmsId-felt (ikke null, udeladt)
- OpenAPI-spec dokumenterer feltet tydeligt for SDK-consumers
