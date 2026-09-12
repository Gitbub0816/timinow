# What is still missing to fully go to prod

A point-in-time gap list (September 2026), written after the markets/voice/
navigation/settings/widget-demo round landed. Facts below marked *verified
live* were checked against the running Workers, not inferred from the repo.

## Where things stand (verified live)

- All four Workers answer healthy on their domains, D1 attached everywhere.
- **Stripe is in live mode** (`pk_live_…` served by `/api/config`) — real
  cards will be charged.
- Clerk sign-in is required (`signInRequired: true`), headless Clerk on all
  consoles.
- Twilio is configured on the voice Worker (`twilioConfigured: true`).
- Mapbox tokens are being served by both the customer **and** the admin
  Worker.
- Didit identity verification works end-to-end in the iOS app (native SDK).
- `GUEST_SESSION_SECRET` is set — guest sessions persist.

## 1. Configuration — do these before or with the next deploy

| Gap | Why it matters | Action |
|---|---|---|
| **Admin map token will be wiped if it is a plain-text dashboard var.** The admin Worker is serving a Mapbox token today, but nothing in `wrangler.admin.jsonc` declares it — so it was set in the dashboard. `wrangler deploy` replaces plain-text vars with what the config declares, every deploy (this exact failure un-configured Didit twice). | The new Markets map goes blank on the next admin deploy. | In the Cloudflare dashboard check whether `MAPBOX_PUBLIC_TOKEN` on `timinow-admin` shows as encrypted. If not: `npx wrangler secret put MAPBOX_PUBLIC_TOKEN --config wrangler.admin.jsonc` (same treatment as `DIDIT_WORKFLOW_ID`). Audit the other Workers for any remaining plain-text dashboard vars while there. |
| **Voice quality** — `GEMINI_API_KEY` turned out to be configured (verified live: `speechPath: "gemini-tts"`), so the robotic read was the *voice choice*, Iapetus ("clear", i.e. flat). | First impression on every clinic call. | Already fixed in config: the committed default is now Sulafat (Gemini's "warm" voice) with a stronger conversational style prompt; the Twilio fallback is Polly's generative tier. Lands on the next voice deploy. Audition alternatives with `POST /api/voice/tts-check {"voice":"NAME"}` or `scripts/bootstrap.sh --test-call`. |
| **Migration 0027** (market polygon boundaries). | Markets pages read the new columns. | Next deploy: run with `migrate: true`. |
| **`widget-demo.timinow.pet`** | New Worker in this round; first deploy provisions the custom domain automatically (the zone is already on Cloudflare). | Deploy target `all` (or `widget-demo`) once; then open the URL. |
| **Alert notifications** (`ALERT_EMAIL_API_KEY` / `ALERT_EMAIL_FROM/TO`, optional `ALERT_SMS_TO`). | The metrics cron detects threshold breaches but currently has nobody to tell. This is the closest thing to monitoring the platform has today. | Set on the admin Worker per `docs/KEY-DEPENDENCIES.md` §2. |
| **APNs push** (`APNS_KEY_ID`, `APNS_TEAM_ID`, key, `APNS_ENVIRONMENT`). | Backgrounded customers currently learn about offers by SMS only. | Per `docs/KEY-DEPENDENCIES.md` §4, once the App Store build exists (the key is tied to the Apple developer account). |

## 2. Distribution — the biggest real gap

The backend is deployed; the clients are not distributable yet.

- **iOS**: the app installs by cable from a Mac (`install-ios-device.sh`).
  Going to prod means an App Store Connect listing, screenshots, privacy
  labels, the Didit camera/mic usage strings (already in the plist), APNs
  entitlement, and a TestFlight round first. This is the long pole —
  Apple review typically takes days and can bounce a marketplace app for
  payments wording, so start it before everything else is "done".
- **Android**: the Skip build compiles but has never been run on a device
  in this project. Treat it as not shipped; either invest a test pass or
  launch iOS-first deliberately.
- **Windows vet console**: `install.ps1` works but the exe is unsigned —
  SmartScreen will warn every clinic. A code-signing cert (or MSIX +
  store distribution) removes that.
- **macOS vet console**: same story — unsigned, no notarization, so
  Gatekeeper requires right-click-open. Developer ID signing + `notarytool`
  fixes it.
- **Vet web console** (providers.timinow.pet) is live and is the fallback
  for any clinic that can't install anything.

## 3. Operations

- **Monitoring**: Worker observability is on (Cloudflare dashboard logs),
  and `/api/health` now carries the deployed `build` SHA — but nothing pages
  a human. Minimum viable: a free uptime checker (UptimeRobot et al.) on the
  five health URLs + the alert-email keys above. Note the customer Worker's
  `build` currently reads `null` because `wrangler secret put` created a new
  version without the deploy-time stamp — the next real deploy fixes it.
- **Backups / rollback**: D1 has 30-day Time Travel by default — read
  `wrangler d1 time-travel` before you need it, not after. Worker rollback is
  `wrangler rollback` or redeploying a previous SHA (the stamp makes "which
  SHA" answerable).
- **Stripe webhooks**: live mode means the webhook endpoint + signing secret
  must be the live ones, and the Stripe dashboard's webhook health is worth a
  look after the first real booking. Payouts require completed Stripe
  Connect onboarding per clinic.
- **Twilio**: the from-number needs voice + SMS on it (two different
  settings), and US A2P 10DLC registration for the SMS side if volume grows.
- **Load**: nothing here has seen concurrency. The failure modes that matter
  (a search fanning out to 30 clinics during a busy evening) are all D1
  writes; a staging run of `scripts/e2e.mjs` against a real D1 copy would
  buy confidence cheaply.

## 4. Content and compliance

- **Legal review**: the in-app legal text (fees, deposits, vet-tech
  providers, data sharing) was written to be accurate to the product, but no
  lawyer has read it. Before real money moves at real volume, one should.
- **Support inboxes**: the app and console link `privacy@`, `billing@`, and
  `legal@timinow.pet`, and the new Settings → Privacy screen promises
  a human answers data requests (California law does require it). Make sure
  those mailboxes exist and someone reads them.
- **App analytics opt-out** now exists in-app (Settings → Privacy & your
  data) — worth mentioning in the privacy policy's next revision.

## The short version

Backend: deploy this round with `migrate: true`, make the admin Mapbox token
an encrypted secret, set `GEMINI_API_KEY` (voices) and the alert-email keys
(monitoring). Clients: everything real is App Store/TestFlight + code
signing — start Apple review now. Everything else on this list is an
afternoon each.
