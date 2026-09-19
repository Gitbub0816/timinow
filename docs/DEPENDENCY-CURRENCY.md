# Dependency currency — audit and policy

Snapshot of every externally-versioned dependency this codebase pins, taken
2026-09-12. "Bumped" means changed in this pass and covered by `npm run
check`/`npm run smoke` afterward; "deferred" means deliberately left alone
because the risk of an untested regression in a live, revenue-bearing path
outweighed the currency gain, with the specific reason stated.

## Bumped in this pass

| Dependency | Was | Now | Why safe to bump without a full manual QA pass |
|---|---|---|---|
| `wrangler` (devDependency) | `^4.125.0` | `^4.131.1` | Build/deploy CLI only, not a runtime dependency of any shipped Worker. |
| Mapbox GL JS (CDN, `public/map.js`, `apps/admin-console/public/index.html`) | `v3.15.0` | `v3.30.0` | Same major version (3.x); Mapbox's own compatibility policy treats minor bumps as additive. CDN assets at the new version confirmed reachable (200) before committing. |
| `@mapbox/mapbox-gl-draw` (CDN, `apps/admin-console/public/index.html`) | `v1.4.3` | `v1.5.1` | Same major version; used only in the admin console's market-boundary editor. |
| `@didit-protocol/sdk-web` (CDN, `public/app.js`) | unpinned (`unpkg.com/@didit-protocol/sdk-web/dist/...`) | pinned to `@0.3.1` | This was a real supply-chain gap, not a staleness one: an unpinned unpkg URL serves whatever the package's latest published version is at fetch time, with no review before it runs during identity verification. Pinning to the current latest closes that gap; it does not change behavior today. |
| Cloudflare Workers `compatibility_date` (all 6 `wrangler*.jsonc`) | `2026-08-20` | `2026-09-12` | Three-week gap; `npm run smoke` and `npm run check` (which exercise every Worker's request path against the new date) pass unchanged. |
| Legal version (`src/catalog.js` `LEGAL_VERSION`, `apps/customer-mobile` `TimiLegal.version`) | `2026-08-29` | `2026-09-12` | Not a package dependency, but bumped alongside the legal-text rewrite (see `docs/LEGAL-LAUNCH-CHECKLIST.md`) since a material change to the Terms requires re-acceptance, which this version bump triggers on the next intake. |

## Deferred, with reasons

| Dependency | Current | Latest known | Why deferred |
|---|---|---|---|
| `@clerk/clerk-js` (served by Clerk's own Frontend API, `+esm`) | `@5` (floating — jsdelivr resolves this to the newest 5.x release automatically, currently 5.127.2, with no code change needed to stay current within the major version) | `6.x` (6.31.1) | A major-version bump to an authentication SDK loaded on every sign-in screen across three apps (customer, vet, admin) carries real regression risk that cannot be responsibly verified without a live browser QA pass against real Clerk instances in a staging environment — which this environment cannot perform. **Action for whoever picks this up**: read Clerk's v6 migration guide, test sign-in/sign-up/session-restore on a staging Clerk instance for all three apps, then bump `CLERK_JS_PATH` in `src/config.js` — one constant, since every Worker now derives the URL from its own `CLERK_ISSUER` rather than repeating it as a `CLERK_JS_URL` var. |
| `@stripe/connect-js` (CDN, jsdelivr, admin console — the last jsDelivr script in the product) | `@3` (floating, currently resolves to 3.4.6) | 3.4.6 | Already current — floating major-version pin, same mechanism as Clerk above, already tracks latest within the major version automatically. |
| Stripe iOS SDK (`stripe-ios-spm`, `Package.swift`) | `from 24.0.0` (resolves to ≤24.25.0 per a prior session's build) | unknown — GitHub's release API is not reachable from this environment for `stripe-ios` (not in this session's repository scope) | A known, already-diagnosed gap in an earlier session: this version range lacks `STPError.httpStatusCodeKey`, added in a later release. Needs a maintainer with Xcode access to bump the SPM pin and rebuild; cannot be safely done or verified from a text-only environment. |
| Mapbox Navigation iOS (`mapbox-navigation-ios`), Mapbox Maps iOS (`mapbox-maps-ios`), Didit iOS SDK (`didit-protocol/sdk-ios`) | `from 3.27.0`, `from 11.26.0`, `from 4.7.6` respectively | unknown — same GitHub API access limitation as above | Same reasoning as the Stripe iOS SDK: these are Swift Package Manager `from:` version floors, not exact pins, so they already pick up compatible newer releases on `swift package update`; determining whether a newer *incompatible* (major) release exists needs GitHub access this environment does not have to these specific repositories, or an Xcode-side `swift package update --dry-run`. |

## Ongoing currency: recommend Dependabot or Renovate

None of the above should need a repeat manual audit. This repository does
not yet have `.github/dependabot.yml` or a `renovate.json` — adding one is
the single highest-leverage fix for staying current, since it turns "someone
remembers to check" into "a bot opens a PR and CI decides." A minimal
Dependabot config for the one real package manifest here (`package.json`,
`wrangler` only) would be:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
```

This does not cover the CDN-pinned browser scripts (Clerk, Stripe, Mapbox,
Didit) or the Swift Package Manager dependencies, because Dependabot does
not track version strings embedded in HTML/JS source or `Package.swift`
`from:` floors the way it tracks a lockfile. Those need either a periodic
manual pass using this document as a template, or a custom script (in the
spirit of `scripts/check-subprocessors.mjs`) that fetches each CDN's latest
version and fails CI when the gap exceeds a threshold — not implemented
here, since deciding the right threshold (and who reviews the resulting
PRs) is a team-process decision, not a code change.

## Swift package identity conflicts (Skip), 2026-09 — open, upstream

Building the iOS app under Xcode 27.1 emits ten SwiftPM warnings of the form
"Conflicting identity for `skip`: dependency `github.com/skiptools/skip` and
dependency `source.skip.tools/skip` both point to the same package identity".
SwiftPM says it "will be escalated to an error in future versions", so this is
a real deadline rather than noise.

The cause is that Skip publishes each package from two hosts and its own
packages do not agree on which to depend on. Sorting the conflicts by who
introduced them:

| Identity | Chain A | Chain B | Ours to fix? |
| --- | --- | --- | --- |
| `skip` | `skip-model`, `skip-ui` → github.com | our manifest → source.skip.tools | **Yes** |
| `skip-model` | `skip-ui` → github.com | our manifest → source.skip.tools | **Yes** |
| `skip-bridge` | `skip-fuse` → github.com | `skip-fuse-ui` → source.skip.tools | No |
| `skip-android-bridge` | `skip-fuse` → github.com | `skip-fuse-ui` → source.skip.tools | No |
| `swift-jni` | `skip-fuse` → github.com | `skip-fuse-ui` → source.skip.tools | No |

So switching our five declarations in `Package.swift` from
`source.skip.tools/…` to `github.com/skiptools/…` would clear the first two
rows — four of the ten warnings — and leave the rest, which are
`skip-fuse` disagreeing with `skip-fuse-ui` and can only be fixed by Skip or
by a version pair where they happen to agree.

**Not done, deliberately.** Changing a dependency URL forces a full
re-resolution, and this environment has no Swift toolchain and no access to
`source.skip.tools`, so the change cannot be resolved or compiled here before
being pushed. Shipping an unresolvable manifest to silence four warnings is a
bad trade when the warnings are currently cosmetic. Whoever has a Mac can test
it in about a minute:

```bash
cd apps/customer-mobile
swift package resolve            # record the current versions first
# edit the five URLs, then
swift package resolve
```

If it resolves to the same versions, keep it and report the remaining five to
Skip; if it does not, revert and wait for upstream.

## Two `data(for:)` deprecation warnings — open, needs the compiler

`VoiceController.swift:282` and `:410` call `URLSession.shared.data(for:)` and
warn "'data(for:)' was deprecated in iOS 15.0: Use iOS 15 API instead".
`APIClient.swift` makes the same call three times and does not warn. The only
structural difference is the module: `VoiceController` is in `TimiNowUI`,
which links `SkipFuseUI` and therefore `SkipFoundation`, while `APIClient` is
in `TimiNowCore`, which does not.

That points at a shadowed overload rather than an Apple deprecation, and the
right fix depends on which symbol is actually being resolved — which needs a
compiler this environment does not have. Guessing between
`data(for:delegate:)` and a `#if SKIP` split risks breaking the Android
transpile to silence two warnings. To settle it in one command on a Mac:

```bash
cd apps/customer-mobile
swift build -Xswiftc -warnings-as-errors 2>&1 | grep -A3 'data(for:)'
```

The note in the diagnostic names the declaring module.
