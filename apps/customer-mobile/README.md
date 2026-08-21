# Tími NOW customer mobile app

This is the customer-only native SwiftUI client. It is structured as a Skip Fuse app so the shared Swift and SwiftUI modules can compile natively for iOS and Android while retaining platform-native controls.

## Included product flows

- Four-stage guided onboarding with pet setup, service boundaries, permissions, and animated transitions
- Rule-based concern specificity guard; no AI is required to reject vague descriptions
- Two-step care intake
- Search fan-out presentation and polling
- Comparison of up to five live clinic offers
- Atomic selection of one offer
- Arrival, deposit disclosure, travel, and observation tracker
- Multiple locally persisted pet profiles
- Activity history, settings, legal, privacy, and veterinary-safety screens
- Fully usable fixture mode when no Worker URL is configured

## Open and build on macOS

Requirements for the iOS app: macOS 15+, Xcode 16 or newer, Homebrew, XcodeGen, and Skip 1.7+.

```bash
brew install xcodegen
brew tap skiptools/skip
brew install skip
cd apps/customer-mobile/Darwin
xcodegen generate
cd ..
open Project.xcworkspace
```

Run `skip checkup` after installing Skip, then select the `TimiNow` scheme in Xcode. The checked-in Swift package, build plugins, and per-module `skip.yml` files keep the customer codebase Skip Fuse-ready. This repository deliberately does not check in an Android launcher because this deliverable is customer iOS; generate the official Skip Android host on macOS before shipping an Android binary.

The app starts in interactive demo mode. Save the production Worker HTTPS URL under Settings → Connection to use the live API. Never place Clerk or Stripe secret keys in this client.

## Production checklist

1. Set the Apple development team and App Store signing profile.
2. Generate the Xcode project with XcodeGen; CI performs the same generation before compiling.
3. Configure the live Worker URL through managed app configuration or the Settings screen.
4. Add the production Clerk mobile session adapter before setting `SIGN_IN_REQUIRED=true`.
5. Add platform-native Stripe Payment Sheet adapters for iOS and Android; the fixture deposit completes locally, while live mode intentionally refuses to collect card data without the native payment adapter.
6. Add APNs/FCM entitlements and server delivery before relying on background offer alerts.
7. Run `swift test`, `skip test`, `skip android test`, accessibility audits, and signed archive verification.
