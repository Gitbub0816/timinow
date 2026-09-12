# CLAUDE.md — binding guidance for work on this repository

This file is loaded automatically at the start of every Claude Code session
in this repository. It exists so that the accessibility, security, legal,
and dependency-currency work done in the 2026-09 product-revision pass is a
floor this codebase never drops back below, not a one-time cleanup. Every
rule below states which file enforces it (a test, a script, a check) where
one exists — "enforced" means `npm run check` fails if the rule is broken,
"convention" means it depends on the next person (human or Claude) following
it.

## 1. Before you touch anything

Run `npm run check`. It runs, in order: `scripts/syntax.mjs` (parses every
JS file in every Worker and browser bundle), `scripts/check-subprocessors.mjs`
(Rule 3 below), `scripts/validate.mjs` and `scripts/validate-native.mjs`
(structural/cross-surface consistency, including the legal-text
cross-references described in Rule 4), then the full integration test suite
(`scripts/smoke.mjs` through `scripts/e2e.mjs`). It must pass before you
start and must pass again before you finish. A CI workflow
(`.github/workflows/check.yml`) now runs it on every pull request — but
don't rely on CI to catch what you could catch first.

## 2. Accessibility — WCAG 2.2 AA is the floor, not a project

Every surface in this repository (customer web, admin console, vet web, the
embeddable widget and its demo gallery, the iOS app, vet-desktop, and
vet-windows) was brought into closer conformance with WCAG 2.2 Level AA in
this pass — see `docs/ACCESSIBILITY.md` for exactly what was fixed, what
remains open per surface, and the conformance statement. When you add or
change UI on any surface:

- **Contrast**: text needs ≥4.5:1 against its background (≥3:1 for large
  text, 18pt+ or 14pt+ bold). The shared "muted" secondary-text color is
  `#5B6072` (iOS `TimiColor.muted`, vet-desktop `TimiVetColor.muted`,
  vet-windows `MutedColor`, and the `--muted` CSS custom property on every
  web surface) — it was chosen specifically because it clears 4.5:1 against
  every light background actually in use. Don't reintroduce the old
  `#6F7483`/`#6D7487` family; it was that shade precisely because nobody had
  checked it against a background before.
- **Real controls, not gestures**: a toggle, checkbox, or button-shaped
  element must be a real `Button` (SwiftUI), `<button>` (web), or
  `AutomationProperties`-labeled control (WPF) — never a bare
  `.onTapGesture`/`MouseLeftButtonDown` on a plain container. VoiceOver,
  Switch Control, and Windows UI Automation cannot reliably activate a
  gesture recognizer with no control semantics. `TimiToggleRow` and
  `IntakeFlowView.acknowledgement` (iOS) share a `timiToggleAccessibility`
  modifier for exactly this reason — reuse it or its pattern for the next
  tap-to-toggle row rather than reinventing an `.onTapGesture`.
  This matters most for consent/legal-acceptance controls specifically —
  those are the ones most likely to end up cited in a complaint.
- **Icon-only controls need an accessible name** (`.accessibilityLabel` in
  SwiftUI, `aria-label` on the web, `AutomationProperties.Name` in WPF).
  Decorative icons that sit next to their own text label need the opposite —
  `.accessibilityHidden(true)` / `aria-hidden="true"` — so a screen reader
  doesn't announce the same thing twice.
- **Motion**: gate non-essential transitions behind
  `@Environment(\.accessibilityReduceMotion)` (SwiftUI, `#if !os(Android)`
  per this codebase's Skip-bridging convention — see `Components.swift`) or
  `prefers-reduced-motion` (CSS). Every web surface already has a broad
  reduced-motion rule; a new animation needs to respect it, not add a
  parallel one that doesn't.
- **Modals**: `role="dialog" aria-modal="true" aria-labelledby="…"`, close on
  Escape, close on backdrop click, move focus in on open and back to the
  trigger on close. See `openActionModal`/`closeActionModal`
  (admin-console) or `openCapacityModal`/`closeCapacityModal` (vet-web) for
  the reference pattern.
- **Tables**: every `<th>` needs `scope="col"` (or `scope="row"` where
  applicable).
- Update `docs/ACCESSIBILITY.md` when you close one of its open items or
  introduce a new pattern worth documenting. A stale accessibility statement
  is worse than an honest "partially conformant" one.

## 3. Security: CORS, CSP, and subprocessors move together — enforced

Every Worker (`src/index.js`, `apps/vet-web/src/index.js`,
`apps/admin-console/src/index.js`, `apps/voice-gateway/src/index.js`,
`apps/widget-demo/src/index.js`) declares a `content-security-policy` (or,
for `voice-gateway`, an intentionally locked-down `default-src 'none'`
since it serves no HTML). `docs/SUBPROCESSORS.md` is the canonical list of
every external host any of those policies references, and
**`scripts/check-subprocessors.mjs` fails `npm run check` if the two ever
drift** — a host in a CSP that isn't documented, or a documented host no
CSP references, is a build failure, not a warning.

**The rule this exists to enforce**: adding a new subprocessor, a new
CDN-hosted script, or a new page that calls a new external host is always a
two-edit change, in the same commit:

1. Add the host to `docs/SUBPROCESSORS.md` (which table depends on whether
   it's a data subprocessor, a script/CSP host, or both).
2. Add it to the `CONTENT_SECURITY_POLICY` constant in every Worker's
   `src/index.js` that actually needs it.

If the new page or endpoint is called cross-origin by a browser on another
site (like `public/widget.js`'s embed on a clinic's own website), it also
needs a deliberate CORS decision — see `src/widget.js`'s
`WIDGET_STATUS_CORS` and the comment above it for the reasoning behind using
a wildcard `Access-Control-Allow-Origin` specifically (safe only because
that endpoint's response is built from an explicit, non-sensitive public
whitelist — read that comment before copying the pattern to an endpoint
that returns anything else). Do not add a wildcard CORS header to an
endpoint that returns clinic, customer, or financial data.

Never remove or weaken `SECURITY_HEADERS` on a Worker without adding an
equivalent protection — `x-frame-options`, `x-content-type-options`,
`referrer-policy`, and `permissions-policy` are the floor on every Worker
that serves HTML.

## 4. Legal text: verbose legal prose, checked against real law, version-bumped

The legal notices at `public/index.html#legal` (and the mirrored `#clinics`
article in `apps/vet-web/public/index.html`) are drafted as formal legal
prose — defined terms, numbered sections, standard boilerplate — deliberately
checked against real statutory frameworks: the CCPA/CPRA (Cal. Civ. Code
§1798.100 et seq.) for the Privacy Policy's structure and enumerated
consumer rights, California's veterinary practice act for the technician
scope-of-practice notice, and California's charitable-solicitation law
(Cal. Gov. Code §12580 et seq.) for why the Paw It Forward Fund is drafted
as a discretionary corporate assistance program rather than anything
resembling a charity. **This is not a substitute for a licensed attorney's
review** — the Paw It Forward article carries an HTML comment flagging the
specific open question (charitable-solicitation registration exposure) for
counsel, and no arbitration or class-action-waiver clause has been added,
also deliberately, pending that same review. Do not add one without an
attorney's sign-off; it materially changes user rights and its
enforceability varies sharply by state.

If you change the substance of any legal article: bump `LEGAL_VERSION` in
`src/catalog.js` **and** `TimiLegal.version` in
`apps/customer-mobile/Sources/TimiNowCore/APIClient.swift` together — they
must match, and `scripts/validate-native.mjs` enforces that they do, and
that the two apps' embedded legal-notice text (`SupportViews.swift`) and
the web copy still share their key phrases (the veterinary-technician
notice, the medications/allergies notice, the emergency-listings notice).
A version bump forces re-acceptance on the next intake — that is the
"material changes... presented for renewed acceptance" promise the Terms
themselves make, and it is not optional when you change what they say.

## 5. SOC 2 posture: build the control, don't claim the certificate

`docs/SOC2-READINESS.md` maps this codebase's actual controls to the AICPA
Trust Services Criteria and lists real gaps (no CI enforcement existed until
this pass; no incident-response runbook; outstanding subprocessor DPAs).
**SOC 2 is an audit opinion issued by a licensed CPA firm, not something a
codebase achieves.** Never describe this product as "SOC 2 compliant,"
"SOC 2 certified," or similar in code, comments, marketing copy, or
customer-facing text unless an actual auditor's report exists and is being
accurately characterized (Type I vs. Type II, which criteria were in
scope). When you add a control that closes one of that document's gaps,
update it — that document's value is in staying accurate, not in staying
impressive.

## 6. Dependency currency

`docs/DEPENDENCY-CURRENCY.md` records what was bumped in the 2026-09 pass
and what was deliberately deferred, with reasons (mostly: this environment
cannot browser-test a major-version auth SDK bump or rebuild the iOS app,
so those are left for whoever has that tooling). `.github/dependabot.yml`
keeps `npm` dependencies current going forward automatically. When you add
a new CDN-hosted script:

- **Pin an exact version** unless the vendor's own documented best practice
  is to float (Stripe.js's `js.stripe.com/v3` is the one deliberate
  exception in this codebase — it's Stripe's own PCI SAQ-A requirement,
  don't "fix" it by pinning or self-hosting it).
- A floating major-version CDN tag (like Clerk's `@5` via jsdelivr) is an
  acceptable middle ground for a well-audited vendor SDK, but a bare,
  version-less URL (what `@didit-protocol/sdk-web` was before this pass) is
  a real supply-chain gap, not just staleness — it means whatever the
  package's latest published version is at fetch time runs in production
  with no review. Never add one.
- Add the new host to `docs/SUBPROCESSORS.md` and the relevant CSP per
  Rule 3 — this is the same two-edit change either way.

## 7. Design system reference

The product's visual language, referenced throughout the code comments
rather than restated here: **paper** (`#FFFAF0`) and **canvas**
(`#F3F5FA`/`#F3F5FB`) as the two light backgrounds, **ink** (near-black,
`#111B3B` on most surfaces) for primary text and 2px borders, **coral**
(`#F25F4C`/`#F65F50`) as the primary action color, **blue** (`#2357D9`) as
the secondary/link color, **gold** (`#F7C84B`) for warnings and highlights,
and **green** (`#12845D`) for success/positive states specifically — not
blue, which was a real bug this pass fixed (`public/styles.css`'s
`--green`/`--green-soft` had been copy-pasted from `--blue`/`--blue-soft`
and every "success" surface using it was rendering blue). Hard 2px ink
borders with an offset drop shadow (`box-shadow: Npx Npx 0 var(--ink)`,
no blur) are the signature card/button treatment across every surface —
don't introduce a soft-shadow, blurred, or borderless variant as a
one-off; if a screen needs a different treatment, it needs a design
decision, not a local override.

## 8. Avoid generic "vibe-coded" AI-app tells

This product's visual identity (Section 7) exists specifically so it never
reads as an interchangeable AI-generated SaaS template. A 2026-09 audit
checked for, and found and fixed, the concrete tells listed below; treat
this as a standing checklist for new UI, not a one-time cleanup:

- **No indigo/violet/purple gradients.** The generic "AI startup" palette
  (`#6366f1`/`#8b5cf6`-family gradients, usually diagonal, usually behind a
  hero headline) has never appeared in this codebase and must not start
  now. This product's palette is coral/blue/gold/ink — see Section 7 — full
  stop.
- **No glassmorphism as a default.** `backdrop-filter: blur()` appears in
  exactly two deliberate, restrained places (the sticky header on scroll,
  a modal's backdrop dimming) — it is not this product's aesthetic and
  must not spread to cards, panels, or buttons as a generic "modern" effect.
- **No soft, blurred box-shadows.** Every shadow in this codebase has zero
  blur radius and a hard offset (`Npx Npx 0 color`) — that's Section 7's
  signature treatment. A Tailwind-default soft shadow
  (`0 4px 6px rgba(0,0,0,.1)`-shaped) is the single most common "vibe-coded"
  tell and does not belong here.
- **No emoji as icon substitutes in visible copy.** An emoji standing in
  for an icon in body text or a button label (a "🔒 Secure checkout"-style
  trust badge, an "✏️ Edit" button prefix) was a real bug this pass fixed
  (`public/index.html`'s payment and pay-nothing notices, an admin-console
  button) — plain text alone, or this codebase's own typographic
  "sketch-icon" glyph system (`?`, `⌁`, `✓`, `✎`, `☎`, `$` — monochrome
  dingbats, not full-color emoji, always styled by `color` not rendered as
  a platform emoji), is the standard. The one deliberate exception is
  `SPECIES_EMOJI` in `public/app.js` (🐶🐱🐦🐰🦎🐹🐾 as a pet-profile
  fallback avatar) — contextually appropriate for a pet-care product's
  actual subject matter, not decoration, and not a precedent for using
  emoji elsewhere.
- **No generic CDN icon library.** No Font Awesome, Heroicons, Feather, or
  Material Icons import exists in this codebase, and none should be added
  for "a few icons" — this product's icons are either the typographic
  sketch-icon glyphs above or purpose-drawn inline SVGs (see the vet-web
  nav icons for the pattern: `aria-hidden="true"`, `currentColor` stroke,
  paired with visible text).
- **No AI-marketing cliché copy.** Words like "seamless," "effortless,"
  "revolutionize," "game-changer," "cutting-edge," "supercharge," "unlock
  your," "all-in-one," "next-generation," or "unleash" have never appeared
  in this product's copy and shouldn't start — every surface's copy is
  written specific to what it actually does (see any existing headline for
  the register: concrete, slightly wry, never generic).
- **Watch inline-style sprawl.** `apps/admin-console/public/app.js` and
  `apps/vet-web/public/app.js` carry a real number of one-off
  `style="…"` attributes in dynamically-generated HTML — mostly small,
  consistent utility tweaks (`margin`, `font-size`), not visual chaos, but
  worth converging into shared CSS classes when you're already touching a
  block that has several, rather than adding another one-off.
