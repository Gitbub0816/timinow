# Tími voice gateway (`timinow-voice`)

When a customer's care search fans out to up to 30 clinics, most of them have
nobody watching a console. This Worker calls them: a short automated phone
call asks one question with a keypad answer, so a clinic that is mid-appointment
with nobody at the front desk still gets a chance to say yes.

It has no customer-facing or clinic-facing screens. The public page at `/` is
a status page only — see `public/index.html`. Clinics manage requests by hand
at `timinow-vet`; this Worker is the unattended fallback.

## The call script

Roughly (see `buildCallScript` in `../../src/voice.js` for the exact wording):

> "Hi, this is Tími calling for **{clinic name}**. A pet owner nearby is
> looking for immediate care for **{species and symptom summary}**, about
> **{travel minutes}** minutes away. Do you have time to see them? Press **1**
> to confirm you can take them, or press **2** to decline. Press **9** to hear
> this again."

- **1** → "Thank you. We'll send the owner your way and the details are on
  your Tími console." The call then hangs up, and this has the identical
  effect as a staffer clicking "accept" in the console: it creates a
  `care_offers` row, flips the target to `offered`, and respects the search's
  five-offer cap and expiry (see the drift warning at the top of
  `apps/voice-gateway/src/index.js`).
- **2** → "Understood, thank you." The target is marked `declined`.
- No input after two repeats → the call hangs up and the attempt is recorded
  with `outcome = 'no_response'`.

The script never states a diagnosis, never says the pet's name (the clinic
gets that on the console — a phone tree is not the place for identifying
details), and never implies the clinic is obligated to say yes.

## Routes

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/api/health` | public |
| `GET` | `/api/config` | public |
| `POST` | `/api/voice/outbound/:targetId` | Twilio webhook (signature + per-attempt token) |
| `POST` | `/api/voice/gather/:targetId` | Twilio webhook (signature + per-attempt token) |
| `POST` | `/api/voice/status/:callId` | Twilio status callback (signature + per-attempt token) |
| `GET` | `/api/voice/attempts?searchId=` | Clerk-authenticated, tenant-scoped (platform operators may pass any `searchId`) |

## Twilio console setup

1. Buy a phone number with **voice capability** (SMS is not used by this
   Worker). Set it as `TWILIO_FROM_NUMBER` in `wrangler.voice.jsonc`.
2. You do **not** configure a static "A call comes in" webhook on the number
   for outbound calls — this Worker places calls itself via the REST API and
   hands Twilio a **per-call** `Url` and `StatusCallback` when it does. Those
   URLs are generated fresh for every call attempt (they embed a one-time,
   HMAC-signed token scoped to that attempt) and point back at:
   - `{VOICE_PUBLIC_URL}/api/voice/outbound/:targetId?...` — the initial TwiML
   - `{VOICE_PUBLIC_URL}/api/voice/gather/:targetId?...` — where `<Gather>`
     posts the pressed digit
   - `{VOICE_PUBLIC_URL}/api/voice/status/:attemptId?...` — call-status events
3. Set `VOICE_PUBLIC_URL` to this Worker's own deployed `https://` origin (its
   `workers.dev` URL or custom domain) so Twilio can reach those webhooks.
4. If you want Twilio's webhook validation to work end to end, do nothing
   extra — `TWILIO_AUTH_TOKEN` is the same secret Twilio uses to compute
   `X-Twilio-Signature`; there's no separate "signing key" to configure in the
   console.

## Required secrets

Set with `wrangler secret put <NAME> --config wrangler.voice.jsonc`:

| Secret | Used for |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | REST Calls API, and part of the signature check |
| `TWILIO_AUTH_TOKEN` | REST Calls API auth, Twilio webhook signature verification, and the HMAC key for the per-attempt anti-replay token |
| `CLERK_SECRET_KEY` | Platform-operator lookup for `GET /api/voice/attempts` only |

## Quiet hours and per-tenant opt-out

- `tenants.voice_calls_enabled` (default on) and `locations.voice_calls_enabled`
  (default on) let a tenant or a single location opt out of automated calls
  entirely. The cron drain marks the queued row `cancelled` with a `last_error`
  explaining why, rather than silently dropping it — the audit trail still
  shows Tími tried.
- `tenants.voice_quiet_hours_json` holds `{"start":"22:00","end":"07:00","timezone":"America/Los_Angeles"}`.
  An empty object (`{}`, the default) means always callable. The window may
  cross midnight; see `withinQuietHours` in `../../src/voice.js`.
- `locations.voice_phone` overrides `locations.phone` for calling purposes
  when a clinic wants calls to ring a different line than the one shown to
  customers; it falls back to `phone` when null.

These columns are read-only from this Worker's point of view — the toggles
themselves are expected to live in the clinic's own console (owned by another
agent), not here.

## Deploy

```
npx wrangler deploy --config wrangler.voice.jsonc
```

The cron trigger (`* * * * *`, every minute) drains the `notification_outbox`
queue. Failed Twilio call placements back off and retry up to
`VOICE_MAX_ATTEMPTS` (default 2) before the outbox row is marked `failed`.

## Compliance surface

This Worker places **outbound automated calls to businesses** (clinics), not
consumers, using pre-recorded/synthesized speech read over the phone. A few
things worth being deliberate about:

- **Call recording is NOT enabled.** No `<Record>` verb is used anywhere in
  this Worker, and Twilio's account-level call recording is not turned on by
  anything here.
- Outbound calling to a business is generally treated differently under
  telemarketing law than calls to consumers, but rules vary by state and
  change over time. **The operator is responsible for confirming their own
  obligations — including any state-specific restrictions on automated or
  artificial-voice calls, required disclosures, and calling-hours limits — in
  every state where clinics are being called.** Nothing in this codebase
  constitutes legal advice.
