# Tími platform console (`timinow-admin`)

The platform operator console. It is the **only** place in the entire Tími
platform where a tenant (a veterinary workspace) can be created. Everything
else it does — renaming a workspace, suspending it, adding a location, seating
or removing people, reviewing the audit trail — is also available in narrower
form from the veterinary console, but tenant creation is deliberately
unreachable from anywhere except here.

See `docs/PLATFORM-CONTRACT.md` for the full authorization model and Clerk
metadata contract this console implements.

## Why a separate Worker

`timinow` (customer), `timinow-vet` (veterinary), and `timinow-admin`
(this one) are three independent Cloudflare Workers, each with its own
`wrangler*.jsonc`, its own deployment, and its own origin. They share one D1
database and one set of design tokens, but nothing in the customer or
veterinary Worker can reach `/api/admin/*` — that code doesn't exist in those
Workers. The point of the separation is that the platform-operator surface
(create/suspend a tenant, see every workspace's audit trail) never shares an
origin with anything a customer or a clinic staff member can load, so a bug or
compromise in the public surfaces can't reach tenant creation.

## Becoming a platform operator

A platform operator is anyone who is:

- listed (by Clerk user id) in the `PLATFORM_ADMIN_USER_IDS` Worker variable
  in `wrangler.admin.jsonc` (comma-separated), or
- listed (by account email) in `PLATFORM_ADMIN_EMAILS` (comma-separated), or
- present as a row in the `platform_admins` D1 table.

The env-variable allowlists exist so the very first operator can bootstrap the
table without needing a row inserted by hand. To add yourself:

1. Sign in to `timinow-admin` once (the console will show a "not a platform
   operator" screen with your Clerk user id and email — copy the id).
2. Add that id to `PLATFORM_ADMIN_USER_IDS` in `wrangler.admin.jsonc` (or your
   email to `PLATFORM_ADMIN_EMAILS`), then redeploy — or run:
   ```sql
   INSERT INTO platform_admins (clerk_user_id, email, label) VALUES ('user_xxx', 'you@example.com', 'first operator');
   ```
   against the `timinow` D1 database.
3. Reload the console (or use its "I've updated access — check again" button).

## Deploy

```sh
npx wrangler deploy --config wrangler.admin.jsonc
```

### Required secret

```sh
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.admin.jsonc
```

This is the Clerk **Backend API** secret key. It is what lets this Worker
verify session tokens and call the Clerk Backend API to create/rename/delete
organizations, seat and remove members, and merge metadata — the same key
used by the other two Workers.

### Worker variables (in `wrangler.admin.jsonc`)

| Variable | Purpose |
| --- | --- |
| `SIGN_IN_REQUIRED` | Always `"true"` here — this console has no unauthenticated mode. |
| `PLATFORM_ADMIN_USER_IDS` / `PLATFORM_ADMIN_EMAILS` | The bootstrap allowlist described above. |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_ISSUER`, `AUTHORIZED_PARTIES` | Same Clerk instance as the other two Workers. |
| `MAPBOX_PUBLIC_TOKEN`, `MAPBOX_STYLE_URL` | Used only to render the location-pin map on the "create tenant" screen. The style URL is pinned platform-wide; the token may be left empty (see below). |

## What happens when a tenant is created

`POST /api/admin/tenants` performs, in order, with rollback if anything past
step 2 fails:

1. **Validate** the workspace, first location, and policy fields; derive a
   slug from the name when one isn't supplied, and reject if that slug is
   already taken.
2. **Create the Clerk organization** (`createOrganization`), passing a
   pre-generated `tenantId` in the organization's `public_metadata` so the
   org never exists without that metadata.
3. **Write D1 rows** in a single batch (atomic as one transaction): the
   `tenants` row, the first `locations` row, an initial `tenant_policies`
   version-1 row (defaulted to the Tími baseline — $50 deposit, $20
   completed-visit fee, $5 no-show/late-cancel fee, 30-minute free-cancel
   window — see `docs/PAYMENTS-AND-TENANT-POLICIES.md`), and a seed
   `availability_reports` row (`unverified` / `seed` / `low` confidence) so
   the location has a real availability record instead of a null one from
   the moment it exists.
   - **If this step fails, the Clerk organization created in step 2 is
     deleted** so nothing is left orphaned in Clerk, and the request fails
     with a clear error.
4. **Merge the real `locationId`** into the organization's `public_metadata`
   now that the location row exists.
5. **Seat or invite the first administrator**, if `adminEmail` was given: an
   existing Clerk user is added to the organization directly as `org:admin`
   and has their membership and user metadata merged with
   `tenantId`/`tenantSlug`/`locationId` (+ `lastTenantId` on the user); anyone
   else receives a Clerk organization invitation instead. A failure at this
   step does **not** roll back the tenant — the workspace already exists
   correctly, so the console instead reports the seating failure and the
   operator can add the administrator afterward from the tenant detail
   screen.
6. **Record the audit entry** (`tenant.created`, `actor_scope = 'platform'`)
   in `admin_audit_log`.

Every other admin mutation (rename, suspend/reactivate, add a location, seat
an additional administrator, or manage the roster through the shared
`/api/tenant/*` routes with `?tenantId=`) follows the same pattern: write D1,
mirror into Clerk where relevant, record an audit row.

## The map on "create tenant"

The location step embeds Mapbox GL JS (loaded from
`https://api.mapbox.com/mapbox-gl-js/v3.9.0/`) so an operator can click to
drop a pin instead of typing coordinates. It reads `token` and `styleUrl` from
`GET /api/config`. If `MAPBOX_PUBLIC_TOKEN` is empty (or the script fails to
load), the map is hidden and replaced with a plain notice plus the numeric
latitude/longitude inputs, which remain fully functional — the form never
depends on the map to submit.

## Authentication

Like every Tími surface, this console never mounts a prebuilt Clerk
component. It loads `@clerk/clerk-js` headless and drives sign-in itself:
identifier → strategy choice (from `signIn.supportedFirstFactors`) → password
or a 6-digit email/phone code, plus passkey and Google/Apple redirect
sign-in. Because this is an operator-only console, there is no sign-up flow.
