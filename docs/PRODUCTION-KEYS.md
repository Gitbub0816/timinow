# Keys, secrets, and accounts you still need

Everything below is either **missing** from the repository today or must be
created in a third-party dashboard. Nothing here is checked in, and nothing here
should ever be checked in.

Legend: **var** = plain Worker variable, safe in `wrangler.*.jsonc`.
**secret** = `wrangler secret put NAME --config <config>`, never in a file.

---

## 1. Cloudflare — mostly done

| What | Status | Notes |
| --- | --- | --- |
| Cloudflare account + Workers | ✅ have | |
| D1 database `timinow` | ✅ have | `eae5bd15-686f-4827-9354-e99973daa803`, now bound in all three Workers |
| `CLOUDFLARE_API_TOKEN` | ⬜ needed only for CI | Scope: *Account → Workers Scripts → Edit*, *Account → D1 → Edit*. Only if you want GitHub Actions to deploy |

Run the migrations once against the real database before the first production
request — the new tenancy tables do not exist there yet:

```bash
npm run db:migrate:remote
```

---

## 2. Clerk — the largest gap

The container this work was done in had a `CLERK_SECRET_KEY` in its environment,
but **no Clerk value is configured on any Worker**. All three Workers need the
same instance.

| Name | Kind | Where to find it |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | var | Clerk dashboard → API keys → Publishable key (`pk_live_…`) |
| `CLERK_SECRET_KEY` | **secret** | Clerk dashboard → API keys → Secret key (`sk_live_…`) |
| `CLERK_ISSUER` | var | Your Frontend API URL, e.g. `https://clerk.timinow.com` or `https://<slug>.clerk.accounts.dev`. The Worker derives the JWKS URL from it |
| `AUTHORIZED_PARTIES` | var | Comma-separated list of the three production origins, e.g. `https://timinow.<subdomain>.workers.dev,https://timinow-vet.<subdomain>.workers.dev,https://timinow-admin.<subdomain>.workers.dev` |

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.vet.jsonc
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.admin.jsonc
```

### Dashboard configuration that is not a key

1. **JWT template named `timinow`** — required for the claims the Workers read.
   Clerk dashboard → JWT Templates → New template → Blank:
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
   Without it everything still works, but every clinic request costs one extra D1
   read to map the organization to a tenant.

2. **Organizations must be enabled** — the whole tenancy model is Clerk
   organizations. Turn off "Allow members to create organizations": only the
   platform console may create one.

3. **Google OAuth** — Clerk dashboard → SSO connections → Google. Needs a Google
   Cloud OAuth client ID + secret, with Clerk's callback URL in the authorized
   redirect URIs. (Clerk's shared dev credentials work for testing but must not
   be used in production.)

4. **Apple OAuth** — needs an Apple Developer account: a Services ID, your Team
   ID, a Key ID, and the `.p8` private key, all pasted into Clerk.

5. **Passkeys** — Clerk dashboard → User & authentication → Passkeys. The relying
   party ID is your domain, so passkeys only work on the real hostname, not on a
   `workers.dev` preview shared with other origins.

6. **Allowed redirect origins** — add these so the desktop apps can complete
   OAuth in the system browser:
   - `http://127.0.0.1` (the Windows app opens a one-shot loopback listener)
   - `timivet://` (the macOS app's `ASWebAuthenticationSession` callback scheme)

### Platform operator allowlist

| Name | Kind | Config |
| --- | --- | --- |
| `PLATFORM_ADMIN_EMAILS` | var | `wrangler.admin.jsonc` — set to `1morecruise@gmail.com` |
| `PLATFORM_ADMIN_USER_IDS` | var | `wrangler.admin.jsonc` — your Clerk `user_…` id |

Sign in to the admin console once; if you are not yet an operator it shows your
Clerk user id on screen so you can paste it in. Email alone is enough to
bootstrap, but pin the user id afterwards — it cannot be re-registered the way an
email address can.

---

## 3. Mapbox — **you do not currently have a token in this repo**

You said "the current key will cover it," but there is no Mapbox token, script,
style reference, or map anywhere in the repository's history. Two different
tokens are needed, and they are not interchangeable.

| Name | Kind | Scopes | Used by |
| --- | --- | --- | --- |
| `MAPBOX_PUBLIC_TOKEN` (`pk.…`) | var | `styles:read`, `styles:tiles`, `fonts:read`, `datasets:read`, `vision:read` | Web maps, iOS maps, turn-by-turn at runtime |
| Mapbox **secret download token** (`sk.…`) | never in the repo | `DOWNLOADS:READ` | Only to *download* the iOS SDKs at build time |

`MAPBOX_STYLE_URL` is already set to
`mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u` in all three Workers.

The public token is served to browsers by `/api/config`, so restrict it in the
Mapbox dashboard to your three production origins (Account → Tokens → the token →
URL restrictions). A `pk.` token is public by design; URL restriction is what
keeps someone else from billing your account.

The secret token never goes in the repository. It goes in `~/.netrc` on the Mac
that builds the iOS app:

```
machine api.mapbox.com
  login mapbox
  password sk.eyJ1IjoiY2FsZWJvd2VuMjAxOSIsImE...
```

**Billing note:** the Navigation SDK is priced separately from map loads —
monthly active users for the SDK, plus Directions API requests for route
geometry. Free tiers exist on both; confirm the current thresholds before launch,
because turn-by-turn is materially more expensive than showing a styled map.

---

## 4. Stripe — deposits are off until these exist

| Name | Kind |
| --- | --- |
| `STRIPE_PUBLISHABLE_KEY` | var (`pk_live_…`) |
| `STRIPE_SECRET_KEY` | **secret** (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | **secret** (`whsec_…`), once you add webhook confirmation |

`DEMO_MODE` is now `"false"`, so the payment endpoint will no longer simulate a
successful deposit. Until the Stripe keys are set, any tenant whose policy sets
`depositRequired` will fail at the payment step. Either add the keys or set every
tenant's `deposit_required` to `0` before taking real traffic.

You will also need Stripe Connect onboarding per clinic, and the Connected
Account Agreement disclosures listed in `docs/LEGAL-LAUNCH-CHECKLIST.md`.

---

## 5. Apple — for the iOS app, CarPlay, and the Watch app

| What | Notes |
| --- | --- |
| Apple Developer Program membership | $99/yr, required for any device build |
| Team ID + signing certificates | Set in `apps/customer-mobile/Darwin/project.yml` |
| APNs auth key (`.p8`) | For offer-arrival push notifications |
| **CarPlay entitlement** | `com.apple.developer.carplay-driving-navigation` is **not self-serve**. You must apply at developer.apple.com/carplay and be approved. The code and entitlement file are in place; the build will not sign until Apple grants it. Approval typically takes weeks and Apple does reject apps that are not primarily navigation apps — be ready to argue that Tími's core job is getting a pet to a clinic |
| Apple Services ID + key | Also needed for Apple OAuth in Clerk (above) |

---

## 6. Microsoft — for shipping the Windows app

| What | Notes |
| --- | --- |
| Code-signing certificate (OV or EV) | Unsigned installers trip SmartScreen. EV clears SmartScreen immediately; OV builds reputation over time |
| Partner Center account | Only if you distribute through the Microsoft Store |

---

## 7. Not needed yet, but on the horizon

| What | Why |
| --- | --- |
| SMS provider (Twilio or similar) | `notification_outbox` has an `sms` channel with no delivery worker behind it |
| Email provider (Resend, Postmark, SES) | Same table, `email` channel |
| Cloudflare Turnstile | `docs/MVP-ARCHITECTURE.md` lists it as a pre-launch requirement on public intake mutations |

---

## Fastest path to a working production deploy

```bash
# 1. Migrate the real database
npm run db:migrate:remote

# 2. Fill CLERK_PUBLISHABLE_KEY, CLERK_ISSUER, AUTHORIZED_PARTIES,
#    MAPBOX_PUBLIC_TOKEN in all three wrangler configs, and
#    PLATFORM_ADMIN_EMAILS in wrangler.admin.jsonc

# 3. Set the secrets
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.vet.jsonc
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.admin.jsonc

# 4. Deploy all three Workers
npm run deploy:all

# 5. Open the admin console, sign in, create your first tenant
```
