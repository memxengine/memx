# F111 — Trail Web Clipper (Browser Extension)

*Planned. Tier: Starter+ (som tilkøb i connector-pack på Pro). Effort: 3-5 days.*

> En Chrome/Firefox browser-extension "Trail Clipper" der lader brugeren klippe en webside til markdown + upload til Trail med én klik. Direkte konkurrence-feature mod Karpathy's brug af Obsidian Web Clipper. Bliver primary raw-input-sti for solo-tier.

## Problem

Karpathy's primære input-sti er Obsidian Web Clipper → `raw/`-folder. Trail's primære input er admin's upload-dropzone eller MCP-write. Ingen one-click-path fra "jeg læser en interessant artikel" til "den er i min Trail". Det er friktion der begrænser hvor ofte brugeren faktisk tilføjer sources.

## Solution

Browser-extension med minimal UI:

1. **Browser-bar-icon** (Trail-logo) — klik åbner lille popup
2. **Popup-felter**: KB-dropdown (list via `/api/v1/knowledge-bases`), sti-default `/web/`, valgfri tag-felt
3. **Clip-knap** → extracter DOM-ren-tekst via Readability.js, konverterer til markdown via Turndown.js, POSTer til `/api/v1/knowledge-bases/:kbId/documents/upload` med bearer-token
4. **Bekræftelse-toast** + link til source i Trail-admin

Auth: bruger logger på Trail én gang fra extension-popupen, token gemmes i `chrome.storage.local`.

## How

- Ny mappe i monorepo: `apps/browser-extension/` (Manifest V3)
- Bruger `@mozilla/readability` + `turndown` biblioteker
- Bygges med Vite som content-script + service-worker bundle
- Signed+publiceret til Chrome Web Store + Mozilla Add-ons (paid developer accounts)
- MVP understøtter Chrome + Firefox; Safari parkeres

## Dependencies

- Ingen (bruger eksisterende upload-endpoint)

## Success criteria

- Extension installerbar fra officielle stores
- Klik → markdown-version af aktuel side er i Trail inden for 5 sekunder
- Images downloades + uploades som separate assets (se F114)
- Trail-admin viser kilden som normal source med `connector: web-clipper` i metadata
- Marketing-asset: "Clip any article straight into your second brain"
