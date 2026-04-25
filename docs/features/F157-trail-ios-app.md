# F157 — Trail iOS App

> A dedicated native iPhone + iPad app that turns the phone into Trail's primary capture surface — voice dictation, camera scans, quick text notes — and into a passive consumption surface via Home Screen widget, voice-to-voice chat, and Shortcuts integration. Tier: Pro+. Effort: Large (3-4 weeks for MVP; continuing iteration). Status: Planned.

## Problem

Trail's capture story today ends at the desktop browser: dropzone upload, web clipper (F111), MCP writes from cc sessions, share-sheet-to-come (F147). Every one of these requires sitting at a computer or being inside another app on mobile that happens to support a share target. The phone — the device Christian and every future Trail customer carry most of their waking hours — has no first-class relationship with Trail.

Three concrete symptoms:

1. **Ideas die between the shower and the laptop.** The single most common "I should capture that" moment is mid-walk, mid-drive, mid-meeting. The friction to open a browser, log in, find the right Trail, and type a markdown note is enough that 80%+ of those moments never reach a Neuron. Voice dictation is the obvious answer, but only as a native OS-level capability — a web app's microphone button is worse than not having one at all (permissions prompt every load, tab-backgrounding kills recording, no Lock-Screen shortcut).
2. **Physical documents can't get in.** A whiteboard in a meeting, a page of a book Christian's reading, a client's paper case notes — all should be single-tap scans that become Sources. Apple's `VisionKit` has been the de-facto document scanner since iOS 13; a Trail mobile app gets that for free.
3. **The curator workflow never leaves the desk.** The queue + Neuron reader is genuinely useful reading material — but today "I'll review the queue" means "I'll open my laptop later." On a phone you could swipe-approve a week of candidates on the train. That's the difference between a tool you use weekly and one you use daily.

A pure web app on mobile Safari will never reach parity with these flows — the OS-level primitives aren't in the browser sandbox. Apple deliberately draws the line there.

## Secondary Pain Points

- **No passive surface.** Trail has no presence on Christian's phone unless he actively opens a browser. A Home Screen widget showing "3 candidates pending" or "last Neuron you read" would change the relationship from "tool I visit" to "environment I live in."
- **No voice chat.** Multi-turn chat (F144, fixed in turn #125 this session) is now coherent, but "type my question into a web input" is a bad fit for a walking user. Voice-in → voice-out chat with your Trail is the natural mobile form.
- **No Siri / Shortcuts integration.** Apple's automation platform lets users wire Trail into their own flows — "when I finish a meeting, run this Shortcut that dictates a summary into Work Trail." Web apps can't participate in that graph; native apps can.
- **F147's share extension is blocked on shell.** The share extension (F147) needs an app container to live inside — iOS won't let you ship a standalone share target without a parent app. F157's app chassis is what unblocks F147 from "idea" to "ship."
- **Consumer-grade polish signals legitimacy.** A Trail customer (Sanne, FysioDK) looking up the product will ask "is there an app?" If the answer is "open your browser and bookmark it," the perceived seriousness drops. Having a real app in the App Store — even at MVP scope — is a sales asset disproportionate to its engineering cost.

## Solution

Ship a native SwiftUI iOS app (iPhone + iPad) whose MVP scope is the five features with the highest capture + consumption leverage that only a native app can deliver. Everything talks to the existing Trail server over HTTPS + Bearer token (F111.1) — no new server-side infrastructure needed beyond a new connector id `ios-app` and one `POST /api/v1/knowledge-bases/:kbId/sources` codepath that accepts multipart uploads (already exists for web upload). Share Extension (F147) rides in the same Xcode project as a target once F157's main app ships.

MVP top 5 (ordered by leverage):

1. **Voice → Neuron** (Apple `Speech` framework, on-device STT for privacy + speed).
2. **Camera scan → Source** (`VisionKit.VNDocumentCameraViewController`, same API Apple's Notes app uses).
3. **Home Screen Widget** showing pending queue count + last-accessed Neuron (WidgetKit, iOS 17+ interactive).
4. **Voice-to-voice chat** (Speech → existing `POST /api/v1/chat` → `AVSpeechSynthesizer` neural voice).
5. **Shortcuts + Siri integration** via `AppIntents` — "Add to Trail" and "Ask Trail" actions.

Everything else listed in the brainstorm (swipe-to-approve queue, Apple Watch, Live Activity, Listen Mode, Spotlight, Focus filters, geo-tagging, custom keyboard, AirDrop, Files-app provider, Lock Screen / Control Center capture) lands as Iteration 2+ after MVP validates the form factor.

## Non-Goals

- **Offline mode.** MVP is online-only — every capture POSTs immediately to the cloud server. Offline queueing, background retry, and local read-cache are Iteration 3 scope. Rationale: offline correctness interacts with F146 CRDT sync and deserves its own design pass.
- **Local LLM compilation on the phone.** The phone is a capture + consume surface, not a compute surface. Ingest compilation happens on the server, as it does for every other connector. F146 (desktop native) is where local compilation lives.
- **Android parity.** MVP ships iOS-only. Android is a Phase 3 continuation; the server API is already platform-neutral, so an Android app is a shell re-implementation, not a re-architecture.
- **In-app Neuron editor.** Reading + search yes. Full markdown editing with `[[wiki-link]]` autocomplete is Iteration 2 — authoring on a phone keyboard is a bad enough experience that trying to match the web editor's ergonomics would be wasted effort at MVP.
- **In-app credential provisioning / OAuth.** MVP uses Bearer-token paste on first launch (F111.1 admin-generated keys). Proper sign-in-with-Google + device-registration comes with F33/F35 prod OAuth and the multi-tenant identity work in F40.2.
- **Push notifications.** Requires APNs certificate + server-side push infra. Valuable but out of MVP scope; the Home Screen widget covers the primary "did something happen?" signal without needing APNs.
- **Apple Watch companion.** Same reasoning as Android — a future continuation, not MVP. Voice capture on Watch is valuable but the primary voice story lives on the phone.
- **In-App Purchase / App Store billing.** F156 (credits-based metering) is the billing surface. iOS app reads the user's tenant plan via the existing `/api/v1/me` endpoint; any future IAP integration is strictly additive.
- **Deep customization of what gets captured.** MVP assumes one active Trail at a time (user picks it in settings or via long-press on app icon). Multi-Trail routing UI — "this went to Sanne, that went to Work" — is Iteration 2.

## Technical Design

### Repo layout

New top-level Xcode project sibling to the existing TypeScript apps. Doesn't join the pnpm workspace (Xcode manages its own dependency graph):

```
apps/ios/                                ← new, NOT a pnpm workspace
  Trail.xcodeproj/                       ← Xcode project (ignored SUBTREES in .gitignore)
  Trail/                                 ← main app target
    App/
      TrailApp.swift                     ← SwiftUI @main
      AppState.swift                     ← env: active kb, api token, user
    Networking/
      TrailAPI.swift                     ← async/await HTTP client
      Endpoints.swift                    ← typed paths + request bodies
      Auth.swift                         ← iCloud Keychain store for bearer token
    Capture/
      VoiceCaptureView.swift             ← SFSpeechRecognizer, push-to-talk UI
      DocumentScanView.swift             ← VNDocumentCameraViewController wrapper
      QuickTextView.swift                ← markdown field + [[...]] autocomplete
    Chat/
      ChatView.swift                     ← main chat surface
      VoiceChatView.swift                ← STT → chat API → TTS loop
      ChatSessionStore.swift             ← local cache of last N sessions
    Neurons/
      NeuronListView.swift
      NeuronReaderView.swift
    Settings/
      SettingsView.swift                 ← api token, active kb selector, server url
    Shared/
      Models.swift                       ← Swift-side mirror of shared types
      TrailError.swift
      DesignSystem.swift                 ← colors, fonts matching web admin
  TrailWidget/                           ← WidgetKit extension target
    TrailWidget.swift
    WidgetTimeline.swift                 ← /queue poll + cache
  TrailIntents/                          ← AppIntents extension target
    AddToTrailIntent.swift
    AskTrailIntent.swift
  Tests/                                 ← XCTest unit + UI
```

### Authentication

Bearer-token-based via F111.1 (already shipped): admin generates a per-user API key with `trail_<64hex>` prefix, user pastes it into the iOS app's Settings on first launch. Token is stored in **iCloud Keychain** (`kSecAttrSynchronizable = true`) so it roams to the user's other Apple devices. No OAuth on MVP; we revisit at F35 (OAuth prod).

Every HTTP call attaches `Authorization: Bearer <token>`. The engine's existing `requireAuth` middleware (`apps/server/src/middleware/auth.ts:42`) handles both session-cookie and bearer paths — the iOS app hits the bearer branch.

### Server-side changes (minimal)

1. **New connector id `ios-app`** in `packages/shared/src/connectors.ts` — one entry with `status: 'live'` so `stampConnector()` in `packages/core/src/queue/candidates.ts` recognises writes from the app. The iOS app passes `"connector": "ios-app"` in every candidate's `metadata`.
2. **No new endpoints.** The app uses these existing routes:
   - `POST /api/v1/knowledge-bases/:kbId/sources` — multipart upload (camera scans, voice-memo audio files)
   - `POST /api/v1/queue/candidates` — direct candidate write (quick text Neurons, transcribed voice notes as `kind: 'external-feed'`)
   - `POST /api/v1/chat` — chat with multi-turn memory (fixed earlier this session, F144 follow-up)
   - `GET /api/v1/knowledge-bases` — Trail picker in Settings
   - `GET /api/v1/queue?status=pending&knowledgeBaseId=...&limit=1` — widget count + preview
   - `GET /api/v1/knowledge-bases/:kbId/search?q=...` — in-app search
   - `GET /api/v1/knowledge-bases/:kbId/documents/:slug` — Neuron reader

### MVP feature breakdown

#### 1. Voice → Neuron (`Capture/VoiceCaptureView.swift`)

- `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` for privacy. Falls back to server STT if on-device locale isn't available.
- Push-to-talk UI: held-button captures, released button stops and shows transcript for edit-then-send.
- POST to `/api/v1/queue/candidates` with `kind: "external-feed"`, `content: <transcript>`, `metadata.connector = "ios-app"`, `metadata.captureKind = "voice"`, `confidence: <apple-stt-confidence>`.
- Trail's F19 auto-approval policy decides if it lands directly or waits for curator review.

#### 2. Camera scan → Source (`Capture/DocumentScanView.swift`)

- `VNDocumentCameraViewController` handles multi-page scan, perspective correction, shadow removal — no custom capture code needed.
- Combine scanned pages into a single PDF via `PDFKit.PDFDocument`.
- Multipart upload to `/api/v1/knowledge-bases/:kbId/sources` with `Content-Type: application/pdf`. Existing F08 PDF pipeline picks it up and compiles Neurons as it does for web uploads.

#### 3. Home Screen Widget (`TrailWidget/`)

- WidgetKit `TimelineProvider` polls `GET /api/v1/queue?limit=1&status=pending` every 15 minutes (iOS's minimum refresh cadence).
- Small family: "N pending" + last-accessed Neuron title (from a local write Christian's main app stamps on each read).
- Medium family: adds top-3 pending candidate titles with swipe-tap deep-link into the app.
- iOS 17 interactivity: "Open Queue" button on the widget itself (direct deep-link, no app-cold-start).

#### 4. Voice-to-voice chat (`Chat/VoiceChatView.swift`)

- Start recording on tap → `SFSpeechRecognizer` transcribes → `POST /api/v1/chat` with the transcript + session id → response text is spoken back via `AVSpeechSynthesizer` using a neural voice (`Daniel (Enhanced)` for en, `Sara (Enhanced)` for da).
- Session id persisted in `ChatSessionStore` (UserDefaults) so the fresh multi-turn memory we just shipped works across recordings.
- One interruption-safe audio session: releases the mic cleanly when Siri or other audio apps take over.

#### 5. Shortcuts + Siri (`TrailIntents/`)

- `AddToTrailIntent: AppIntent` — parameters `(text: String, trail: TrailEntity)`. Registers with the system as "Add to Trail" in the Shortcuts app. Invokable via Siri: "Hey Siri, add to Sanne Trail [dictation]."
- `AskTrailIntent: AppIntent` — parameters `(question: String, trail: TrailEntity)` → hits chat API → returns answer as spoken Siri response + in-app chat-history entry.
- `TrailEntity: AppEntity` — enumerable via `/api/v1/knowledge-bases` so Shortcuts UI offers a Trail-picker when the user configures an action.

### Swift-side API client shape

```swift
// Networking/TrailAPI.swift
struct TrailAPI {
    let baseURL: URL       // e.g. https://app.trailmem.com
    let token: String      // from Keychain

    func createCandidate(kbId: String, body: CreateCandidate) async throws -> Candidate
    func uploadSource(kbId: String, fileURL: URL, mime: String) async throws -> Source
    func chat(kbId: String, message: String, sessionId: String?) async throws -> ChatReply
    func listTrails() async throws -> [KnowledgeBase]
    func pendingCount(kbId: String) async throws -> Int
    func search(kbId: String, q: String) async throws -> SearchResults
    func readNeuron(kbId: String, slug: String) async throws -> Neuron
}
```

All responses decode to Codable structs mirroring `packages/shared/src/types.ts`. Manual keep-in-sync (small surface area); a Swift codegen from Zod is a nice-to-have for Iteration 2.

## Interface

**Public API (against existing Trail server)**: no new endpoints. Existing contracts listed in Technical Design above.

**New connector**: `ios-app` (added to `packages/shared/src/connectors.ts`).

**iOS-to-system surface** (discoverable to users, not to other code):

```
URL scheme:     trail://
Universal Link: https://app.trailmem.com/*    (via apple-app-site-association)

App Intents:
  AddToTrailIntent(text, trail) → Void
  AskTrailIntent(question, trail) → String

Widget kinds:
  "com.trailmem.widget.queue"   ← small + medium families
```

**Apple app metadata**:

```
Bundle id:              com.trailmem.app
Display name:           Trail
Deployment target:      iOS 17.0
Capabilities:           iCloud Keychain, Speech Recognition, Camera
Info.plist purpose strings (App Store Guideline 5.1.1(ii) compliant):
  NSCameraUsageDescription         — "Trail bruger kameraet til at scanne
                                     dokumenter og fotografere whiteboards.
                                     Du kan f.eks. tage et billede af en
                                     side i en bog, som Trail bruger som
                                     Kilde til kompilering af Neuroner."
  NSMicrophoneUsageDescription     — "Trail bruger mikrofonen til at
                                     diktere noter og tale med din Trail.
                                     Du kan f.eks. sige 'Tilføj til Sanne
                                     Trail: husk at følge op med Karen
                                     onsdag', og Trail gemmer det som en
                                     kandidat til din godkendelse."
  NSSpeechRecognitionUsageDescription — "Trail forvandler din tale til
                                     tekst, både til notater og til at
                                     stille spørgsmål. Lokalt på enheden
                                     når muligt."
```

## Rollout

**Phase 1 — Scaffold + auth (2-3 days)**. Create the Xcode project, empty SwiftUI shell, Settings view with bearer-token paste, Trail picker, active-kb display. Exercises the full HTTP path against prod. Ship internal TestFlight build #1.

**Phase 2 — Capture MVP: voice + camera + quick-text (4-5 days)**. The three capture flows that make the app immediately useful. Neurons start landing in the queue from the phone. Ship TestFlight #2.

**Phase 3 — Widget + chat + Shortcuts (4-5 days)**. Home Screen widget, voice-to-voice chat, AppIntents. Ship TestFlight #3.

**Phase 4 — App Store submission (2-3 days)**. Icon set, screenshots, review notes responding to expected Guideline 5.1.1(ii) purpose-string scrutiny, privacy nutrition label, first App Store build. Approvals typically take 1-3 days.

**Connector registration** lands independently in Phase 1 — a one-line change to `packages/shared/src/connectors.ts` — so the server recognises `ios-app` writes from the very first TestFlight build without needing an engine redeploy per phase.

## Success Criteria

1. **Voice capture < 2s to land as candidate**: from "release push-to-talk" to visible row in the admin Queue, end-to-end wall-clock under 2 seconds on a warm app + prod server.
2. **Camera → Source → compiled Neurons < 60s**: scan a 4-page document, arrive at "N Neurons ready for review" in the admin within 60 seconds (F08 PDF pipeline's normal cadence).
3. **Widget refresh accuracy**: pending count on the widget is never more than 15 minutes stale (iOS's TimelineProvider minimum).
4. **Voice chat loop < 8s round trip**: from "stop speaking question" to "TTS starts answering" under 8 seconds for a typical 1-sentence question.
5. **Shortcut integration visible in Siri/Shortcuts**: "Add to Trail" and "Ask Trail" show up with a Trail-picker in the Shortcuts app after first launch.
6. **App Store approval on first submission OR specific reason why not**: either we get through review or we learn exactly which Guideline needs a second pass — no "mystery rejection" that stalls release.
7. **Zero untyped code paths**: Swift compilation is strict — every API response decodes into a Codable struct; no `[String: Any]` maps in the capture paths.
8. **Token never leaves Keychain**: static analysis pass (SwiftLint + manual grep) confirms the bearer token isn't logged, saved to UserDefaults, or embedded in any file path.

## Impact Analysis

### Files created (new)

Server-side (minimal):
- `packages/shared/src/connectors.ts` — edited to add `ios-app` entry (one line, `status: 'live'`). This file exists; the edit is trivial and belongs under "Files modified" — listed here for visibility.

iOS (everything new):
- `apps/ios/Trail.xcodeproj/` — Xcode project bundle (ignored subtrees: `xcuserdata/`, `*.xcworkspace/UserInterfaceState.xcuserstate`)
- `apps/ios/Trail/App/TrailApp.swift`
- `apps/ios/Trail/App/AppState.swift`
- `apps/ios/Trail/Networking/TrailAPI.swift`
- `apps/ios/Trail/Networking/Endpoints.swift`
- `apps/ios/Trail/Networking/Auth.swift`
- `apps/ios/Trail/Capture/VoiceCaptureView.swift`
- `apps/ios/Trail/Capture/DocumentScanView.swift`
- `apps/ios/Trail/Capture/QuickTextView.swift`
- `apps/ios/Trail/Chat/ChatView.swift`
- `apps/ios/Trail/Chat/VoiceChatView.swift`
- `apps/ios/Trail/Chat/ChatSessionStore.swift`
- `apps/ios/Trail/Neurons/NeuronListView.swift`
- `apps/ios/Trail/Neurons/NeuronReaderView.swift`
- `apps/ios/Trail/Settings/SettingsView.swift`
- `apps/ios/Trail/Shared/Models.swift`
- `apps/ios/Trail/Shared/TrailError.swift`
- `apps/ios/Trail/Shared/DesignSystem.swift`
- `apps/ios/Trail/Info.plist` — purpose strings + capability declarations
- `apps/ios/Trail/Assets.xcassets/` — icon set, accent colour, Constellation asset matching web design
- `apps/ios/TrailWidget/TrailWidget.swift`
- `apps/ios/TrailWidget/WidgetTimeline.swift`
- `apps/ios/TrailWidget/Info.plist`
- `apps/ios/TrailIntents/AddToTrailIntent.swift`
- `apps/ios/TrailIntents/AskTrailIntent.swift`
- `apps/ios/TrailIntents/TrailEntity.swift`
- `apps/ios/Tests/TrailAPITests.swift`
- `apps/ios/Tests/CaptureFlowTests.swift`
- `docs/guides/ios-app.md` — developer + operator runbook (provision token, deploy TestFlight, universal-link apple-app-site-association hosting)

### Files modified

- `packages/shared/src/connectors.ts` — add `'ios-app'` entry to `CONNECTORS` constant.
- `.gitignore` — add Xcode noise patterns (`xcuserdata/`, `*.xcuserstate`, `DerivedData/`, `build/`).
- `docs/FEATURES.md` — index row + description section.
- `docs/ROADMAP.md` — entry under Phase 2 (Mobile / capture).

### Downstream dependents

**`packages/shared/src/connectors.ts`** — grep `rg "from.*shared.*connectors" --type ts -l` finds 7 TypeScript importers inside the monorepo:
- `apps/server/src/services/ingest.ts` (1 ref) — validates candidate connector; adding `ios-app` is additive, no change needed.
- `apps/server/src/routes/queue.ts` (1 ref) — uses `CONNECTORS` for filter dropdown; picks up the new entry automatically.
- `apps/admin/src/panels/queue.tsx` (2 refs) — renders connector filter chips; no code change needed beyond whatever cosmetic icon we pick for `ios-app`.
- `apps/admin/src/lib/connector-labels.ts` (1 ref) — label map; may want a Danish label for `ios-app` (edit is trivial).
- `packages/core/src/queue/candidates.ts` (1 ref) — `stampConnector()` inference; already recognises any entry in CONNECTORS, no change needed.
- `apps/mcp/src/index.ts` (1 ref) — MCP server reads the constant for tool docs; unaffected.
- `packages/core/src/lint/orphans.ts` (1 ref) — `isExternalConnector()` check; `ios-app` should be added to the external list (same treatment as `buddy`, `mcp`, `chat`) since Neurons created from an iOS dictation have no Trail-internal Source.

All 7 consumers are unaffected or additively extended — no breaking changes.

**`.gitignore`** — 0 downstream dependents; it's consumed only by Git tooling.

### Blast radius

- **Live Queue UI gains a new connector chip.** If no label is added to `apps/admin/src/lib/connector-labels.ts`, the admin would render `ios-app` raw. Non-breaking but cosmetic; fix is a one-liner.
- **Orphan lint behaviour shift.** If the new connector isn't added to `isExternalConnector()`, dictated voice-Neurons (which legitimately have no Source) would be flagged as orphans — noisy for the curator. Fix is trivial and belongs in the same commit.
- **App Store review is an external gate we don't control.** MVP expectation: first submission may be rejected on purpose-string grammar or on the "substantial functionality" test. Purpose strings are pre-written above to minimise that risk, but the risk isn't zero.
- **Server HTTP surface under load.** iOS app polls `/api/v1/queue?limit=1` from the widget every 15 minutes per install. At 100 users that's ~400 requests/hour — trivial. At 10k users it's 40k/hour ≈ 11 req/s — still trivial, but worth flagging for F33 deploy sizing.
- **Bearer-token security.** The main risk: a token leaking from Keychain (iCloud Keychain sync compromise is the realistic scenario, shared Apple ID another). Revocation via admin UI + the existing `/api/v1/api-keys` DELETE endpoint (F111.1) covers both.

### Breaking changes

**None** — all server-side changes are additive. iOS app is net-new. Existing web admin, MCP clients, and ingest flows see no change beyond the presence of a new connector id they already know how to render.

### Test plan

- [ ] TypeScript compiles: `pnpm typecheck` (after connectors.ts + gitignore edits).
- [ ] Unit (`packages/shared`): `CONNECTORS` includes `ios-app` with `status: 'live'`; existing snapshot tests still pass.
- [ ] Unit (iOS, XCTest): `TrailAPI.createCandidate` posts the correct JSON body including `metadata.connector = "ios-app"`; asserts against a fake `URLProtocol`.
- [ ] Unit (iOS, XCTest): `KeychainAuth` stores + retrieves a token from the iCloud Keychain (uses `kSecAttrSynchronizable`); token is NEVER written to UserDefaults (assert via debug keychain dump).
- [ ] Unit (iOS, XCTest): `SFSpeechRecognizer` transcription path emits a non-empty string for a fixture audio sample.
- [ ] Integration (TestFlight #1): paste a valid bearer token, pick a Trail, observe the Trail name in Settings — confirms the full auth loop against prod.
- [ ] Integration (TestFlight #2): dictate "this is a test neuron from voice" → observe a row in the admin Queue within 2 seconds.
- [ ] Integration (TestFlight #2): scan a 2-page document → observe a Source in the admin + N Neurons emitted by F08 PDF pipeline within 60 seconds.
- [ ] Integration (TestFlight #3): widget shows correct pending count (verified by adding 3 candidates via admin and observing the widget refresh within 15 minutes).
- [ ] Integration (TestFlight #3): Shortcuts app lists "Add to Trail" and "Ask Trail" actions with a Trail-picker populated from `/api/v1/knowledge-bases`.
- [ ] Manual: run "Hey Siri, add to Sanne Trail: follow up with Karen Wednesday" — confirms intent invocation + candidate creation.
- [ ] Manual: chat flow "Hvad er trail?" → "Ja det vil jeg gerne" round-trip via voice — confirms F144 multi-turn memory works through voice chat.
- [ ] Regression: all existing web-admin flows function unchanged after `connectors.ts` edit (smoke test: upload a source via browser, confirm queue entry).
- [ ] Regression: MCP writes from cc sessions still attribute to `mcp:claude-code` (connector inference untouched).
- [ ] Regression: F98 orphan-lint correctly exempts `ios-app` Neurons (same pattern as `chat` + `mcp`).
- [ ] Performance: `pendingCount` endpoint returns p95 < 100ms on prod after the widget goes live (Grafana or Fly.io metrics).

## Implementation Steps

1. **Server-side connector registration** — edit `packages/shared/src/connectors.ts` to add `{ id: 'ios-app', label: 'iOS App', status: 'live' }` and extend `isExternalConnector()` to include it. Admin label map gets a Danish + English entry. Ship this first so the TestFlight #1 build is recognised the moment it POSTs.
2. **Xcode project scaffold** — create `apps/ios/Trail.xcodeproj` with SwiftUI app + widget + intents targets. Set bundle id `com.trailmem.app`, deployment target iOS 17.0. Add capabilities: iCloud Keychain, Speech Recognition, Camera, Background fetch (for widget). Commit to the monorepo.
3. **Networking layer + Settings + token flow** — `TrailAPI.swift`, `Auth.swift`, `SettingsView.swift`. Test against prod by pasting an admin-minted token and listing Trails. Cut TestFlight #1.
4. **Voice capture flow** — `VoiceCaptureView.swift`, microphone + speech permission prompts with the purpose strings above. End-to-end test: dictation → candidate in admin queue.
5. **Camera scan flow** — `DocumentScanView.swift` wrapping `VNDocumentCameraViewController` → PDFKit assembly → multipart upload to `/sources`. Verify F08 pipeline compiles Neurons as expected.
6. **Quick-text capture** — markdown field with `[[...]]` autocomplete; hits `/queue/candidates` with `connector: ios-app`. Cut TestFlight #2 after all three capture flows are green.
7. **Home Screen Widget** — `TrailWidget` target with a `TimelineProvider` polling `/queue?limit=1`. Small + medium families. iOS 17 interactive "Open Queue" deep-link. Verify refresh cadence in practice.
8. **Voice-to-voice chat** — `VoiceChatView.swift` chaining `SFSpeechRecognizer` → `/chat` → `AVSpeechSynthesizer`. Session id persisted in UserDefaults so the server's multi-turn memory (fixed this session) carries across conversations.
9. **Shortcuts + Siri intents** — `AddToTrailIntent`, `AskTrailIntent`, `TrailEntity`. Verify both actions appear in the Shortcuts app with Trail-picker. Cut TestFlight #3.
10. **App Store assets + submission** — icon set (use the constellation mark), 6 screenshots per required device class, privacy nutrition label, review notes explaining the API-key auth model. Submit. Monitor review feedback.
11. **Docs runbook** — `docs/guides/ios-app.md` covering: how to mint an API token for a new user, how to distribute TestFlight builds, how to update apple-app-site-association for universal links, how to rotate the App Store certificate.

## Dependencies

- **F111.1 Bearer API keys** — ✅ shipped 2026-04-22. Provides the auth path the iOS app uses on day one.
- **F144 Chat history + multi-turn memory** — ✅ shipped + fixed this session. Required for voice chat to make sense.
- **F95 Connectors** — ✅ shipped. Provides the attribution framework the iOS app slots into with the new `ios-app` id.
- **F33 Fly.io prod deploy** — not a hard blocker but strongly preferred: an iOS app is a bad fit for a `localhost:58021` backend. TestFlight #1 can point at `trail.broberg.ai` once F33 lands; dev builds can still hit local via a debug settings toggle.
- **F35 Google OAuth production** — soft dependency. With F35 we can swap bearer-token-paste for proper sign-in-with-Google. Not MVP-blocking; MVP ships with paste-token UX.
- **Apple Developer Program membership** — $99/year, must be active before TestFlight/App Store. Confirm Christian's existing Apple Developer account covers the WebHouse entity.

## Open Questions

1. **Organisation for the Apple Developer team** — Christian's personal Apple Developer account, or a WebHouse ApS team account? The bundle id `com.trailmem.app` (or `com.broberg.trail`, or `com.webhouse.trail`) should belong to whichever account we plan to own the App Store listing long-term. Moving a live app between teams later is painful.
2. **Server base URL handling** — hardcode `https://app.trailmem.com` in release builds, allow override in Settings for dev? Or always-configurable? Leaning toward: release build defaults to prod URL, Settings has a hidden "Advanced" section for dev overrides. Confirms before Phase 1 scaffold.
3. **Constellation background** — the web admin uses a subtle star-field. Port to iOS as a SwiftUI Canvas, or skip on MVP? Leaning toward port since it's ~50 lines of Swift and the brand identity matters at launch. Confirm.
4. **Widget refresh budget** — iOS Budget for widget refreshes is opaque and controlled by the system. MVP plan says "every 15 min"; reality might be closer to 30 min under low user engagement. Acceptable for MVP? Propose yes; revisit if users complain.
5. **TestFlight audience** — invitation-only (Christian, Sanne, buddy) or open public TestFlight link? Leaning invitation-only for MVP so we don't collect random feedback before the UX settles.
6. **App Store category** — "Productivity" (obvious) or "Business" (matches F37 Sanne's use case)? Both are defensible; Productivity is the broader appeal. Confirm before submission.
7. **iPad parity** — SwiftUI gets iPhone + iPad from one codebase automatically, but iPad deserves specific layout work (sidebar + detail pane). MVP: ship iPhone-optimised-works-on-iPad; revisit for iPad-optimised Iteration 2.

## Related Features

- **F147 Share Extension** — unblocked by F157. Share-target lives as a separate Xcode target inside the same `apps/ios/Trail.xcodeproj`, sharing the main app's API client + keychain via an App Group. Ship F147 as Iteration 2 immediately after F157 MVP lands.
- **F146 Local-first native app + CRDT sync** — the desktop counterpart. Shares the "native shell around Trail" framing but explicitly targets Mac/Win/Linux with a full engine running locally. F157 is capture + thin client; F146 is capture + compute.
- **F150 Admin Link-Report Panel** — when iOS Neurons are compiled, F148 link-integrity guarantees apply to them too. F150's UI becomes the review surface for any broken links the iOS-originated Neurons produce.
- **F141 Neuron Access Telemetry** — widget's "last-accessed Neuron" query uses F141's access-rollup. Aligned dependency.
- **F156 Credits-based LLM metering** — eventually the iOS app should surface the tenant's credit balance in Settings ("You've used 23% of this month's credits"). Iteration 2.
- **F111 Web Clipper** — same "capture outside the admin" ethos, different platform. Both funnel into the same connector-attribution system (F95).
- **F40.2 Per-tenant libSQL** — when multi-tenant ships, the iOS app's active-Trail selection extends to per-tenant routing. Today it's single-tenant so the decision is just "which of my Trails."
- **F33 Fly.io prod deploy** — soft dependency above; also a precondition for realistic TestFlight usage.

## Effort Estimate

**Large** — **3-4 weeks** for MVP (full-time-equivalent).

Breakdown:
- Phase 1 — scaffold + auth: **2-3 days**
- Phase 2 — capture MVP (voice + camera + quick-text): **4-5 days**
- Phase 3 — widget + voice chat + Shortcuts: **4-5 days**
- Phase 4 — App Store submission cycle (screenshots, review, 1-3 day review + potential re-submission): **2-3 days**
- Buffer for unknowns (iOS/Swift learning curve, Apple's review feedback, design polish): **3-5 days**

Iteration 2 (swipe-queue + Apple Watch + Listen Mode + offline cache) is a further **2-3 weeks** in a follow-up effort.
