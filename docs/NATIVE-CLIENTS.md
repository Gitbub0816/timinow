# Native client architecture

Tími NOW has two intentionally separate native products. Customer care intake belongs in the SwiftUI mobile app; clinic operations belong in the Windows desktop app. Neither client exposes the other role's interface.


## Surfaces

| App | Path | Platform | Role |
| --- | --- | --- | --- |
| Tími NOW | `apps/customer-mobile` | iOS 17+, Skip Fuse ready | Customer intake, offers, map, turn-by-turn, CarPlay, Watch |
| Tími Vet | `apps/vet-windows` | Windows 10/11, .NET 8 WPF | Veterinary operations, tray alerts, floating queue |
| Tími Vet | `apps/vet-desktop` | macOS 14+, SwiftUI | Same console, native NSPanel floating queue, menu-bar item |
| Tími Vet Web | `apps/vet-web` | Any Chromium browser | Same console, Document Picture-in-Picture floating queue |

The three veterinary clients speak the same API and share the same design
tokens. Which one a clinic runs is an operational choice, not a functional one.


## Customer iOS app

Location: `apps/customer-mobile`

The iOS 17+ app is written in SwiftUI and split into app, UI, and core Swift packages. The same modules are configured for Skip Fuse native compilation, without turning the iOS deliverable into a web wrapper.

The guided flow covers onboarding, pet profiles, observable concern detail, consent, search fan-out, comparison of up to five offers, selection, arrival tracking, and legal/safety information. A deterministic concern validator blocks vague requests without sending text to an AI service.

Demo mode is complete and interactive. Live mode uses the existing Cloudflare Worker API. Production release still requires the account-specific Apple signing team, a Clerk mobile session adapter when authentication is enabled, Stripe's native Payment Sheet for real deposits, and APNs server credentials for background pushes. Secret keys must never ship in the app.

## Veterinary Windows app

Location: `apps/vet-windows`

The veterinary app is a native .NET 8 WPF operations console. It publishes capacity, polls the clinic queue, reviews complete customer submissions, sends availability offers or declines, raises tray alerts, and can start with Windows.

Its compact queue is a separate draggable and resizable `Topmost` window. It remains above ordinary windows while visible, can be minimized normally, and can reopen the full review workspace. Users can disable always-on-top at any time.

Demo mode is complete and interactive. Live mode uses the Worker clinic endpoints and the tenant-scoped headers already supported while authentication is disabled. Before production authentication is required, replace development token persistence with Clerk's supported desktop authorization flow and Windows Credential Manager.

## Shared operational contract

- One customer request can fan out to at most 30 matching clinics.
- Multiple clinics can answer during the collection window.
- The customer compares up to five unexpired offers and chooses one.
- Selection is atomic; other offers are released by the Worker.
- Clinic responses communicate operational capacity, not a diagnosis, medical advice, guaranteed appointment, or triage priority.
- Emergency language always instructs customers to call a clinic directly and seek immediate care.

## Building and installing

Four scripts, none of which needs an Xcode window:

| Command | Produces |
| --- | --- |
| `./scripts/build-mac-app.sh` | The veterinary console, signed, in `/Applications`. |
| `./scripts/build-ios-app.sh` | The customer app running on a simulator. No Apple account needed. |
| `./scripts/install-ios-device.sh` | The customer app on an iPhone over USB-C. |
| `./scripts/upload-testflight.sh` | The customer app on TestFlight. |

They share `scripts/lib/apple-build.sh`, which filters xcodebuild's output down
to its phases and prints a heartbeat while it is quiet — the first customer-app
build transpiles the whole Skip stack before Xcode compiles anything, and ten
silent minutes is indistinguishable from a hang.

### On a phone, by cable

Needs an Apple ID signed in under Xcode → Settings → Accounts (a free one is
enough; the app then expires after seven days and re-running the script
reinstalls it), Developer Mode on the phone under Settings → Privacy &
Security, and the phone unlocked and trusting the Mac.

The script strips `com.apple.developer.carplay-driving-navigation` from the
build. That entitlement is restricted: Apple issues no provisioning profile
carrying it until a separate CarPlay request is approved, and leaving it in
fails at signing with a message about profiles rather than about CarPlay. iOS
never instantiates the CarPlay scene without the grant anyway, so nothing
testable on the phone is lost. Pass `--carplay` once the approval lands.

### On TestFlight

Needs a paid Apple Developer Program membership, an app record in App Store
Connect for `solutions.clearkey.timinow`, and an App Store Connect API key
(Users and Access → Integrations) with its `.p8` saved to
`~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8` — Apple offers that file
for download exactly once.

```
./scripts/upload-testflight.sh --api-key <KEY ID> --api-issuer <ISSUER ID>
```

The build number defaults to a `yymmddHHMM` stamp, because App Store Connect
rejects any upload whose `CFBundleVersion` is not higher than the last one it
accepted. `--build N` overrides it; `--export-only` produces an `.ipa` without
uploading.

Both scripts write `Darwin/Local.xcconfig` with the resolved team and the
entitlements file to use. It is git-ignored, included last by
`Darwin/TimiNow.xcconfig`, and rewritten on every run — which is why
`CODE_SIGN_ENTITLEMENTS` must not also appear in `Darwin/project.yml`, where a
target setting would outrank it.

## Verification

Repository checks validate native scaffolding on every platform. GitHub Actions additionally compiles the WPF app on Windows and runs Swift tests plus an iOS Simulator build on macOS. Signed App Store and Windows installer builds remain release-pipeline responsibilities because signing identities are account-specific.
