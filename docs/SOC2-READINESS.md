# SOC 2 readiness — control mapping and gap list

**What this document is, and is not.** SOC 2 is not a certification a
company can "achieve" by writing code or documentation. It is an audit
opinion — a Type I (design, as of a point in time) or Type II (design and
operating effectiveness, over a review period, typically 3–12 months) report
— issued only by an independent, licensed CPA firm after they test the
company's controls against the AICPA's Trust Services Criteria (TSC). This
document maps Tími's actual, current engineering controls to those criteria
and lists what is missing, so that when the company is ready to engage an
auditor, the gap between "what we do" and "what we can prove we do" is
already small and already written down. It is a readiness document, not an
attestation, and nothing in it should be represented to a customer,
investor, or prospective clinic as SOC 2 compliance, certification, or
attestation until an actual auditor's report exists.

The **Security** criterion (the "Common Criteria") is mandatory for any SOC 2
report. **Availability**, **Processing Integrity**, **Confidentiality**, and
**Privacy** are optional, added only where relevant to the service. Given
Tími processes payment data, health-adjacent pet information, and operates
a real-time intake service clinics depend on, the criteria most likely to
matter for an eventual audit scope are Security, Availability, and
Confidentiality — **Privacy** is arguably the wrong category to add on top
of the CCPA-driven privacy program already documented in the customer-facing
Privacy Policy, since SOC 2 Privacy overlaps with, but does not replace,
statutory privacy compliance.

## Common Criteria (CC) — Security

### CC1 — Control environment

| Control | Status |
|---|---|
| Documented security policy binding engineering work | **Present** — `CLAUDE.md` (repository root) is the binding policy for all future code changes: it requires new CORS/CSP entries with every new subprocessor or page (enforced by `scripts/check-subprocessors.mjs`), current-version dependencies, and accessibility conformance. |
| Assigned responsibility for security decisions | **Gap** — no named security owner or escalation path is documented outside this repository. A real audit will ask "who decides" and "who is on call," not just "what does the code do." |
| Background checks / access provisioning for personnel | **Gap / out of scope for code** — this is an HR and IT-admin control, not something a codebase can demonstrate. |

### CC2 — Communication and information

| Control | Status |
|---|---|
| System description (what the service does, its boundaries) | **Present**, distributed across `docs/MVP-ARCHITECTURE.md`, `docs/PLATFORM-CONTRACT.md`, and `docs/SUBPROCESSORS.md`. A real audit package consolidates these into one "System Description" document — not yet done. |
| Subprocessor disclosure | **Present** — `docs/SUBPROCESSORS.md`, kept in sync with actual CSP/CORS configuration by `scripts/check-subprocessors.mjs`, which fails `npm run check` on drift. |

### CC3 — Risk assessment

| Control | Status |
|---|---|
| Documented risk assessment process | **Gap** — no formal, recurring risk-assessment artifact exists. `docs/GO-TO-PROD.md` and `docs/LEGAL-LAUNCH-CHECKLIST.md` capture point-in-time gap analyses but are not a recurring risk-assessment cadence. |

### CC5 — Control activities

| Control | Status |
|---|---|
| Change management (review before deploy) | **Partial** — `npm run check` (syntax, subprocessor sync, smoke tests, integration tests) runs before every deploy script (`npm run deploy*`) is meant to be invoked, but nothing in this repository *enforces* that check runs before a deploy; there is no CI pipeline configuration checked into this repository. **This is the single highest-leverage gap**: a CI workflow that runs `npm run check` on every pull request and blocks merge on failure converts every control below from "the engineer is supposed to" into "the pipeline verifies." |

### CC6 — Logical and physical access controls

| Control | Status |
|---|---|
| Authentication | **Present** — Clerk-based session auth on every non-public route (`src/auth.js`), JWT validation against a derived JWKS URL, `AUTHORIZED_PARTIES` origin/`azp` validation. |
| Authorization / least privilege | **Present** — `isOrgAdmin` gates and clinic/tenant-scoped queries throughout `src/*.js`; workspace administrator vs. member roles enforced server-side, not just hidden in the UI. |
| Encryption in transit | **Present** — Cloudflare Workers serve HTTPS only; `normalizeOrigin` in `src/widget.js` explicitly rejects non-`https://` widget origins. |
| Encryption at rest | **Inherited from Cloudflare D1/KV/R2** — not independently configured by this codebase; an auditor will ask for Cloudflare's own SOC 2 report as a subservice-organization control, which is the normal pattern (a "carve-out" or "inclusive" method report). |
| Network security headers | **Present, as of this audit** — every Worker now sends `content-security-policy`, `x-frame-options`, `x-content-type-options`, `referrer-policy`, and `permissions-policy` (see `docs/SUBPROCESSORS.md` for the CSP host allowlist and the rationale for `widget.js`'s intentionally permissive CORS on its one public, non-sensitive endpoint). Previously, `apps/widget-demo` and `apps/voice-gateway` were missing headers other Workers already had; this is now consistent across all five Workers. |
| Secrets management | **Present** — Worker secrets (`CLERK_SECRET_KEY`, Stripe keys, etc.) are set via `wrangler secret`, never committed; `docs/PRODUCTION-KEYS.md` and `docs/PRODUCTION-SETUP.md` document the process. |
| Credential hashing | **Present** — widget tokens are SHA-256 hashed at rest (`src/widget.js`); only the hash is persisted. |

### CC7 — System operations

| Control | Status |
|---|---|
| Logging | **Partial** — structured JSON logs exist throughout (`console.log`/`console.warn` with `event` fields) and are visible in Cloudflare's dashboard, but there is no documented log-retention policy, no centralized log aggregation/alerting service configured in this repository, and no documented incident-response runbook. |
| Monitoring / alerting | **Gap** — no alerting configuration (e.g., Cloudflare notifications, a status-page integration, or an on-call rotation) is present in this repository. |
| Backup and recovery | **Gap** — D1's point-in-time recovery is a Cloudflare platform feature, not something this codebase configures or tests; no documented recovery-time/recovery-point objective exists. |

### CC8 — Change management

| Control | Status |
|---|---|
| Version control | **Present** — git, with descriptive commit history. |
| Automated testing before deploy | **Present, but not enforced** — see CC5 above; the tests exist (`npm run check`, `npm run smoke`) but nothing blocks a deploy that skips them. |

### CC9 — Risk mitigation (vendor management)

| Control | Status |
|---|---|
| Subprocessor inventory | **Present** — `docs/SUBPROCESSORS.md`. |
| Data processing agreements with subprocessors | **Gap, already flagged** in `docs/LEGAL-LAUNCH-CHECKLIST.md` — DPAs with Cloudflare, Clerk, Stripe, Twilio, Didit, Google (Gemini), and MailerSend need to be executed (most are available as clickthrough or self-serve DPAs from each vendor) before this can be marked closed. |

## Availability

| Control | Status |
|---|---|
| Redundancy / multi-region | **Inherited from Cloudflare's edge network** — Workers run at every Cloudflare PoP by default; this is a genuine strength for an Availability-scoped report, but it is Cloudflare's control, evidenced by Cloudflare's own SOC 2 report, not something this codebase implements. |
| Capacity planning | **Gap** — no documented capacity/load-testing process. |
| Documented uptime SLA / incident communication | **Gap** — no status page or SLA is published. |

## Confidentiality

| Control | Status |
|---|---|
| Data classification | **Partial** — the codebase's own comments consistently distinguish "public whitelist" data (e.g., `src/widget.js`'s `buildStatusPayload`) from sensitive data, which is good practice, but there is no standalone data-classification policy document. |
| Confidentiality commitments in contracts | **Gap** — clinic and subprocessor agreements are referenced (`docs/LEGAL-LAUNCH-CHECKLIST.md`) but confidentiality-specific clauses have not been independently reviewed for SOC 2 purposes. |

## What actually moves the needle before engaging an auditor

In priority order:

1. **Stand up CI** (GitHub Actions or equivalent) that runs `npm run check` on every pull request and blocks merge on failure. Nothing else in this list matters if a control can be silently skipped.
2. **Execute the outstanding subprocessor DPAs** listed in `docs/LEGAL-LAUNCH-CHECKLIST.md`.
3. **Write an incident-response runbook** and a log-retention policy, even a short one — auditors ask for the document, then ask for evidence it was followed.
4. **Name a security owner** and document an escalation path.
5. **Only then** engage a licensed CPA firm for a Type I report (design-only, faster and cheaper) as a first milestone, with Type II (operating effectiveness over time) as the target once the Type I findings are closed.

Nothing above should be read as legal or audit advice; engage a CPA firm
that performs SOC 2 examinations, and counsel, before representing any
compliance status externally.
