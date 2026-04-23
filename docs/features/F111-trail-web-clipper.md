# F111 — Trail Web Clipper (Browser Extension)

> Tier: Starter+ (or connector-pack add-on on Pro). Effort: Medium (3-5 days). Status: Planned.
> A Chrome/Firefox browser extension "Trail Clipper" that lets the user clip a webpage to markdown + upload to Trail with one click. Direct competitor to Karpathy's use of Obsidian Web Clipper. Becomes the primary raw-input path for solo-tier.

## Problem

Karpathy's primary input path is Obsidian Web Clipper → `raw/` folder. Trail's primary input is the admin's upload dropzone or MCP-write. There's no one-click path from "I'm reading an interesting article" to "it's in my Trail." This friction limits how often users actually add sources.

## Secondary Pain Points

- Mobile users have no way to clip articles (deferred to future mobile app).
- Users must download an article, then upload it to Trail — two steps instead of one.
- No connector attribution for web-clipped sources.

## Solution

Browser extension with minimal UI:

1. **Browser-bar icon** (Trail logo) — click opens small popup
2. **Popup fields**: KB dropdown (list via `/api/v1/knowledge-bases`), path default `/web/`, optional tag field
3. **Clip button** → extracts DOM-clean text via Readability.js, converts to markdown via Turndown.js, POSTs to `/api/v1/knowledge-bases/:kbId/documents/upload` with bearer token
4. **Confirmation toast** + link to source in Trail admin

Auth: user logs into Trail once from the extension popup, token stored in `chrome.storage.local`.

## Non-Goals

- Safari support (parked for later — requires separate developer account + Swift code).
- Full-page screenshot capture (text-only for MVP).
- Offline clipping with sync later (requires internet at clip time).
- Image download + upload as separate assets (deferred to F114).
- Clipping paywalled or login-protected pages (extension can only access visible DOM).

## Technical Design

### Package structure

```
apps/browser-extension/
├── manifest.json          (Manifest V3)
├── package.json
├── vite.config.ts
├── src/
│   ├── popup/
│   │   ├── Popup.tsx      (popup UI)
│   │   ├── popup.html
│   │   └── popup.tsx       (entry point)
│   ├── content/
│   │   └── clipper.ts      (content script — Readability + Turndown)
│   ├── background/
│   │   └── service-worker.ts (auth, API calls)
│   └── shared/
│       └── types.ts        (shared types)
├── assets/
│   └── icon-128.png
└── dist/                   (build output)
```

### Libraries

- `@mozilla/readability` — extracts clean text from DOM
- `turndown` — converts HTML to markdown
- Vite — builds content-script + service-worker bundle

### Auth flow

1. User clicks extension icon → popup shows "Login to Trail" button
2. Opens Trail admin login page in a new tab
3. User logs in, Trail redirects to a special callback URL with the API key
4. Extension captures the API key from the callback URL and stores it in `chrome.storage.local`
5. Subsequent clips use the stored token

### Clip flow

1. User clicks extension icon → popup shows KB selector + clip button
2. Content script extracts page content via Readability.js
3. Converts to markdown via Turndown.js
4. Background service worker POSTs to `/api/v1/knowledge-bases/:kbId/documents/upload`
5. Response shows confirmation toast + link to source in Trail admin

## Interface

### Extension popup

```
┌─────────────────────────────┐
│  Trail Clipper              │
│                             │
│  Trail: [Sanne KB ▼]        │
│  Tags:  [________]          │
│                             │
│  [  Clip to Trail  ]        │
│                             │
│  Settings | Logout          │
└─────────────────────────────┘
```

### API call

```
POST /api/v1/knowledge-bases/:kbId/documents/upload
Authorization: Bearer <api-key>
Content-Type: multipart/form-data

filename: "<page-title>.md"
content: <markdown content>
connector: "web-clipper"
```

## Rollout

**Single-phase deploy.** New extension package, no server changes needed (uses existing upload endpoint). Publish to Chrome Web Store + Mozilla Add-ons (paid developer accounts). MVP supports Chrome + Firefox.

## Success Criteria

- Extension installable from official stores.
- Click → markdown version of current page is in Trail within 5 seconds.
- Trail admin shows the source as a normal source with `connector: web-clipper` in metadata.

## Impact Analysis

### Files created (new)

- `apps/browser-extension/manifest.json`
- `apps/browser-extension/package.json`
- `apps/browser-extension/vite.config.ts`
- `apps/browser-extension/src/popup/Popup.tsx`
- `apps/browser-extension/src/popup/popup.html`
- `apps/browser-extension/src/popup/popup.tsx`
- `apps/browser-extension/src/content/clipper.ts`
- `apps/browser-extension/src/background/service-worker.ts`
- `apps/browser-extension/src/shared/types.ts`
- `apps/browser-extension/assets/icon-128.png`

### Files modified

- `packages/shared/src/connectors.ts` (add `web-clipper` connector id)
- `turbo.json` (add browser-extension pipeline)

### Downstream dependents

`packages/shared/src/connectors.ts` is imported by 8+ files across apps/server, apps/admin, packages/core, apps/mcp. Adding `web-clipper` connector id is additive; no consumer changes needed.

`turbo.json` — adding a new workspace pipeline is additive.

### Blast radius

- Extension uses existing upload endpoint — no server changes, no breaking changes.
- Auth token stored in `chrome.storage.local` — if compromised, attacker can upload to user's KBs. Mitigation: token is scoped to user's API key permissions.
- Edge case: clipping very long pages (>10,000 words) may exceed upload payload limits. Consider truncation or chunking.
- Edge case: pages with heavy JavaScript rendering (SPAs) may not clip correctly — Readability works on the rendered DOM, which is available in the content script.

### Breaking changes

None — all changes are additive.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Unit: Readability.js extracts clean text from mock HTML
- [ ] Unit: Turndown.js converts HTML to markdown correctly
- [ ] Integration: extension clips a test page → markdown uploaded to Trail
- [ ] Integration: auth flow stores token in chrome.storage.local
- [ ] Manual: install extension in Chrome, clip an article, verify it appears in Trail admin
- [ ] Manual: verify `connector: web-clipper` in source metadata
- [ ] Regression: existing upload flow unaffected by new connector
- [ ] Regression: F95 Connectors filter shows web-clipper as a connector option

## Implementation Steps

1. **Extension scaffolding** — create `apps/browser-extension/` with Manifest V3, Vite config, package.json.
2. **Connector registration** — add `web-clipper` to `packages/shared/src/connectors.ts`.
3. **Content script** — implement Readability.js + Turndown.js extraction in `src/content/clipper.ts`.
4. **Popup UI** — build popup with KB selector, tag field, clip button in `src/popup/Popup.tsx`.
5. **Background service worker** — implement auth flow + API call in `src/background/service-worker.ts`.
6. **Auth flow** — implement login callback + token storage.
7. **Build pipeline** — add browser-extension to turbo.json.
8. **Test** — install in Chrome, clip test pages, verify upload.
9. **Store submission** — prepare Chrome Web Store + Mozilla Add-ons listings.

## Dependencies

None (uses existing upload endpoint).

## Open Questions

1. **Image handling.** Should images be downloaded and uploaded as separate assets? Defer to F114.
2. **Page selection.** Should the user be able to select a portion of the page to clip, or always clip the full page? Leaning: full page for MVP, selection later.
3. **Rate limiting.** Should there be a clip frequency limit to prevent abuse? Server-side rate limiting on the upload endpoint already applies.
4. **Store review timeline.** Chrome Web Store review can take 1-2 weeks. Plan submission accordingly.

## Related Features

- **F95** (Connectors) — web-clipper connector attribution
- **F114** (Image handling) — image download + upload as assets
- **F106** (Solo Mode) — web clipper is primary input path for solo-tier
- **F100** (Obsidian Vault Export) — web-clipped sources included in export

## Effort Estimate

**Medium** — 3-5 days.

- Extension scaffolding: 0.5 day
- Content script: 0.5 day
- Popup UI: 1 day
- Background service worker + auth: 1 day
- Testing + bug fixes: 0.5-1 day
- Store submission prep: 0.5 day
