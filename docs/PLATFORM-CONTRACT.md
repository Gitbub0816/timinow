# Tími NOW platform contract

Every surface — customer PWA, veterinary web console, veterinary desktop apps,
admin console, and the native mobile client — speaks the same Worker API and
shares the same design tokens. This document is the contract between them.

## Deployment topology

| Worker | Config | Surface var | Purpose |
| --- | --- | --- | --- |
| `timinow` | `wrangler.jsonc` | `customer` | Public PWA, customer API, map and navigation |
| `timinow-vet` | `wrangler.vet.jsonc` | `clinic` | Veterinary operations console + tenant people management |
| `timinow-admin` | `wrangler.admin.jsonc` | `admin` | Platform operator console. Tenant creation lives only here |
| `timinow-voice` | `wrangler.voice.jsonc` | `voice` | Automated clinic calling. No human UI |

All four bind the same D1 database (`timinow`, `eae5bd15-686f-4827-9354-e99973daa803`)
and all four set `SIGN_IN_REQUIRED = "true"` and `DEMO_MODE = "false"`.

## Authorization model

There are exactly three authority levels, plus two narrower, purpose-built
sessions that stand in for the first two without a Clerk login: a **guest
session** stands in for a customer, and a **workstation session** stands in
for a tenant member on a fixed, short list of routine operations.

1. **Customer** — any signed-in Clerk user with no active organization, or an
   anonymous **guest session** (below). Reaches the customer API only.
2. **Tenant member / tenant administrator** — a Clerk organization member, or
   — for routine clinic operations only — a **workstation session** (below).
   The organization maps to `tenants.clerk_org_id`. An administrator
   (`org:admin`) may add and remove people, and create and revoke
   workstations, **inside their own organization only**.
3. **Platform operator** — listed in `PLATFORM_ADMIN_USER_IDS` /
   `PLATFORM_ADMIN_EMAILS` on the admin Worker, or present in `platform_admins`.
   Only a platform operator may create a tenant.

Tenant creation is deliberately unreachable from the customer Worker and from the
veterinary console; `scripts/validate.mjs` asserts this.

### Guest sessions — booking without an account

A pet owner must be able to search, get offers, pay, and book with nothing
more than a phone number typed into the intake form. `SIGN_IN_REQUIRED` is
`"true"` on every production Worker, so this is backed by a **guest
session**: a random id minted on first contact and carried in a signed,
httpOnly cookie (`src/guest-session.js`), never by relaxing
`SIGN_IN_REQUIRED` itself. The guest id fills `customer_user_id` /
`clerk_user_id` exactly like a Clerk user id would, so every ownership check
already written against those columns scopes a guest's rows correctly with
no special-casing, and a second guest can never read or write the first
guest's data.

Clerk's phone-code sign-in (already wired in `public/app.js`, one field plus
a one-time code) is the *optional* upgrade path, never a requirement: once a
booking exists, `POST /api/account/adopt-guest` merges the guest session's
pets, intakes, and care searches onto the now-authenticated Clerk user,
idempotently (`account_adoptions`; see `src/account-adoption.js`).

### Workstation sessions — a shared reception desk

Routine clinic operations — availability/capacity, and accepting, declining,
or offering on a request — do not require an individual Clerk login. A
workspace administrator names a workstation ("Front desk 1") and receives a
one-time enrollment token (shown once, stored only hashed); entering it opens
a durable, revocable session (`src/workstation.js`). Every action a
workstation session takes is still attributed — clinic, workstation, session,
and timestamp — via `workstation_audit_log`, and revoking a workstation
invalidates every session it ever established immediately. Everything else
(settings, payouts, call preferences, people, creating or revoking a
workstation) still requires an individually signed-in org member.

## Clerk metadata contract

Desktop and native clients resolve their tenant from the session token rather
than a second round trip, so three metadata surfaces must agree:

| Surface | Keys |
| --- | --- |
| Organization `public_metadata` | `tenantId`, `tenantSlug`, `locationId` |
| Organization membership `public_metadata` | `tenantId`, `tenantSlug`, `locationId` |
| User `public_metadata` | `tenantId`, `tenantSlug`, `locationId`, `lastTenantId` |

The admin console writes all three when it creates a tenant. `GET /api/session`
re-checks them on every sign-in and repairs whatever drifted (`src/session.js`),
so a workspace created by hand in the Clerk dashboard still converges.

### Required Clerk JWT template

Create a Clerk JWT template named `timinow` with these claims so the Worker can
authorize without calling the Backend API:

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

Clients request it with `session.getToken({ template: "timinow" })`. The Worker
still works without the template — it falls back to the default `o` claim plus a
D1 lookup — but every request then costs one extra database read.

## Shared API

Served identically by all three Workers unless noted.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/config` | public | Publishable keys, Mapbox token and style, surface name |
| `GET` | `/api/health` | public | Liveness |
| `GET` | `/api/session` | signed in | Session descriptor + metadata repair (below) |
| `GET` | `/api/tenant/members` | tenant admin | Roster and pending invitations |
| `POST` | `/api/tenant/members` | tenant admin | `{ email, role }` — adds or invites |
| `PATCH` | `/api/tenant/members/:userId` | tenant admin | `{ role }` |
| `DELETE` | `/api/tenant/members/:userId` | tenant admin | Remove from workspace |
| `DELETE` | `/api/tenant/invitations/:id` | tenant admin | Revoke a pending invitation |
| `POST` | `/api/account/adopt-guest` | signed in | Merge the caller's guest session (pets, intakes, searches) onto their account |

Clinic operations, served identically by `timinow` and `timinow-vet`. Routes
marked "routine" accept an org member **or** a workstation session; every
other clinic route still requires an org member:

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/clinic/workstations/session` | public (enrollment token) | Redeem a workstation's enrollment token for a session |
| `DELETE` | `/api/clinic/workstations/session` | workstation session | End just this device's session |
| `GET` / `POST` | `/api/clinic/workstations` | tenant admin | List / create a workstation (the token is returned once, on create) |
| `DELETE` | `/api/clinic/workstations/:id` | tenant admin | Revoke a workstation and every session it established |
| `GET` | `/api/clinic/dashboard` | org member or workstation (routine) | The live queue and current availability |
| `POST` | `/api/clinic/availability` | org member or workstation (routine) | Publish intake status and capacity |
| `POST` | `/api/clinic/intakes/:id/decision` | org member or workstation (routine) | Accept or decline a direct intake |
| `POST` | `/api/clinic/search-targets/:id/decision` | org member or workstation (routine) | Offer or decline on a multi-clinic search |
| `GET` | `/api/clinic/payouts` | org member | Settlement ledger |
| `GET` / `PATCH` | `/api/clinic/call-preferences` | org member | Voice calling policy |

Admin Worker only:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/bootstrap` | Whether the caller is a platform operator |
| `GET` | `/api/admin/tenants` | Every tenant with location and member counts |
| `POST` | `/api/admin/tenants` | Create a tenant: Clerk organization + D1 rows + metadata |
| `GET` | `/api/admin/tenants/:id` | One tenant with members, locations, policy |
| `PATCH` | `/api/admin/tenants/:id` | Rename, change status |
| `POST` | `/api/admin/tenants/:id/locations` | Add a location to a tenant |
| `POST` | `/api/admin/tenants/:id/admins` | Seat the first workspace administrator |
| `GET` | `/api/admin/audit` | Recent privileged actions |

### `GET /api/session` response

```json
{
  "session": {
    "authenticated": true,
    "user": { "id": "user_…", "email": "…", "name": "…", "role": "org:admin", "permissions": [] },
    "organization": { "id": "org_…", "slug": "hearth-paw" },
    "tenant": { "id": "tenant_…", "name": "…", "slug": "…", "status": "active" },
    "location": { "id": "loc_…", "name": "…", "address": "…", "phone": "…" },
    "platformAdmin": false,
    "surfaces": { "customer": true, "clinic": true, "admin": false },
    "repairedMetadata": ["organization", "membership"]
  }
}
```

### `GET /api/config` response

```json
{
  "appName": "Tími NOW",
  "signInRequired": true,
  "clerkPublishableKey": "pk_live_…",
  "clerkJsUrl": "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/headless/+esm",
  "stripePublishableKey": "pk_live_…",
  "demoMode": false,
  "database": "d1",
  "surface": "customer",
  "map": {
    "token": "pk.…",
    "styleUrl": "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u",
    "navigationStyleUrl": "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u"
  }
}
```

The veterinary and clinic APIs (`/api/clinic/*`) are unchanged from the MVP.

## Authentication UI rule

**No surface may mount a prebuilt Clerk component.** `mountSignIn`, `mountSignUp`,
`mountUserButton`, `mountOrganizationSwitcher`, `mountOrganizationProfile`,
`mountUserProfile`, `mountOrganizationList`, and `openSignIn()` are all banned and
`scripts/validate.mjs` fails the build if any appears. Every surface loads
`@clerk/clerk-js` **headless** and drives the flows through the client API:

```js
const clerk = new Clerk(publishableKey);
await clerk.load();                       // headless build ships no UI
const attempt = await clerk.client.signIn.create({ identifier, strategy, password });
await clerk.setActive({ session: attempt.createdSessionId });
```

Supported strategies, all with Tími-designed screens:

| Strategy | Call |
| --- | --- |
| Password | `signIn.create({ identifier, strategy: "password", password })` |
| Email code | `signIn.create({ identifier })` then `prepareFirstFactor({ strategy: "email_code", emailAddressId })` |
| Phone code | `prepareFirstFactor({ strategy: "phone_code", phoneNumberId })` |
| Passkey | `signIn.authenticateWithPasskey()` |
| Google | `signIn.authenticateWithRedirect({ strategy: "oauth_google", redirectUrl, redirectUrlComplete })` |
| Apple | `signIn.authenticateWithRedirect({ strategy: "oauth_apple", … })` |

Organization switching uses `clerk.setActive({ organization })` behind a custom
picker, never `mountOrganizationSwitcher`.

## Automated clinic calling

A care search fans out to as many as 30 clinics, most of which have nobody
watching a console. `timinow-voice` calls them.

`createCareSearch` writes one `notification_outbox` row per clinic with
`channel = 'voice'`; the voice Worker's cron drains that queue every minute and
places a Twilio call:

> "Hi, this is Tími calling for {clinic}. A pet owner nearby is looking for
> immediate care for **a dog with vomiting or diarrhea, starting today**, about
> 11 minutes away. Do you have time to see them? Press 1 to confirm you can take
> them, or press 2 to decline. Press 9 to hear this again."

The pet's name is never spoken — the clinic gets it on the console, and a phone
tree is not the place for identifying details.

| Method | Path | Who |
| --- | --- | --- |
| `POST` | `/api/voice/outbound/:targetId` | Twilio — serves the TwiML prompt |
| `POST` | `/api/voice/gather/:targetId` | Twilio — receives the pressed digit |
| `POST` | `/api/voice/status/:callId` | Twilio — call lifecycle |
| `GET` | `/api/voice/attempts?searchId=` | Clerk, tenant-scoped — the call log |

**The webhooks cannot be authenticated by Clerk**, because Twilio cannot sign
in. Their authentication is Twilio's request signature (HMAC-SHA1 over the full
URL plus the sorted POST parameters), plus a per-attempt HMAC token embedded in
the callback URL so a leaked URL cannot be replayed against a different clinic.
Both checks run even in demo mode; demo mode only suppresses *placing* calls.

**Pressing 1 is the same code path as clicking accept.** Both call
`applyCareSearchDecision` in `src/index.js`, which takes plain values rather than
a Request precisely so a webhook with no JSON body and no actor can share it.
`scripts/validate.mjs` fails the build if the voice Worker grows its own copy of
the offer SQL, and `scripts/voice-test.mjs` asserts the two produce identical
`care_offers` rows.

Tenants control their own phones: `tenants.voice_calls_enabled`,
`locations.voice_calls_enabled`, `locations.voice_phone`, and
`tenants.voice_quiet_hours_json`. A call blocked by quiet hours is cancelled
rather than deferred — a care search expires in six and a half minutes, so a
call held until morning would ring about a pet seen hours earlier.

## Design tokens

Identical across web, WPF, SwiftUI, and the consoles.

| Token | Value |
| --- | --- |
| Ink | `#111B3B` |
| Ink soft | `#3F4862` |
| Paper | `#FFFAF0` |
| Blue | `#2357D9` |
| Blue dark | `#173C9A` |
| Blue soft | `#E5ECFF` |
| Coral | `#F25F4C` |
| Coral dark | `#BD3E31` |
| Coral soft | `#FFE5DF` |
| Gold | `#F7C84B` |
| Gold soft | `#FFF0B9` |
| Canvas | `#F3F5FA` |
| Line | `#D9D8D2` |
| Muted | `#6F7483` |
| Danger | `#BD3E31` |
| Hard shadow | `7px 7px 0 #111B3B` |
| Display font | Georgia, "Times New Roman", serif |
| UI font | Inter, ui-sans-serif, system stack |

Status colors: available `#2357D9`, limited/confirm-first `#E29316`,
unverified `#808797`, critical-only/diverting/closed `#F25F4C`.

## Map and navigation

One style everywhere: `mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u`.

- **Web** — Mapbox GL JS renders clinic pins, the customer position, and the
  selected route line. The Directions API supplies geometry and the step list.
- **iOS** — MapboxNavigation renders full turn-by-turn against the same style,
  with spoken instructions, CarPlay, and a companion Watch app.
- The public token (`pk.…`) is delivered by `/api/config` and is never checked in.
