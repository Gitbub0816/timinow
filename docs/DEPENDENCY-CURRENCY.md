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
| `@clerk/clerk-js` (CDN, jsdelivr `+esm`) | `@5` (floating — jsdelivr resolves this to the newest 5.x release automatically, currently 5.127.2, with no code change needed to stay current within the major version) | `6.x` (6.31.1) | A major-version bump to an authentication SDK loaded on every sign-in screen across three apps (customer, vet, admin) carries real regression risk that cannot be responsibly verified without a live browser QA pass against real Clerk instances in a staging environment — which this environment cannot perform. **Action for whoever picks this up**: read Clerk's v6 migration guide, test sign-in/sign-up/session-restore on a staging Clerk instance for all three apps, then bump `DEFAULT_CLERK_JS_URL` in `src/config.js` and `CLERK_JS_URL` in all three `wrangler.jsonc`/`wrangler.vet.jsonc`/`wrangler.admin.jsonc` files together (they must move in lockstep). |
| `@stripe/connect-js` (CDN, jsdelivr, admin console) | `@3` (floating, currently resolves to 3.4.6) | 3.4.6 | Already current — floating major-version pin, same mechanism as Clerk above, already tracks latest within the major version automatically. |
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
