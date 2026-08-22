# Production setup — timinow.pet

Every hostname, endpoint, and dashboard field, with the exact value to paste.
Companion to [`docs/PRODUCTION-KEYS.md`](PRODUCTION-KEYS.md), which explains
what each secret is and where to find it.

---

## 1. Hostnames

| Hostname | Worker | Serves |
| --- | --- | --- |
| `timinow.pet` | `timinow` | Public site + customer app |
| `www.timinow.pet` | `timinow` | Same Worker, so a bare link works |
| `app.timinow.pet` | `timinow` | The customer app |
| `providers.timinow.pet` | `timinow-vet` | Veterinary console |
| `admin.timinow.pet` | `timinow-admin` | Platform operator console |
| `voice.timinow.pet` | `timinow-voice` | Twilio webhooks only |
| `clerk.timinow.pet` | — | Clerk Frontend API (Clerk hosts this) |

**You told me about two subdomains; this needs four.** `admin.timinow.pet` and
`voice.timinow.pet` are new. Both are DNS records in the same zone, so there is
nothing to buy — but they do have to exist before the Workers will answer.

Everything sitting under one registrable domain is worth more than tidiness
here: Clerk's session cookie is set on `timinow.pet`, so a signed-in vet moving
between `app.` and `providers.` stays signed in. Had the consoles lived on
separate domains, each would have needed Clerk satellite-domain configuration.

The routes are already committed in the four `wrangler.*.jsonc` files.
`scripts/validate.mjs` fails the build if a route is added without adding its
origin to `AUTHORIZED_PARTIES`.

---

## 2. Cloudflare DNS

The zone `timinow.pet` must be on the same Cloudflare account as the Workers.
Adding a Worker route creates the DNS record for you when the zone is active; if
you would rather create them first, each is a proxied placeholder:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| `AAAA` | `@` | `100::` | Proxied |
| `AAAA` | `www` | `100::` | Proxied |
| `AAAA` | `app` | `100::` | Proxied |
| `AAAA` | `providers` | `100::` | Proxied |
| `AAAA` | `admin` | `100::` | Proxied |
| `AAAA` | `voice` | `100::` | Proxied |

`100::` is the IPv6 discard prefix — the record exists only so Cloudflare has
something to attach the Worker route to. Traffic never reaches it.

Clerk adds its own records; see §4.

---

## 3. Twilio

### Endpoints

The Worker sets these **per call**, in the REST request that places it. You do
not paste them into a phone number's configuration — a number's console fields
are for *inbound* calls, and Tími only dials out.

| Purpose | URL |
| --- | --- |
| TwiML (the prompt) | `https://voice.timinow.pet/api/voice/outbound/{targetId}?attempt={attemptId}&tok={token}` |
| Keypad answer | `https://voice.timinow.pet/api/voice/gather/{targetId}?attempt={attemptId}&tok={token}` |
| Call lifecycle | `https://voice.timinow.pet/api/voice/status/{attemptId}?attempt={attemptId}&tok={token}` |

`attempt` names one row in `clinic_call_attempts`; `tok` is an HMAC of it under
your Twilio auth token, so a leaked URL cannot be replayed against a different
clinic. Twilio's own `X-Twilio-Signature` covers the whole URL including the
query string, which is what makes those parameters tamper-proof.

**`VOICE_PUBLIC_URL` must be exactly `https://voice.timinow.pet`** — no trailing
slash, no `www`. Twilio signs the URL string, so a mismatch rejects every call.
It is already set in `wrangler.voice.jsonc`, and the validator fails the build
if it ever stops matching the route.

### What to configure in the Twilio console

1. **Buy a Voice-capable number** in the area you operate. Clinics see it on
   caller ID, so pick something you are willing to answer.
2. Set it as `TWILIO_FROM_NUMBER` in `wrangler.voice.jsonc`, in E.164
   (`+1510XXXXXXX`).
3. **Inbound handling for that number** — Tími does not serve inbound calls.
   Point *Voice → A call comes in* at a TwiML Bin that forwards to your real
   line, or a simple message. Leaving it on Twilio's default demo message means
   a clinic calling you back hears a Twilio advertisement.
4. Nothing else. No TwiML App, no Studio Flow, no webhook fields on the number.

### Verify it end to end

```bash
curl -s https://voice.timinow.pet/api/health
# {"ok":true,"service":"timinow-voice","database":true,"twilioConfigured":true}
```

`twilioConfigured: false` means a secret is missing. Then submit a real intake
from `app.timinow.pet`, and watch:

```bash
npx wrangler tail --config wrangler.voice.jsonc
```

An unsigned request is rejected, which is the correct behaviour and a quick way
to confirm the guard is live:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://voice.timinow.pet/api/voice/gather/anything?attempt=x&tok=y' \
  -d 'Digits=1'
# 403
```

---

## 4. Clerk

Create a **production** instance for `timinow.pet` (a development instance
cannot serve a custom domain).

### DNS records Clerk will ask for

| Type | Name | Points to |
| --- | --- | --- |
| `CNAME` | `clerk` | `frontend-api.clerk.services` |
| `CNAME` | `accounts` | `accounts.clerk.services` |
| `CNAME` | `clkmail` | `mail.<your-instance>.clerk.services` |
| `CNAME` | `clk._domainkey` | `dkim1.<your-instance>.clerk.services` |
| `CNAME` | `clk2._domainkey` | `dkim2.<your-instance>.clerk.services` |

Clerk shows the exact right-hand values; the `<your-instance>` parts are unique
to you. **Set these to DNS-only, not proxied** — Cloudflare's orange cloud in
front of Clerk's endpoints breaks them.

The `clkmail` and `_domainkey` records are what let one-time codes arrive from
`timinow.pet` rather than a Clerk address. Without them, email codes still send,
but from a domain a clinic will not recognise.

### Values that go into the Workers

Already committed:

```
CLERK_ISSUER        https://clerk.timinow.pet
AUTHORIZED_PARTIES  https://app.timinow.pet,https://timinow.pet,https://www.timinow.pet,https://providers.timinow.pet,https://admin.timinow.pet
```

Still to fill in, in all four `wrangler.*.jsonc` files:

```
CLERK_PUBLISHABLE_KEY   pk_live_…
```

And as a secret, per Worker:

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.vet.jsonc
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.admin.jsonc
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.voice.jsonc
```

`voice.timinow.pet` is deliberately absent from `AUTHORIZED_PARTIES`: no browser
ever loads a Clerk session there.

### Clerk dashboard settings

**JWT template**, named exactly `timinow`:

```json
{
  "email": "{{user.primary_email_address}}",
  "username": "{{user.username}}",
  "tenant_id": "{{org.public_metadata.tenantId}}",
  "location_id": "{{org.public_metadata.locationId}}",
  "org_id": "{{org.id}}",
  "org_slug": "{{org.slug}}",
  "org_role": "{{org.role}}"
}
```

**Organizations**: enabled. Turn **off** "allow members to create
organizations" — only the platform console may create a tenant.

**Allowed redirect origins** — the desktop apps complete OAuth in the system
browser and hand back to a local listener:

```
https://app.timinow.pet
https://providers.timinow.pet
https://admin.timinow.pet
http://127.0.0.1
timivet://
```

**Sign-in methods**: email, username, phone, password, email code, phone code,
passkey, Google, Apple. Passkeys need the relying-party domain set to
`timinow.pet`, which is why every surface lives under it.

**Paths**: leave Clerk's hosted pages unused. Every screen is Tími's own; the
app never navigates to `accounts.timinow.pet`.

---

## 5. Mapbox

Restrict the public token so someone else cannot spend your quota. Mapbox →
Tokens → your `pk.` token → URL restrictions:

```
https://timinow.pet/*
https://www.timinow.pet/*
https://app.timinow.pet/*
https://providers.timinow.pet/*
https://admin.timinow.pet/*
```

Then set `MAPBOX_PUBLIC_TOKEN` in all four `wrangler.*.jsonc` files. The style
URL is already pinned.

The `sk.` downloads token is **not** a Worker variable — it belongs in `~/.netrc`
on the Mac that builds the iOS app.

---

## 6. Stripe

| Field | Value |
| --- | --- |
| Webhook endpoint | `https://app.timinow.pet/api/stripe/webhook` |
| Statement descriptor | Something a customer will recognise, e.g. `TIMINOW PET` |

`STRIPE_PUBLISHABLE_KEY` is a variable; `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` are secrets on the `timinow` Worker only.

Note: the webhook route is not implemented yet — the Worker verifies payment by
re-reading the PaymentIntent rather than trusting a callback. Add the endpoint in
Stripe when that handler lands, not before.

---

## 7. Deploy order

DNS and Clerk first; the Workers will not answer on a hostname whose zone is not
active, and sign-in fails until the Clerk records resolve.

```bash
# 1. Migrate the production database (once)
npm run db:migrate:remote

# 2. Confirm every config still agrees with itself
npm run check

# 3. Deploy all four Workers
npm run deploy:all
```

Then, in order:

```bash
curl -s https://timinow.pet/api/health
curl -s https://providers.timinow.pet/api/health
curl -s https://admin.timinow.pet/api/health
curl -s https://voice.timinow.pet/api/health
```

Open `https://admin.timinow.pet`, sign in, and create your first tenant. If you
are not yet a platform operator the screen shows your Clerk user id — paste it
into `PLATFORM_ADMIN_USER_IDS` in `wrangler.admin.jsonc` and redeploy that one
Worker.

---

## 8. Every value, in one place

| Setting | Value | Where |
| --- | --- | --- |
| `CLERK_ISSUER` | `https://clerk.timinow.pet` | ✅ committed |
| `AUTHORIZED_PARTIES` | the five browser origins above | ✅ committed |
| `VOICE_PUBLIC_URL` | `https://voice.timinow.pet` | ✅ committed |
| `MAPBOX_STYLE_URL` | `mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u` | ✅ committed |
| Worker routes | the six hostnames above | ✅ committed |
| `CLERK_PUBLISHABLE_KEY` | `pk_live_…` | ⬜ you |
| `MAPBOX_PUBLIC_TOKEN` | `pk.…` | ⬜ you |
| `TWILIO_FROM_NUMBER` | `+1…` | ⬜ you |
| `PLATFORM_ADMIN_EMAILS` | `1morecruise@gmail.com` | ⬜ you |
| `PLATFORM_ADMIN_USER_IDS` | `user_…` | ⬜ after first sign-in |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_…` | ⬜ you |
| `CLERK_SECRET_KEY` | `sk_live_…` | ⬜ secret ×4 |
| `TWILIO_ACCOUNT_SID` | `AC…` | ⬜ secret |
| `TWILIO_AUTH_TOKEN` | — | ⬜ secret |
| `STRIPE_SECRET_KEY` | `sk_live_…` | ⬜ secret |
