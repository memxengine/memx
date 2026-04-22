# F147 — Share Extension (iOS + Android)

> Native share targets for iOS og Android der lader brugeren sende tekst, links og billeder direkte fra andre apps til Trail — uden at forlade kilden.

## Problem

Trail's primære input-kanaler i dag er: upload-dropzone i admin, web clipper (browser), og MCP/CLI. Men den mest naturlige input-sti på mobile enheder er **share sheet** — den system-level "Del"-knap der findes i Fotos, Safari, Instagram, Notes, Spotify, og stort set alle andre apps.

Uden en share extension er den mobile workflow:
1. Se noget interessant i en app (f.eks. et Instagram-billede eller en artikel i Safari)
2. Åbn Trail i browseren
3. Log ind
4. Find KB
5. Upload/clip manuelt

Det er for meget friktion til at blive en vane. Karpathy's Obsidian Web Clipper virker fordi det er ét klik fra browseren. På mobil er share sheet det tilsvarende "one-tap" mønster.

## Solution

Tre komponenter:

1. **iOS Share Extension** (Swift/SwiftUI) — dukker op i iOS share sheet som "Trail Clipper". Modtager tekst, URLs, billeder og billeder+tekst kombinationer. Upload til Trail via API.

2. **Android Share Extension** (Kotlin/Jetpack Compose) — tilsvarende share target på Android.

3. **Server-side vision pipeline** — billeder uploades via share extension og sendes gennem Anthropic Vision for beskrivelse + OCR. Den genererede markdown + billedbeskrivelse lander som source i Trail.

### iOS Share Extension Arkitektur

```
apps/ios-share-extension/
├── ShareExtension/
│   ├── Info.plist              # NSExtension: NSExtensionActivationRule
│   ├── ShareViewController.swift    # UI: KB selector, preview, tags
│   ├── ShareViewModel.swift         # Upload logic, auth via App Group
│   └── Assets.xcassets/             # Extension icon (29pt, 58pt, 87pt)
├── Shared/
│   └── TrailConfig.swift            # App Group shared defaults (server URL, token)
└── Package.swift
```

**Flow:**
1. Brugeren trykker "Del" i Fotos/Safari/Instagram/etc.
2. "Trail Clipper" vises i share sheet (hvis installeret)
3. Extension åbner med preview af indholdet (tekst, billede thumbnail, URL)
4. Bruger vælger KB (cached fra sidste gang) + tilføjer tags
5. Trykker "Clip" → POST til Trail API
6. Bekræftelse → extension lukker

**Auth:** Deler `serverUrl` og `token` med hoved-appen via **App Group** (`group.com.broberg.trail`). Brugeren logger ind i hoved-appen én gang, og extensionen får adgang til credentials.

**Input-typer der understøttes:**
- `public.url` — links fra Safari, Instagram, Twitter, etc.
- `public.text` — tekst fra Notes, Messages, etc.
- `public.image` — billeder fra Fotos, kamera, screenshots
- `public.url` + `public.text` — URL med preview-tekst (Safari reader mode)

### Server-side Vision Pipeline

Når et billede uploades via share extension:

1. Extension sender billedet som multipart upload til `/api/v1/knowledge-bases/:kbId/documents/upload`
2. Serveren genkender billedtypen → sender til vision backend (allerede eksisterende: `apps/server/src/services/vision.ts`)
3. Vision AI returnerer beskrivelse + OCR-tekst
4. Markdown source oprettes med: frontmatter (title, source, clippedAt, tags) + vision-beskrivelse + OCR-tekst
5. Ingest trigger automatisk

**Cost:** ~$0.02-0.05 per billede med Anthropic Sonnet 3.5. Ved 50 billeder/dag = $1-2.50/måned.

### Android Share Extension

Tilsvarende arkitektur med Kotlin:

```
apps/android-share-extension/
├── app/
│   ├── src/main/
│   │   ├── AndroidManifest.xml      # <intent-filter> ACTION_SEND
│   │   ├── kotlin/.../ShareActivity.kt
│   │   └── res/
│   └── build.gradle.kts
└── gradle/
```

## Technical Design

### API: Upload med billed-metadata

Den eksisterende upload-endpoint (`POST /api/v1/knowledge-bases/:kbId/documents/upload`) understøtter allerede `metadata` feltet. Share extension sender:

```json
{
  "connector": "share-extension",
  "sourceUrl": "https://www.instagram.com/p/ABC123/",
  "clippedAt": "2026-04-22T18:00:00Z",
  "tags": ["instagram", "screenshot"],
  "platform": "ios",
  "sourceApp": "Photos"
}
```

### iOS: App Group deling

```swift
// Shared/TrailConfig.swift
import Foundation

public struct TrailConfig {
    static let appGroup = "group.com.broberg.trail"
    static let defaults = UserDefaults(suiteName: appGroup)!

    public static var serverUrl: String? {
        get { defaults.string(forKey: "serverUrl") }
        set { defaults.set(newValue, forKey: "serverUrl") }
    }

    public static var token: String? {
        get { defaults.string(forKey: "token") }
        set { defaults.set(newValue, forKey: "token") }
    }
}
```

Hoved-appen (når den bygges) skriver credentials til App Group. Extensionen læser dem.

### iOS: ShareViewController

```swift
import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {
    var selectedKbId: String?
    var tags: String = ""

    override func isContentValid() -> Bool {
        return TrailConfig.serverUrl != nil && TrailConfig.token != nil
    }

    override func didSelectPost() {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = item.attachments else {
            completeRequest()
            return
        }

        // Extract content from attachments (URL, text, image)
        extractAndUpload(attachments)
    }

    private func extractAndUpload(_ attachments: [NSItemProvider]) {
        // 1. Try URL
        // 2. Try text
        // 3. Try image → upload to vision pipeline
        // 4. POST to Trail API
        // 5. completeRequest()
    }
}
```

### Vision Pipeline Integration

Den eksisterende vision backend (`apps/server/src/services/vision.ts`) kan genbruges direkte. Billeder fra share extension uploades som normale billed-sources og trigger den samme pipeline som PDF-billeder.

**Forskellen:** Share extension uploader billeder direkte (ikke som del af PDF), så vi skal sikre at `processImageAsync` (eller tilsvarende) findes. I dag håndterer upload-routen kun tekst-filer synkront og PDF/DOCX/PPTX/XLSX async. Billeder lander som `status='pending'` uden videre behandling.

**Fix nødvendig:** Tilføj `processImageAsync` i upload-routen der:
1. Sender billedet til vision backend
2. Gemmer beskrivelsen som `content` på document-rækken
3. Trigger ingest

### Connector

Tilføj `share-extension` til `packages/shared/src/connectors.ts`:

```typescript
'share-extension': {
  label: 'Share Extension',
  status: 'live',
  hint: 'Content shared from iOS or Android share sheet — text, links, or images from any app.',
},
```

## Impact Analysis

### Files affected

**Created:**
- `apps/ios-share-extension/` — hele iOS share extension projektet
- `apps/android-share-extension/` — hele Android share extension projektet

**Modified:**
- `apps/server/src/routes/uploads.ts` — tilføj `processImageAsync` for billed-upload med vision
- `packages/shared/src/connectors.ts` — tilføj `share-extension` connector

### Downstream dependents

`apps/server/src/routes/uploads.ts` — ingen direkte downstream dependents. Det er en leaf route.

`packages/shared/src/connectors.ts` — importeret af:
- `apps/admin/src/` (queue filter, neuron reader attribution) — unaffected, ny connector vises automatisk
- `packages/core/src/queue/candidates.ts` (`stampConnector`) — unaffected, håndterer nye ids automatisk

### Blast radius

- **Upload route ændring:** `processImageAsync` er additiv — påvirker ikke eksisterende PDF/DOCX/tekst-pipelines
- **Connector tilføjelse:** Ingen breaking changes — nye connectors er altid additive
- **App Group:** Kræver at hoved-appen (når den bygges) deler samme App Group ID. Ikke et problem i dag da der ikke er nogen iOS app endnu.

### Breaking changes

Ingen.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck`
- [ ] Billed-upload med vision: upload et billede via curl med `metadata.connector=share-extension` → verificer at content indeholder vision-beskrivelse
- [ ] Connector vises i admin queue filter
- [ ] iOS share extension: test med tekst, URL og billede fra share sheet
- [ ] Android share extension: test med tekst og billede

## Implementation Steps

1. **Server: billed-upload med vision** — tilføj `processImageAsync` i `uploads.ts` der sender billeder til vision backend og gemmer beskrivelsen som content
2. **Server: connector** — tilføj `share-extension` til `connectors.ts`
3. **iOS: share extension** — Swift/SwiftUI projekt med ShareViewController, App Group config, upload logic
4. **iOS: test** — build til simulator, test share sheet med tekst, URL og billeder
5. **Android: share extension** — Kotlin projekt med ShareActivity, upload logic
6. **Android: test** — build til emulator, test share sheet

## Dependencies

- F111 (Web Clipper) — allerede shipped, deler samme upload-endpoint
- Vision backend (`apps/server/src/services/vision.ts`) — allerede eksisterende
- Ingen nye server-endpoints nødvendige

## Effort Estimate

**Large** — 5-7 dage

- Server-side billed-upload med vision: 1 dag
- iOS share extension: 2-3 dage (Swift, App Group, UI, upload)
- Android share extension: 2 dage (Kotlin, UI, upload)
- Test + polish: 1 dag
