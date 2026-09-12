# Subprocessors and third-party hosts

This is the canonical, machine-checked list of every external service —
"subprocessor" in privacy-policy terms — that touches Tími data, plus every
third-party host any Tími page loads a script from, fetches from, or embeds a
frame from. It exists so a new integration cannot go live half-wired: added
here without also being added to the relevant Worker's Content-Security-Policy
(and, for a public API route, its CORS headers) is a state
`scripts/check-subprocessors.mjs` treats as a bug, and the reverse — a host
appearing in a CSP that isn't declared here — fails the same check.

**Process**: adding a new subprocessor, a new CDN-hosted script, or a new
page that calls one is a two-edit change, always in the same commit:

1. Add a row below (or extend an existing row's "Used by" column).
2. Add the host to the `CONTENT_SECURITY_POLICY` (and, if it's a new public
   API route a browser on another origin calls, the CORS headers) in every
   Worker's `src/index.js` that actually needs it.

Run `node scripts/check-subprocessors.mjs` (part of `npm run check`) to
verify the two stay in sync before pushing.

## Data subprocessors

Services that receive or process Tími customer, clinic, or payment data as
part of delivering the product. Each needs a data-processing agreement on
file before real (non-test) traffic flows through it — see
`docs/LEGAL-LAUNCH-CHECKLIST.md` for the current status of each.

| Subprocessor | What it processes | Data categories |
|---|---|---|
| Cloudflare (Workers, D1, KV, R2) | Hosting, application database, edge compute | All application data |
| Clerk | Authentication, session management | Account email/phone, auth metadata |
| Stripe | Payments, deposits, clinic payouts (Connect) | Payment method tokens, transaction records, bank details (clinics only) |
| Twilio | SMS and voice relay to clinics and pet owners | Phone numbers, call/SMS content |
| Didit | Identity verification (KYC) for clinic onboarding | Government ID images, verification result |
| Google (Gemini API) | Text-to-speech synthesis for voice navigation | Navigation prompt text (no PII by design) |
| MailerSend | Transactional email delivery | Email address, message content |

## Third-party hosts referenced in page code (CSP-relevant)

Every host below appears in at least one Worker's `content-security-policy`
header. "Directive" is the CSP bucket it must appear in; "Worker(s)" is
which `src/index.js` (or `apps/*/src/index.js`) declares it.

| Host | Directive | Purpose | Worker(s) |
|---|---|---|---|
| `https://js.stripe.com` | script-src, frame-src | Stripe.js (deposits, PCI SAQ-A) | customer |
| `https://hooks.stripe.com` | frame-src | Stripe 3DS/verification challenge frame | customer |
| `https://api.stripe.com` | connect-src | Stripe.js network calls | customer, admin |
| `https://connect.stripe.com` | frame-src | Stripe Connect embedded onboarding | admin |
| `https://cdn.jsdelivr.net` | script-src | Clerk JS (`@clerk/clerk-js`), Stripe Connect JS (`@stripe/connect-js`) | customer, vet, admin |
| `https://unpkg.com` | script-src | Didit identity verification web SDK | customer |
| `https://verification.didit.me` | connect-src, frame-src | Didit identity verification session | customer |
| `https://api.mapbox.com` | script-src, style-src, img-src, connect-src | Mapbox GL JS, tiles, geocoding, directions | customer, admin |
| `https://*.tiles.mapbox.com` | img-src | Mapbox raster/vector tiles | customer, admin |
| `https://events.mapbox.com` | connect-src | Mapbox GL JS telemetry | customer, admin |
| `https://clerk.timinow.pet` | connect-src | Clerk's custom Frontend API domain (`CLERK_ISSUER`) | customer, vet, admin |
| `https://timinow.pet` | script-src, connect-src | The customer Worker's own `/widget.js` and `/api/widget/:token/status`, embedded from the vet console's Widget Studio preview and the widget-demo gallery | vet, widget-demo |

Not in any CSP because it is never loaded by a browser page (server-to-server
only, called from Worker code, never from `public/*.js` or `apps/*/public/*.js`):
`api.clerk.com` (JWKS fetch in `src/auth.js`), `generativelanguage.googleapis.com`
(Gemini TTS, proxied through the voice-gateway Worker so the API key never
reaches a browser), `api.twilio.com`, Apple's APNs hosts.

## Widget embed (a special case)

`public/widget.js` is deliberately designed to be embedded on a clinic's own
website — a host this platform does not control and cannot enumerate in
advance. `GET /api/widget/:token/status` therefore answers with
`Access-Control-Allow-Origin: *` rather than a per-origin allowlist; that is
safe specifically because the response is built from an explicit public
whitelist that never carries clinic, customer, or financial data (see the
module comment in `src/widget.js`). The token itself, checked against each
widget token's own `allowed_origins_json`, is what gates *which* clinic's
data comes back — not the CORS header. A future public, cross-origin
embeddable endpoint should follow the same pattern: reason explicitly about
whether its payload is safe for `*`, and if not, echo back a validated
`Origin` instead of using a wildcard.
