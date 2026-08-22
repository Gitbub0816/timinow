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

`public/map.js` is the single source of truth. The iOS app reads a bundled JSON
copy at `Sources/TimiNowUI/Resources/instruction-phrases.json`, generated from
it by:

```bash
npm run sync:phrases
```

`scripts/validate.mjs` fails the build if the copy is stale, so the two clients
cannot drift. **To change wording, edit `public/map.js` and re-run that
command.** No Swift edit is required.

### The five tables

| Table | What it does |
| --- | --- |
| `INSTRUCTION_PHRASES` | Keyed by Mapbox's maneuver id (`turn`, `depart`, `arrive`, `merge`, `on ramp`, `off ramp`, `fork`, `roundabout`, `continue`, `new name`) |
| `INSTRUCTION_OVERRIDES` | Keyed `"maneuver:modifier"`, for pairings the generic template cannot say naturally |
| `MODIFIER_WORDS` | Mapbox's raw directions, said the way a person says them |
| `SIDE_WORDS` | The same directions reduced to a side, for ramps, merges, and forks |
| `TIMI_ANNOUNCEMENTS` | Tími's own lines, by register then by moment |

Placeholders: `{modifier}`, `{side}`, `{road}`, `{clinic}` in instructions;
`{clinic}`, `{pet}`, `{minutes}`, `{kind}` in announcements.

A template whose placeholders cannot all be filled produces **nothing**, and the
caller falls back to Mapbox's own wording. That is deliberate: a half-built
sentence is worse than a plain one. It also means an optional flourish — the
`halfway` line with no minutes estimate — simply goes unsaid.

### Two rules, enforced by the build

**1. Maneuvers are never funny.** A driver gets one pass at "turn left onto
Foothill" with a sick animal in the back seat. Instruction templates read
naturally and carry no wordplay.

**2. Personality scales inversely with urgency.** Announcements come in three
registers, chosen from the intake's urgency rather than from a setting, so
nobody has to have turned something off to avoid a joke on the worst day of
their year:

| Register | Urgency | Voice |
| --- | --- | --- |
| `calm` | `same_day` | Warm, and allowed its wordplay |
| `urgent` | `urgent` | Warm, focused, no wordplay |
| `emergency` | `emergency` | Clear and nothing else |

`scripts/validate.mjs` fails the build if playful wording appears in the urgent
or emergency register, or if the calm register goes entirely flat. The rule is
structural, not a style note someone has to remember.

On the native side the register is `NavigationTone`, derived by
`NavigationTone.forUrgency(_:)` and threaded down to `TimiSpeechSynthesizer`.
On the web it is `toneFor(urgency)` in `map.js`, read by `navigationTone()` in
`app.js`.

### Where the rewrite happens

`TimiSpeechSynthesizer.rewritten` in `VoiceController.swift`, on every spoken
instruction. `RouteStep.maneuverType` is a `String`-backed enum whose raw values
are exactly the phrase-table keys, so reading `rawValue` rather than
pattern-matching case names keeps this working across SDK releases and lets one
JSON file drive both clients.

Arrival replaces the line entirely rather than rephrasing it — what matters on
arrival is what to say at the front desk. The `approaching` line is appended
once, inside the last 400 m.

Both `text` and `ssmlText` are produced from the same finished sentence. The
cloud voice speaks the SSML and the on-device voice speaks the text, so
generating one from the other is what stops them saying different things
depending on signal.

## Adding or swapping voices

The default is the best voice the device has, not the one the OS hands out
first. That distinction is most of what separates guidance that sounds
synthetic from guidance that sounds like a person, and it costs nothing.

- **iOS**: `VoicePreviewer.bestVoice()` returns the highest-quality installed
  voice for the app's language. `AVSpeechSynthesisVoice(language:)` — the
  obvious call — returns the *compact* voice on most devices, which is the flat,
  clipped one people recognise as robotic. Settings → Navigation lists every
  installed voice with its tier (`Premium`, `Enhanced`), plus Personal Voice
  once `VoicePreviewer.requestPersonalVoiceAuthorization()` has been called.
- **Web**: `VoiceGuide.rank()` scores the browser's unordered voice list by
  name — `Natural`/`Neural` and `Premium`/`Enhanced` score highest, novelty and
  `compact` voices score negative, and network voices get a small bonus because
  they are usually the higher-fidelity ones. `VoiceGuide.bestVoice()` is used
  until a driver picks their own.
- **Cloud voice**: `TimiSpeechSynthesizer` composes Mapbox's standard
  arrangement through `MultiplexedSpeechSynthesizer`'s convenience initializer
  — cloud first, on-device fallback — installed via
  `CoreConfig(ttsConfig: .custom(speechSynthesizer:))`. Set
  `NavigationPreferences.voiceProfile` to `.systemDefault` to skip the cloud
  entirely, which also skips Mapbox Speech charges.
- **Pacing**: `ssmlFor` / `TimiInstructionRewriter.ssml(for:tone:)` wrap each
  line in `<prosody>` at 94% (calm), 97% (urgent), or 100% (emergency), with a
  320 ms break at every sentence boundary. Whole sentences read at default rate
  land as one anxious run-on; this is the cheapest fix for that.
- **Rate and pitch**: `NavigationPreferences.speechRate` / `.speechPitch`,
  exposed as sliders, multiply the register's own rate.

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
