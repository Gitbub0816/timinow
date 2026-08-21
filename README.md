# Tími NOW

Tími NOW is a real-time veterinary intake network. It answers **“Which veterinary hospital can take my pet right now?”** rather than offering future appointment scheduling.

The repository contains the complete Cloudflare MVP:

- Customer-only native SwiftUI iOS app with guided onboarding and Skip Fuse-ready shared modules
- Veterinary-team-only native Windows operations app with tray alerts and an always-on-top compact queue
- Customer-facing responsive PWA
- Non-diagnostic concern intake and emergency red-flag escalation
- Live hospital capacity search with freshness, source, and confidence
- Multi-clinic search fan-out to as many as 30 matching locations
- Up to five expiring clinic offers with customer comparison and selection
- Atomic confirmation of one clinic and automatic release of every other offer
- Arrival-request state machine and customer tracker after selection
- Clinic live-status console and availability-offer workflow
- Customer-supplied arrival, triage, and seen observations
- Tenant-versioned deposit policies
- Optional Stripe PaymentIntent collection after clinic acceptance
- Clerk organization tenancy scaffolded behind an exact runtime flag
- Cloudflare Worker, D1 migrations, Static Assets, scheduled expiry, and observability

The checked-in configuration deploys immediately in zero-configuration demo mode. Search, five-offer comparison, selection, tracking, simulated deposits, clinic status publishing, and clinic responses all work with fixtures and browser-local persistence. D1, Clerk, and Stripe are opt-in production upgrades.

## Product routes

- `/#home` — public explanation and safety boundaries
- `/#find` — concise two-step immediate-care intake
- `/#results` — nearby live intake capacity
- `/#tracker` — multi-clinic offer comparison followed by confirmation, payment, and milestones
- `/#pets` — portable pet-profile demonstration
- `/#clinic` — veterinary team operations console
- `/#sign-in` — Clerk sign-in surface, dormant by default

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Wrangler serves the Worker and static PWA with five East Bay demonstration clinics. No Cloudflare resources, IDs, accounts, or secrets are required for this mode.

## Deploy by connecting the repository to Cloudflare

The default `wrangler.jsonc` intentionally has no required bindings, so a first deployment cannot be blocked by an unconfigured D1, Clerk, or Stripe resource.

1. In Cloudflare, open **Workers & Pages** and choose **Create application**.
2. Choose **Import a repository**, authorize GitHub, and select this repository.
3. Keep the Worker name as `timinow` (it must match `wrangler.jsonc`).
4. Choose the branch to deploy. No build command or environment variables are required. The default deploy command, `npx wrangler deploy`, is sufficient.
5. Select **Save and Deploy**. The fixture-backed PWA will be live at the generated `workers.dev` address.

Future pushes to the selected production branch deploy automatically. Branch builds use Cloudflare preview versions.

## Authentication switch

Authentication is intentionally disabled in `wrangler.jsonc`:

```json
"SIGN_IN_REQUIRED": "false"
```

Sign-in activates only when its value is the exact string `"true"`. Before changing it, configure:

- `CLERK_PUBLISHABLE_KEY` as a non-secret Worker variable
- `CLERK_ISSUER` or `CLERK_JWKS_URL` as a Worker variable
- `AUTHORIZED_PARTIES` with comma-separated production origins
- Clerk organizations whose IDs map to `tenants.clerk_org_id`

The Worker verifies Clerk RS256 session tokens with Web Crypto. Clinic API access is tied to the active Clerk organization. Do not enable the flag with empty Clerk configuration.

## Payments

The MVP takes a deposit only after the customer selects one clinic offer. In demonstration mode, the payment endpoint records a simulated successful deposit. For Stripe:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

Set `STRIPE_PUBLISHABLE_KEY` in `wrangler.jsonc` or the Cloudflare dashboard and set `DEMO_MODE` to `"false"`. The frontend mounts Stripe Payment Element from the returned PaymentIntent client secret and the Worker verifies final state directly with Stripe.

## Create the production D1 database

```bash
npx wrangler d1 create timinow
cp wrangler.d1.example.jsonc wrangler.d1.jsonc
```

Replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` in the ignored `wrangler.d1.jsonc` file with the UUID returned by Cloudflare. Then apply migrations and run the database-backed app locally:

```bash
npm run db:migrate:remote
npm run dev:d1
```

For a database-backed Cloudflare Git deployment, add the same D1 binding in the Cloudflare dashboard or commit a real binding to `wrangler.jsonc` after the resource exists. Never commit secrets. Until then, the default deploy remains in safe demonstration mode.

## Validate and deploy

```bash
npm run check
npm run build
npm run deploy
```

No repository changes are automatically committed or pushed by these commands.

## Native clients

- [`apps/customer-mobile`](apps/customer-mobile) — iOS 17+ SwiftUI app, interactive demo mode, live Worker integration, deterministic concern-quality guard, and Skip Fuse module configuration
- [`apps/vet-windows`](apps/vet-windows) — .NET 8 WPF clinic console with capacity controls, request review, native alerts, tray behavior, and a draggable floating queue

Native platform builds run in [GitHub Actions](.github/workflows/native-clients.yml). See [`docs/NATIVE-CLIENTS.md`](docs/NATIVE-CLIENTS.md) for release boundaries and production configuration.

## Architecture and policy documents

- [`docs/MVP-ARCHITECTURE.md`](docs/MVP-ARCHITECTURE.md)
- [`docs/PAYMENTS-AND-TENANT-POLICIES.md`](docs/PAYMENTS-AND-TENANT-POLICIES.md)
- [`docs/INTEGRATION-COST-MATRIX.md`](docs/INTEGRATION-COST-MATRIX.md)
- [`docs/UX-WIREFRAME.md`](docs/UX-WIREFRAME.md)
- [`docs/NATIVE-CLIENTS.md`](docs/NATIVE-CLIENTS.md)
