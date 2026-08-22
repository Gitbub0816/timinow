# Tími NOW

Tími NOW is a real-time veterinary intake network. It answers **“Which veterinary hospital can take my pet right now?”** rather than offering future appointment scheduling.

## What is in this repository

| Surface | Path | Deploys as |
| --- | --- | --- |
| Customer PWA — intake, live capacity, offer comparison, map, turn-by-turn | `public/`, `src/` | Worker `timinow` |
| Veterinary web console — queue, capacity, decisions, always-on-top mini window | `apps/vet-web/` | Worker `timinow-vet` |
| Platform operator console — the only place a tenant can be created | `apps/admin-console/` | Worker `timinow-admin` |
| Voice gateway — calls clinics automatically and takes a keypad answer | `apps/voice-gateway/` | Worker `timinow-voice` |
| Customer iOS app — SwiftUI, Skip Fuse ready, Mapbox navigation, CarPlay, Watch | `apps/customer-mobile/` | App Store |
| Veterinary Windows app — WPF, tray alerts, floating queue | `apps/vet-windows/` | Signed installer |
| Veterinary macOS app — SwiftUI, floating panel, menu-bar item | `apps/vet-desktop/` | Developer ID / Mac App Store |

All four Workers bind the same D1 database and share the same session, tenancy,
and Clerk metadata code in `src/`.

## Reaching clinics that are not looking at a screen

A care search contacts up to 30 clinics. Most of them have nobody at a console,
so `timinow-voice` phones them and asks one question:

> "Do you have time to see a dog with vomiting or diarrhea, starting today,
> about 11 minutes away? Press 1 to confirm, or press 2 to decline."

Pressing 1 creates exactly the offer that clicking accept in the console would —
the same function, not a similar one. See
[`apps/voice-gateway/README.md`](apps/voice-gateway/README.md).

## Product routes

- `/#home` — public explanation and safety boundaries
- `/#find` — concise two-step immediate-care intake
- `/#results` — nearby live intake capacity, on the map and in the list
- `/#tracker` — offer comparison, confirmation, payment, milestones, and navigation to the clinic
- `/#pets` — portable pet-profile demonstration
- `/#clinic` — veterinary operations console
- `/#sign-in` — Tími's own sign-in, on Clerk's headless client
- `/#legal` — versioned terms, privacy, safety, deposit, and clinic policies

## Authentication

Sign-in is enforced (`SIGN_IN_REQUIRED = "true"`) and every screen is Tími's own
design. Clerk loads through its **headless** build and the flows are driven
against the client API directly, so no Clerk-branded modal, user button, or
organization switcher appears anywhere. `scripts/validate.mjs` fails the build if
a prebuilt Clerk component is reintroduced on any surface.

Supported identifiers are email, username, and phone number; supported factors
are password, email code, phone code, passkey, Google, and Apple.

Tenancy is Clerk organizations mapped to `tenants.clerk_org_id`. `GET /api/session`
repairs the organization, membership, and user metadata on every sign-in, so the
desktop and native clients resolve their tenant straight from the session token.

Read [`docs/PLATFORM-CONTRACT.md`](docs/PLATFORM-CONTRACT.md) before changing any
surface — it is the contract all six clients share.

## Who can do what

| Capability | Customer | Tenant member | Tenant administrator | Platform operator |
| --- | :-: | :-: | :-: | :-: |
| Request care, compare offers, navigate | ✅ | ✅ | ✅ | ✅ |
| Publish capacity, answer requests | | ✅ | ✅ | ✅ |
| Add and remove people in their workspace | | | ✅ | ✅ |
| **Create a tenant** | | | | ✅ |

Tenant creation exists only in the admin console Worker. The customer and
veterinary Workers do not implement the route at all.

## Maps and navigation

One style everywhere:
`mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u`.

- **Web** — `public/map.js` loads Mapbox GL JS on demand, renders clinic pins and
  the route line, and runs browser turn-by-turn with spoken directions.
- **iOS** — the Mapbox Navigation SDK renders full guidance against the same
  style, with a custom speech synthesizer, CarPlay, and a companion Watch app.

Driving-instruction wording lives in phrase tables, not in the guidance code, so
it can be changed without touching navigation logic. See
[`docs/NAVIGATION.md`](docs/NAVIGATION.md).

## Run locally

Requires Node.js 20+.

```bash
npm install
cp wrangler.local.example.jsonc wrangler.local.jsonc   # sign-in off, local D1
npm run db:migrate:local
npm run dev            # customer PWA
npm run dev:vet        # veterinary console, port 8788
npm run dev:admin      # admin console, port 8789
npm run dev:voice      # voice gateway, port 8790
```

The committed `wrangler.jsonc` is the **production** configuration. Local
development uses the git-ignored override so a stray `wrangler dev` can never
point at production with authentication disabled.

## Deploy

```bash
npm run db:migrate:remote
npm run deploy:all
```

Before the first production request, fill in the keys listed in
[`docs/PRODUCTION-KEYS.md`](docs/PRODUCTION-KEYS.md). Clerk and Mapbox values are
required; without them sign-in and the map stay dark.

```bash
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.vet.jsonc
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.admin.jsonc
npx wrangler secret put CLERK_SECRET_KEY  --config wrangler.voice.jsonc
npx wrangler secret put TWILIO_ACCOUNT_SID --config wrangler.voice.jsonc
npx wrangler secret put TWILIO_AUTH_TOKEN  --config wrangler.voice.jsonc
```

Every variable and secret, per Worker, is listed in
[`.env.example`](.env.example).

## Payments

A deposit is taken only after the customer selects one clinic offer. `DEMO_MODE`
is `"false"`, so the payment endpoint no longer simulates success — set the
Stripe keys, or set every tenant's `deposit_required` to `0`, before taking real
traffic.

## Validate

```bash
npm run check
```

Runs a repository-wide syntax pass, the platform validator (files, screens, D1
tables, API routes, Worker topology, the no-Clerk-component rule, and the pinned
map style), the native-client validator, and the Worker smoke, auth, and
end-to-end suites.

## Documents

- [`docs/PLATFORM-CONTRACT.md`](docs/PLATFORM-CONTRACT.md) — the cross-surface contract
- [`docs/PRODUCTION-KEYS.md`](docs/PRODUCTION-KEYS.md) — every key and dashboard setting still needed
- [`docs/NAVIGATION.md`](docs/NAVIGATION.md) — voices, instruction wording, CarPlay, Watch
- [`docs/MVP-ARCHITECTURE.md`](docs/MVP-ARCHITECTURE.md)
- [`docs/PAYMENTS-AND-TENANT-POLICIES.md`](docs/PAYMENTS-AND-TENANT-POLICIES.md)
- [`docs/INTEGRATION-COST-MATRIX.md`](docs/INTEGRATION-COST-MATRIX.md)
- [`docs/LEGAL-LAUNCH-CHECKLIST.md`](docs/LEGAL-LAUNCH-CHECKLIST.md)
- [`docs/UX-WIREFRAME.md`](docs/UX-WIREFRAME.md)
- [`docs/NATIVE-CLIENTS.md`](docs/NATIVE-CLIENTS.md)
