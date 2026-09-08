# Key dependencies — what to configure and why

This is the one place that answers "what do I need to set up now that this round
of work landed?" It only covers what changed in the recent product-revision and
fix-pass work. For the full reference on every variable, secret, Worker, and
how they're delivered, see `.env.example` (the source of truth — this file
just organizes it by task) and `docs/PRODUCTION-SETUP.md`.

Reminder on delivery, from `.env.example`: values marked **VAR** go in the
`vars` block of the relevant `wrangler.*.jsonc` (or the Cloudflare dashboard);
values marked **SECRET** must be set with `wrangler secret put <NAME> --config
wrangler.<worker>.jsonc` and never committed to a config file. Everything
below that's optional degrades safely to "feature quietly does nothing" when
left unset — nothing crashes and nothing silently fakes success.

---

## 1. Yours to do — Didit (identity verification)

You said you'd wire this in yourself. The code side is now actually correct
end to end (it wasn't before this pass — see "What got fixed" below), so all
that's left is real credentials:

| Key | Type | Worker | What it is |
|---|---|---|---|
| `DIDIT_API_KEY` | SECRET | customer (`wrangler.jsonc`) | Your Didit API key. Without it, hardship applications fall back to a stub that never approves — safe, never silently permissive. |
| `DIDIT_WORKFLOW_ID` | VAR | customer | The verification workflow you configure in the Didit console (which checks run — document, liveness, duplicate — is a property of the workflow). |
| `DIDIT_BASE_URL` | VAR | customer | Only override if Didit moves you to a different environment/sandbox. Defaults to `https://verification.didit.me`. |

```bash
npx wrangler secret put DIDIT_API_KEY --config wrangler.jsonc
```
Then set `DIDIT_WORKFLOW_ID` (and `DIDIT_BASE_URL` if needed) in `wrangler.jsonc`'s `vars` block.

**What got fixed alongside this:** the embedded identity widget had a mount
point in the DOM but nothing ever loaded Didit's SDK into it, and the
"I've finished verifying" button advanced the flow on a bare click with no
server check at all — a real bypass of the one control the whole hardship
engine depends on. Separately, the backend's `createSession` required a
`client_secret` field that Didit's real API never returns, so even a
configured key would have thrown on every attempt. Both are fixed now
(`src/hardship/providers.js`, `src/hardship/index.js`, `public/app.js`) —
once you drop in a real `DIDIT_API_KEY`, the flow should work without further
code changes. Test it end-to-end once your key is live before trusting it in
production.

---

## 2. Alert breach notifications (new — backend cron now actually notifies someone)

Previously, threshold breaches (offer-rate drop, response-time spike, etc.)
were only visible if an operator happened to open the admin dashboard. Now the
5-minute cron checks and can email and/or text someone. Both channels are
independently optional.

| Key | Type | Worker | Notes |
|---|---|---|---|
| `ALERT_EMAIL_API_KEY` | SECRET | customer | A MailerSend API key (Bearer token). All three email vars are required together — partial config is treated as unset. |
| `ALERT_EMAIL_FROM` | VAR | customer | Verified sender address in your MailerSend account. |
| `ALERT_EMAIL_TO` | VAR | customer | Where breach emails go. |
| `ALERT_SMS_TO` | VAR | customer | Phone number for SMS on the most severe breach category only. No Twilio credentials needed on the customer Worker — the text is enqueued and sent through the voice Worker's existing service binding, the same path `notifyFirstOfferBySms` already uses. Twilio credentials stay only on the voice Worker. |
| `ALERT_NOTIFICATION_COOLDOWN_MINUTES` | VAR | customer | Default 60. Prevents re-notifying the same ongoing breach every 5 minutes; a cleared-then-recurring breach notifies immediately, bypassing cooldown. |

```bash
npx wrangler secret put ALERT_EMAIL_API_KEY --config wrangler.jsonc
```

MailerSend is already a connector available on this account per your Stripe
MCP addition — worth connecting it the same way if you haven't.

---

## 3. Hardship evidence retention (no new keys — now actually runs)

`retention_deadline` was always written on evidence upload, but nothing ever
deleted the R2 object or the D1 row when it passed. The 5-minute cron now
sweeps it (fail-closed: an R2 delete failure leaves the D1 row untouched, so
nothing is ever marked deleted without the bytes actually being gone).
`EVIDENCE_RETENTION_DAYS` already existed in `.env.example` and controls how
long evidence lives before this sweep picks it up — no action needed unless
you want to change the default (90 days).

---

## 4. iOS push notifications (new — customer app only)

The customer app previously had no way to learn about a new offer while
backgrounded except the SMS link. Native push is now plumbed end to end
(device registration, an APNs sender built on Web Crypto, Swift-side
registration and deep-linking) — **but this could not be built-and-run in
this sandbox** (Linux, no Xcode/Swift toolchain). The backend half was
exercised directly in Node with a real generated P-256 key; the Swift half
was written by careful reading of the existing codebase, not compiled.
**Test on a real device before relying on it.**

| Key | Type | Worker | Notes |
|---|---|---|---|
| `APNS_KEY_ID` | VAR | customer | From your Apple Developer account → Keys. |
| `APNS_TEAM_ID` | VAR | customer | Your 10-character Apple team ID. |
| `APNS_AUTH_KEY_P8` | SECRET | customer | The contents of the `.p8` key file Apple gives you when you create the key, with literal newlines replaced by `\n` (documented + verified in `.env.example`). |
| `APNS_BUNDLE_ID` | VAR | customer | Defaults to `solutions.clearkey.timinow` — only change if the app's bundle ID changes. |
| `APNS_ENVIRONMENT` | VAR | customer | Leave blank for production; set to `sandbox` only for a development-signed build. |

```bash
npx wrangler secret put APNS_AUTH_KEY_P8 --config wrangler.jsonc
```

All four of `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_AUTH_KEY_P8`/`APNS_BUNDLE_ID`
must be set together — missing any one disables push entirely (logs, never
throws) and the SMS-on-first-offer path is unaffected either way.

---

## 5. Everything else from the earlier product-revision pass (recap)

These were introduced before this fix-pass and are already documented in
`.env.example` — listed here just so this is a complete map of what's new
since the original codebase:

| Key | Type | Worker | Feature |
|---|---|---|---|
| `PUBLIC_APP_URL` | VAR | customer | Base URL for the "close the page, here's your link" SMS. |
| `SEARCH_LINK_SECRET` | SECRET | customer | Signs the tokenized search-restore links in that SMS. |
| `TWILIO_MESSAGING_FROM` / `TWILIO_MESSAGING_SERVICE_SID` | VAR | customer | The SMS-capable number/service for the first-offer text (separate from `TWILIO_FROM_NUMBER`, which is voice-only). |
| `GUEST_SESSION_SECRET` | SECRET | customer | Signs the guest (no-account) session cookie. |
| `WORKSTATION_SESSION_SECRET` | SECRET | clinic (`wrangler.vet.jsonc`) | Signs the shared clinic-workstation session cookie. |
| `CUSTOMER_APP_URL` | VAR | all four | The customer app's own origin, read wherever a cross-app link is built (e.g. the "Open clinic console" link now points at the real `VET_APP_URL` instead of an internal duplicate — see fix #3 below). |

None of these are new in this fix-pass; they're here so this doc is a
complete "what changed" record.

---

## 6. Not wired to anything yet (pre-existing, unrelated to this pass)

Found while auditing `src/hardship/providers.js`: the hardship engine's
document-extraction, income-verification, and bank-transaction-corroboration
providers are stubbed exactly like identity was, but unlike identity, **the
live adapters were never built** — setting their keys today makes the code
throw `unimplemented` rather than call a real vendor. No action needed unless
you want those checks live (currently, a document-based pathway is the fully
working path; income/bank verification are not).

`DOCUMENT_EXTRACTION_API_KEY`, `INCOME_PROVIDER_API_KEY`, `PLAID_CLIENT_ID`,
`PLAID_SECRET` — not in `.env.example` today because they don't do anything
yet. Flagging so nobody sets them expecting a live integration.

---

## What changed in this fix-pass, for context

Bugs fixed (no new keys): a clinic workstation session landed on a blank
screen on reload (`apps/vet-web`); staged wave-routing had no backstop clock,
so later-wave clinics could go uncontacted if nobody polled
(`src/routing.js`); the customer app's homepage linked to an internal
duplicate clinic console with stale fixture data instead of the real
`apps/vet-web` app; pet profiles were 100% hardcoded fixture data now wired to
the real `/api/pets` endpoints; the admin console gained screens for clinic
applications, clinic contracts, and Paw It Forward fund/custody/reconciliation
that previously had no UI at all.

Stripe MCP: verified connected and pointed at the right org — three accounts
visible (`ClearKey Solutions, LLC` and `ClearKey Connect`, both live;
`Sweepr sandbox`, test mode), matching the app's `solutions.clearkey.*` bundle
ID prefix. No configuration action needed there.
