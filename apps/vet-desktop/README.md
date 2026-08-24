# Tími Vet — macOS

A native SwiftUI veterinary operations console for macOS, structured like `apps/customer-mobile`: a Swift package (`TimiVetCore` / `TimiVetUI` / `TimiVetApp`) wrapped by a thin Xcode project under `Darwin/`. Unlike the customer app it carries no Skip — the console ships to macOS, and the clinic's other surfaces are the Windows client and the web console, so transpiling it to Kotlin on every build bought nothing. It is a port of `apps/vet-windows` (WPF/.NET) to the same design and Worker API, with two Windows-specific things fixed along the way: the Clerk bearer token is never written to disk in plaintext, and the floating console remembers where you left it instead of resetting to `(80, 80)` on every launch.

## Requirements

- macOS 14 (Sonoma) or newer, both to build and to run
- Xcode 16 or newer
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)

## Open and build on macOS

```bash
cd apps/vet-desktop/Darwin
xcodegen generate
cd ..
open Project.xcworkspace
```

Select the **TimiVet** scheme and run. `Darwin/TimiVet.xcconfig` reads `Skip.env` for the bundle identifier and version, and `Darwin/TimiVet.entitlements` sandboxes the app with outgoing network access. It declares no keychain access group: an explicit group only matters for sharing items between signed products, and it forces a provisioning profile that macOS enforces by killing the app at launch. Credentials still go to the Keychain, in the group the app gets by default.

You can also build and test the Swift package directly, without Xcode:

```bash
swift build
swift test
```

`swift test` runs `Tests/TimiVetCoreTests` (plain XCTest — no Skip harness, so it needs no Android toolchain and no Gradle) — a decision-payload shape test and a poll-interval clamping test at minimum.

The app starts in **interactive demo mode** if no Worker URL is configured, backed by `TimiVetCore/DemoClinicData.swift` — the same three fixture requests the Windows client ships. Set the Cloudflare Worker HTTPS URL from the sign-in screen or the console's settings section to talk to a live `timinow-vet` Worker.

## How sign-in works

Every screen in this app is Tími-designed — `docs/PLATFORM-CONTRACT.md`'s "no mounted Clerk UI" rule applies to native clients too. `TimiVetCore/AuthController.swift` drives Clerk's Frontend API (`/v1/client/...`) directly over HTTPS, form-encoded, exactly like `@clerk/clerk-js` running headless on the web surfaces and like the Windows client's `ClerkAuthService.cs`:

1. `GET /api/config` → `clerkPublishableKey` (or an explicit `clerkFrontendApi`, if the Worker ever starts returning one) → the Clerk Frontend API host, decoded as `pk_(test|live)_` + base64(`"<host>$"`).
2. `POST /v1/client/sign_ins` with an identifier → Clerk's supported first factors for that account, filtered to the only two this console offers: an emailed one-time code or a texted one-time code (`email_code` / `phone_code`). Passwords, Google/Apple OAuth and passkeys are deliberately not surfaced — every Tími sign-in surface offers exactly the two code strategies.
3. `prepare_first_factor` sends the code, then `attempt_first_factor` verifies it.
4. On success, `POST /v1/client/sessions/{id}/tokens/timinow` mints the JWT-template token the Worker expects (falling back to the templateless `/tokens` endpoint if `timinow` isn't configured yet).
5. If the account belongs to more than one Clerk organization, a custom workspace picker calls `POST /v1/client/sessions/{id}/touch` with `active_organization_id` — the Frontend API's non-UI equivalent of `clerk.setActive({ organization })` — then re-mints the token.
6. `GET /api/session` reads back tenant/location/role and repairs Clerk metadata server-side, exactly as `docs/PLATFORM-CONTRACT.md` describes.

The session token refreshes proactively (re-minted once within 10 seconds of its JWT `exp`) and reactively — `ClinicAPIClient` retries once on a 401 by force-refreshing through `ClinicSessionTokenProviding`, the small protocol that lets the API client and the auth controller talk without a retain cycle.

**One-time codes are the only sign-in methods.** Password entry, Google/Apple OAuth (the old `ASWebAuthenticationSession` browser round trip) and passkeys were removed from the UI and the flow on the owner's instruction: every sign-in surface offers email codes and phone codes only. The stored-credential resume and the workspace picker are unchanged.

## Where settings and tokens live

| What | Where |
| --- | --- |
| Connection/poll/alert settings, floating console geometry | `~/Library/Application Support/ClearKey/TimiVet/settings.json` (`TimiVetCore/SettingsStore.swift`) |
| Clerk session (the `__client` cookie + the short-lived Worker token) | macOS Keychain, service `solutions.clearkey.timivet` (`TimiVetCore/KeychainStore.swift`) |

The Clerk bearer token is **never** written to `settings.json` — unlike the Windows client's original settings file (its own README calls that a dev-only shortcut). `AppSettings` has no token field at all.

## How the floating console differs from the WPF `Topmost` window

`TimiVetUI/FloatingPanel.swift` is a real `NSPanel` subclass (`.nonactivatingPanel` + `.utilityWindow`), not a borderless `AllowsTransparency="True"` `Topmost` `Window`:

- `level` is `.floating` normally, or `.screenSaver` when "stay above everything" is on in Settings — `.screenSaver` also floats above full-screen apps and other Spaces, `.floating` does not.
- `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]` lets it follow you across Spaces instead of being left behind.
- Position and size are restored from `AppSettings.miniWindow*` and saved back on every move/resize (`NSWindowDelegate.windowDidMove`/`windowDidResize`) — the WPF version hardcodes `Left="80" Top="80"` on every launch; this fixes that.
- The mini console's own "Always on top" toggle calls back into the panel to update `level` live.

## Menu bar and notifications

`TimiVetUI/AlertCenter.swift` ports `Services/AlertService.cs`: `UNUserNotificationCenter` desktop notifications (title `Emergency intake · {pet}` / `New intake · {pet}`, body truncated to 177 characters + `…`, matching the Windows balloon tip), an `NSStatusItem` with "Open Tími Vet" / "Open floating console" / "Manage people" / "Exit" (the macOS equivalent of the Windows tray icon), and launch-at-login via `SMAppService.mainApp` (the modern replacement for the Windows Run-key autostart). This is the single menu-bar surface the app has — see the note in the Known limitations section below about the `TimiVetApp` scene's `.commands` menu, which duplicates a few of the same actions in the app's own menu bar rather than a second status item.

## Package layout

```
Package.swift                      TimiVetApp / TimiVetUI / TimiVetCore, no external dependencies
Skip.env                           PRODUCT_NAME, bundle id, versions
Darwin/                            XcodeGen project, Info.plist, entitlements, the tiny @main file
Sources/TimiVetCore/               Models, ClinicAPIClient, AuthController, KeychainStore, SettingsStore, ClinicStore, DemoClinicData
Sources/TimiVetUI/                 Theme, ConsoleView, MiniConsoleView, FloatingPanel, AuthView, PeopleView, AlertCenter
Sources/TimiVetApp/                RootView/TimiVetApplication (portable), AppDelegate (macOS-specific composition root)
Tests/TimiVetCoreTests/            XCTest
```

This package declares only `.macOS(.v14)`, unlike the customer app's `[.iOS, .macOS, .macCatalyst]`, and it makes no portability claim at all. `TimiVetApp` is the macOS composition root — real `NSPanel`, `NSStatusItem`, `NSApplicationDelegate` — and `TimiVetCore`/`TimiVetUI` are plain SwiftUI and Foundation. If an Android console is ever wanted, Skip goes back in then; carrying it against that possibility cost minutes on every build and produced Kotlin nothing consumed.

## Production checklist

Everything below needs a Mac (and, where noted, Xcode or the Clerk dashboard) to actually verify — none of it can be exercised in a container that cannot compile Swift.

1. **Xcode / macOS**: build once with `xcodegen generate && open Project.xcworkspace`, confirm the app launches, signs in, and every screen renders — this port has not been compiled or run.
2. **Code signing & notarization**: set a Developer ID Application signing identity and team in `Darwin/project.yml`/Xcode, then notarize (`xcrun notarytool`) before distributing outside the Mac App Store. `Darwin/TimiVet.entitlements` already sandboxes the app (`com.apple.security.app-sandbox`, outgoing network only, a Keychain access group) — verify the Keychain access group's team-ID prefix once you have a real signing identity, since `$(AppIdentifierPrefix)` only resolves correctly once the app is actually signed.
3. **Clerk dashboard — JWT template**: confirm the `timinow` JWT template from `docs/PLATFORM-CONTRACT.md` exists; `AuthController` falls back to the templateless token endpoint if it does not, at the cost of an extra D1 read per request on the Worker. (No OAuth redirect URL needs configuring any more — the console signs in with one-time codes only, so the old `timivet://auth-callback` entry is no longer required.)
4. **Worker URL**: point Settings → "Cloudflare Worker HTTPS URL" at the real `timinow-vet` Worker (`wrangler.vet.jsonc`) before relying on anything beyond demo mode.
5. **`swift test`, a signed archive, and an accessibility pass** before shipping, matching the customer app's own checklist.

## Known limitations / follow-ups

- Toggling "Floating console stays above everything" from the main console's settings section does not live-update an already-open floating panel's window level — only the mini console's own "Always on top" toggle does that immediately. Reopening the floating console picks up the new setting.
- `TimiVetApp.swift`'s `.commands` menu (Open Floating Console / Manage People… / Sign Out) duplicates a few actions already reachable from `AlertCenter`'s menu-bar item; this was a judgment call reconciling two overlapping spec bullets (`AlertCenter` owning a detailed `NSStatusItem`, and `TimiVetApp` separately calling for "MenuBarExtra for the status item") in favor of one real menu-bar icon instead of two.
