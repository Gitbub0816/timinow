# Native navigation architecture

Covers the customer iOS app's map, turn-by-turn navigation, CarPlay, and
Watch companion — everything added on top of `docs/NATIVE-CLIENTS.md`.
Written without access to a Mac, Xcode, or a Mapbox account, so every claim
about an exact Mapbox API shape below is labeled with its confidence level;
build and verify on a Mac before shipping.

## What ships where

| Piece | File(s) |
| --- | --- |
| Skip-safe navigation/voice models | `Sources/TimiNowCore/NavigationModels.swift` |
| Map (offer comparison + tracker) | `Sources/TimiNowUI/ClinicMapView.swift` |
| Turn-by-turn | `Sources/TimiNowUI/NavigationView.swift` |
| Voice (rewrite table + synthesizer) | `Sources/TimiNowUI/VoiceController.swift`, `Sources/TimiNowUI/Resources/instruction-phrases.json` |
| Settings → Navigation section | `Sources/TimiNowUI/SupportViews.swift` |
| Watch → phone bridge (phone side) | `Sources/TimiNowUI/WatchBridge.swift` |
| CarPlay scene | `Sources/TimiNowCarPlay/CarPlaySceneDelegate.swift`, `Darwin/Sources/CarPlayBridge.swift` |
| Watch app | `Watch/` (separate Xcode target, no SwiftPM dependency) |

## Mapbox products and tokens

Two SPM packages, gated behind `TIMI_MAPBOX=1` in `Package.swift` (see
below):

- **`mapbox-maps-ios`** (`from: "11.26.0"`) → product `MapboxMaps`, used by
  `ClinicMapView.swift` for the offer-comparison and tracker maps.
- **`mapbox-navigation-ios`** (`from: "3.27.0"`) → products
  `MapboxNavigationCore` and `MapboxNavigationUIKit`, used by
  `NavigationView.swift` for turn-by-turn and by `TimiNowCarPlay` for the
  CarPlay map/guidance templates. It depends on `mapbox-maps-ios`
  transitively; both are still declared explicitly so the product names
  above resolve directly.

Two kinds of Mapbox token, per `docs/PLATFORM-CONTRACT.md`'s
`GET /api/config` → `map` block:

- **Public token (`pk.…`)** — used at runtime to load the style and make
  Directions/Navigation requests. Delivered by `/api/config`, never checked
  in. `AppStore.loadMapConfig()` fetches it into `AppStore.mapToken`; the
  compiled-in `MapDefaults.styleURL` is the fallback style URL until that
  call resolves (or in demo mode, where it's the only value ever used).
- **Secret downloads token (`sk.…`, scope `DOWNLOADS:READ`)** — required by
  Xcode/SwiftPM (and Gradle, for the Android side of a Skip build that ever
  turns Mapbox on) to *download the SDKs themselves* from Mapbox's package
  registry. This is an account-level credential, distinct from the public
  runtime token, and must never be committed. It goes in `~/.netrc` on the
  build machine:

  ```
  machine api.mapbox.com
  login mapbox
  password sk.<your-secret-downloads-token>
  ```

### Why the Mapbox dependency is conditional

`Package.swift` only appends the two Mapbox packages (and their products on
`TimiNowUI`/`TimiNowCarPlay`) when the environment variable `TIMI_MAPBOX=1`
is set at manifest-evaluation time:

```swift
let enableMapbox = ProcessInfo.processInfo.environment["TIMI_MAPBOX"] == "1"
```

With the flag unset — the default everywhere, including this repository's
CI — `swift package resolve` and `swift test --filter ConcernValidatorTests`
never touch the Mapbox packages at all, so they work on a machine with no
Mapbox account and no `~/.netrc` entry. Every Mapbox import in the source is
additionally guarded with `#if canImport(MapboxMaps) && !SKIP && os(iOS)`
(or the navigation/CarPlay equivalents), so the app, `TimiNowCarPlay`, and
the Skip/Android build all compile against a non-Mapbox fallback path in
that configuration — the ordinary `maps.apple.com` hand-off for navigation,
and a ranked list card instead of a live map.

**To build with real Mapbox maps and navigation on a Mac:**

```
export TIMI_MAPBOX=1
# ~/.netrc must already have the sk. downloads token above
cd apps/customer-mobile/Darwin && xcodegen generate && cd ..
SKIP_BRIDGE=1 swift package resolve
xcodebuild -workspace Darwin/Project.xcworkspace -scheme TimiNow \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
```

CI (`.github/workflows/native-clients.yml`) does **not** set `TIMI_MAPBOX`,
so its `ios` job builds and runs `ConcernValidatorTests` against the
non-Mapbox fallback path only. Exercising the real Mapbox build currently
requires a local Mac with the secret token configured.

## Changing driving-instruction wording

`Sources/TimiNowUI/Resources/instruction-phrases.json` is the single source
of truth, mirrored exactly (same keys, same wording) from the web client's
table in `public/map.js` (`INSTRUCTION_PHRASES` / `TIMI_ANNOUNCEMENTS`), so
the web and native apps say the same things:

```json
{
  "instructionPhrases": { "depart": "Head {modifier} on {road}", "arrive": "…", "turn": "…", … },
  "timiAnnouncements": { "start": "…", "halfway": "…", "approaching": "…", "arrival": "…" }
}
```

- `instructionPhrases` is keyed by Mapbox's maneuver `type` and rewrites
  ordinary turn-by-turn steps. `{modifier}` / `{road}` / `{clinic}` are the
  placeholders.
- `timiAnnouncements` are lines Tími adds that Mapbox would never say —
  `{clinic}` / `{pet}` / `{minutes}` / `{kind}` placeholders. `{kind}` comes
  from the clinic's `kind` field (`"urgent"`, `"emergency"`, …).

**To change wording: edit the JSON file only.** No Swift recompile is
required beyond re-bundling the resource (`TimiNowUI`'s
`resources: [.process("Resources")]` already picks it up).
`TimiInstructionRewriter` in `VoiceController.swift` loads it via
`Bundle.module` at first use and falls back to
`InstructionPhraseTable.fallback` (a Swift-literal copy of the same table)
if the resource is ever missing, so a bad edit degrades to the built-in
copy rather than crashing.

The actual rewrite applied while driving (`TimiSpeechSynthesizer.rewritten`
in `VoiceController.swift`) currently does the two things called out
explicitly: it replaces Mapbox's own "you have arrived" wording with the
`arrival` announcement, and appends the `approaching` announcement once the
route has under ~400 m left (`RouteLegProgress.distanceRemaining`, a stable
property across Navigation SDK versions). The full per-maneuver
`instructionPhrases` table is loaded and ready to use — wiring it to
*replace* every turn (not just arrival/approach) needs
`RouteLegProgress.currentStep`'s maneuver-type/modifier/road-name accessors
confirmed against the installed SDK first; the exact property names were
not independently verified here. See the `NOTE ON VERIFICATION` comments in
`VoiceController.swift` and `NavigationView.swift`.

## Adding or swapping voices

- **Device (AVSpeech) voices**: `VoicePreviewer.availableVoices()` in
  `VoiceController.swift` enumerates `AVSpeechSynthesisVoice.speechVoices()`
  filtered to the app's language, sorted premium/enhanced first. They
  appear automatically in Settings → Navigation → "Device voice" — nothing
  to wire up when Apple ships new voices or the user installs Personal
  Voice (`VoicePreviewer.requestPersonalVoiceAuthorization()` must be
  called once to surface Personal Voice entries).
- **Cloud voice**: `TimiSpeechSynthesizer` composes Mapbox's standard
  arrangement — confirmed against a local clone of `mapbox-navigation-ios`
  (`Sources/MapboxNavigationCore/VoiceGuidance/SpeechSynthesizing.swift`) —
  `MultiplexedSpeechSynthesizer([MapboxSpeechSynthesizer(), SystemSpeechSynthesizer()])`,
  cloud first with on-device fallback, installed via
  `CoreConfig(ttsConfig: .custom(speechSynthesizer:))` and
  `MapboxNavigationProvider(coreConfig:)`. To swap which voice is primary,
  change `NavigationPreferences.voiceProfile` (`.mapboxCloud` vs.
  `.systemDefault`/`.systemEnhanced`/`.personalVoice`) — `TimiSpeechSynthesizer`
  reads that preference when it's constructed in
  `NavigationHostController.presentNavigation`.
- **Rate/pitch**: `NavigationPreferences.speechRate` /
  `.speechPitch`, exposed as a slider in Settings, feed `VoicePreviewer`'s
  `AVSpeechUtterance` directly (`utterance.rate`, `.pitchMultiplier`).

## CarPlay: exact entitlement situation

`com.apple.developer.carplay-driving-navigation` is a **restricted**
entitlement. It is declared in `Darwin/TimiNow.entitlements` and referenced
from `Darwin/project.yml`'s `CODE_SIGN_ENTITLEMENTS`, and the CarPlay scene
is registered in `Darwin/Info.plist`. None of that makes it work by itself:

1. Apple only grants this entitlement after a developer submits a **separate
   CarPlay entitlement request** through the Apple Developer account
   (Certificates, Identifiers & Profiles → request additional capabilities),
   describing the navigation use case, and Apple's review approves it. This
   can take substantial time and is not guaranteed.
2. Until approval lands for this app's bundle ID
   (`solutions.clearkey.timinow`), Xcode cannot create or download a
   provisioning profile that satisfies the entitlement, so **device and
   archive builds will fail to sign**.
3. **Simulator builds are unaffected** — CI builds with
   `CODE_SIGNING_ALLOWED=NO`, which skips entitlement enforcement entirely,
   so `CarPlaySceneDelegate` compiles and the app builds in CI regardless of
   Apple's approval state.
4. Without the grant, iOS never instantiates a `CPTemplateApplicationScene`
   at all — `CarPlaySceneDelegate` is inert, not merely feature-flagged off.

**Status: not yet requested/approved.** This is the single largest blocker
to shipping the CarPlay feature to a real device or TestFlight/App Store
build.

## How the Watch app pairs

`Watch/` is a separate, single-target watchOS 10+ Xcode app (no
Complication/widget in this MVP) embedded into the iOS app via
`Darwin/project.yml`'s `TimiNowWatch` target
(`WKCompanionAppBundleIdentifier` = `solutions.clearkey.timinow`). Pairing
itself is standard iOS/watchOS behavior — once a paired Watch has the
companion app installed (automatically offered once the phone app installs,
or manually from the Watch app on iPhone), `WCSession` activates on both
sides with no additional code.

State flows one way, phone → Watch, over `WCSession.updateApplicationContext`:

- Phone: `Sources/TimiNowUI/WatchBridge.swift` uses the
  `withObservationTracking` idiom to react to `AppStore`'s `@Observable`
  state from outside a SwiftUI view body, re-subscribing itself on every
  change, and pushes `CareSearch` / `CareIntake` / the current
  `NavigationStepModel` / `RouteSummary` / the selected pet as JSON blobs.
- Watch: `Watch/WatchSessionBridge.swift` defines its own small `Codable`
  mirrors of just the fields it needs (property names matching
  TimiNowCore's real models, so `JSONDecoder` reads the same JSON directly)
  and decodes them in `session(_:didReceiveApplicationContext:)`.

Milestone buttons (arrived / triaged / seen) flow the other way, Watch →
phone, over `WCSession.sendMessage`, and are relayed through the *same*
`AppStore.record(_:)` path (and therefore the same Worker API call) the
phone's own tracker buttons use — see the `didReceiveMessage` handler in
`Sources/TimiNowUI/WatchBridge.swift`.

Haptic feedback (`WKInterfaceDevice.current().play(.notification)`) fires
in `WatchSessionBridge.apply(_:)` when the mirrored offer count increases or
an intake transitions to accepted.

**Why the Watch target has no SwiftPM dependency**: `TimiNowCore` depends on
`SkipFuse`/`SkipModel`, whose watchOS support was not verified here. Keeping
`Watch/` fully self-contained (its own tiny model mirrors, no package
dependency) avoids that risk entirely rather than betting the Watch build
on an unverified cross-platform claim.

## Mapbox pricing dimensions

Two separately metered products apply here, both billed by Mapbox directly
(not something this codebase config controls beyond which SDKs it uses):

- **Navigation SDK (mobile, `mapbox-navigation-ios`)** — billed per **trip**
  (one turn-by-turn session) above a monthly free trip allotment, *or* by
  **MAU** (monthly active users of the navigation feature) depending on the
  account's plan — confirm which metric applies to this Mapbox account
  before launch, since the two have very different cost profiles at scale.
- **Directions API** (used by the web client's `fetchRoute` in
  `public/map.js`, and by `RoutePreviewFetcher`'s route-preview calls on the
  native side) — billed **per request**, independent of the Navigation
  SDK's trip/MAU metering. A route preview shown on the tracker screen
  before a rider taps "Navigate" counts as a Directions request even if
  they never start turn-by-turn.

Mapbox Maps SDK map loads (`ClinicMapView`, the web `renderClinicMap`) are
billed per map load, separately again. Check the current Mapbox pricing
page for exact thresholds and rates before estimating cost at scale — they
change independently of this app's code.

## What still needs a Mac, Xcode, or an external approval

- **Everything Mapbox-specific** — this was written without Swift
  compilation available; re-verify the API calls flagged `NOT
  independently re-verified` in `NavigationView.swift`,
  `ClinicMapView.swift`, and `VoiceController.swift` (mainly the exact
  `MapboxNavigationProvider` → routing-provider/`NavigationOptions` call
  chain, `NavigationRoutes`'s shape, and `MapboxSpeechSynthesizer()`'s
  initializer) against the installed SDK version.
- **A Mapbox secret downloads token** in `~/.netrc`, to actually fetch the
  SDKs with `TIMI_MAPBOX=1` set.
- **CarPlay entitlement approval from Apple** (see above) before any device
  or App Store build can sign.
- **A paired Apple Watch + a Mac with the watchOS 10 simulator/SDK** to
  build and test `Watch/` beyond CI's simulator build.
- **Xcode project generation and a full build** (`xcodegen generate` +
  `xcodebuild`) to catch any remaining compile errors this review could not
  catch without a Swift toolchain.
