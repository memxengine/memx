# F114 — Image Archiving for Web Content

*Planned. Tier: Pro+ (som del af connector-pack). Effort: 1-2 days.*

> Når en web-source (via F111 web-clipper eller markdown-source med eksterne img-URLs) ingestes, downloades alle refererede images lokalt som assets. Matcher Karpathy's tip: "Download images locally so the LLM can reference them directly instead of relying on URLs that might break."

## Problem

Webartikler refererer images via URLs på eksterne CDNs der kan bryde over tid. PDF-pipeline extraherer images (vi har det), men markdown-sources med `![](https://example.com/img.png)` refs gemmer kun URL-strengen. Hvis URLen dør forsvinder billedet — og dermed konteksten for LLM-compilen der refererer det.

## Solution

Under ingest af markdown-sources (både upload og web-clip):

1. Parse alle `![alt](url)` + `<img src="url">` references
2. Download hvert image via fetch med 10s timeout, max 10MB per asset
3. Gem i storage under `<tenantId>/<kbId>/<docId>/images/<filename>`
4. Rewrite markdown-content til at pege på lokal URL: `![](/api/v1/documents/<docId>/images/<filename>)`
5. Log failures som warnings, bevar original URL som fallback

## How

- Ny service `apps/server/src/services/image-archiver.ts`
- Hookes ind i ingest-pipeline umiddelbart efter markdown parses
- Storage-path matcher eksisterende PDF-image-pattern
- Admin image-route (eksisterende) serves allerede lokale images med auth
- Timeout + size-limit konfigurerbare via env

## Dependencies

- F111 (primary use-case: web-clipper downloads images)

## Success criteria

- Web-clipped artikel viser alle inline images også efter oprindelig URL er død
- Eksport (F100) inkluderer `wiki/assets/`-folder med alle archived images
- Failure-rate logges + telemetry viser hvor ofte vi rammer timeout/size-limit
