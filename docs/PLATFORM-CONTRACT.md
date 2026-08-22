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

All three bind the same D1 database (`timinow`, `eae5bd15-686f-4827-9354-e99973daa803`)
and all three set `SIGN_IN_REQUIRED = "true"` and `DEMO_MODE = "false"`.

## Authorization model

There are exactly three authority levels.

1. **Customer** — any signed-in Clerk user with no active organization. Reaches
   the customer API only.
2. **Tenant member / tenant administrator** — a Clerk organization member. The
   organization maps to `tenants.clerk_org_id`. An administrator (`org:admin`)
   may add and remove people **inside their own organization only**.
3. **Platform operator** — listed in `PLATFORM_ADMIN_USER_IDS` /
   `PLATFORM_ADMIN_EMAILS` on the admin Worker, or present in `platform_admins`.
   Only a platform operator may create a tenant.

Tenant creation is deliberately unreachable from the customer Worker and from the
veterinary console; `scripts/validate.mjs` asserts this.

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
