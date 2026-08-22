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

## Verification

Repository checks validate native scaffolding on every platform. GitHub Actions additionally compiles the WPF app on Windows and runs Swift tests plus an iOS Simulator build on macOS. Signed App Store and Windows installer builds remain release-pipeline responsibilities because signing identities are account-specific.
