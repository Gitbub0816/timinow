# Accessibility — audit findings, fixes, and conformance statement

This document records a WCAG 2.2 Level AA-oriented audit of every Tími
surface, what was fixed as part of that audit, and what is still open. It is
maintained as fixes land and gaps close — a stale accessibility statement is
worse than none, so treat "fixed" rows here as the ground truth for what
this codebase actually does today, not an aspiration.

**Conformance statement**: Tími is **partially conformant** with WCAG 2.2
Level AA. Partially conformant means some parts of the content do not fully
conform to the accessibility standard — the specific known exceptions are
listed under "Open items" below, by surface. This statement itself follows
the W3C's own conformance-claim format; it is not a legal certification, and
nothing here should be read as one (see the note on ADA/WCAG legal status
in `docs/LEGAL-LAUNCH-CHECKLIST.md` and the Accessibility Statement article
on the customer site).

## Cross-cutting fixes (applied to every surface that shared the pattern)

- **Contrast**: the same `#6F7483`/`#6D7487`-family mid-gray "muted" token
  was used for secondary/caption text across every surface, measuring as
  low as 3.9:1 on the light backgrounds it sat on — a WCAG 1.4.3 (Contrast
  Minimum, 4.5:1) failure. Darkened to `#5B6072` (or the surface's closest
  equivalent) in: `public/styles.css`, `apps/admin-console/public/styles.css`,
  `apps/vet-web/public/styles.css`, `public/widget.js` (cream variant),
  `apps/widget-demo/src/index.js`, the iOS app's `TimiColor.muted`
  (`apps/customer-mobile/Sources/TimiNowUI/Theme.swift`), vet-desktop's
  `TimiVetColor.muted` (`apps/vet-desktop/Sources/TimiVetUI/Theme.swift`),
  and vet-windows' `MutedColor` (`apps/vet-windows/src/TimiVet/Theme/Theme.xaml`).
  Also fixed: `.eyebrow`/`.eyebrow.coral` coral-on-white text in admin-console
  and vet-web measured ~3.2:1 — switched to `--coral-dark`, which measures
  ≥5.3:1.
- **A real color-token bug, not just a contrast tweak**: `public/styles.css`
  defined `--green`/`--green-soft` as byte-identical to `--blue`/`--blue-soft`
  (`#2357d9`/`#e5ecff`) — every "success" surface using that token (secure
  payment note, provider-success and Paw It Forward success cards) was
  rendering blue, not green. Fixed to a real green (`#12845d`/`#e9f7f1`,
  matching the green already used correctly on vet-web and admin-console).

## Customer web (`public/`)

**Fixed**: the `--green`/color-token bug and `--muted` contrast above.

**Open** (found, not yet fixed — tracked for a follow-up pass):
intake-step `aria-labelledby` pointing at an element that gets replaced
rather than updated on step change; an h1→h3 heading-level skip on the
vets-screen; unlabeled `<nav>` landmarks; icon-only "sketch" glyphs missing
`aria-hidden`; a maneuver-glyph region that behaves as a noisy live region;
form-error containers not linked to their fields via `aria-describedby`
(the containers are present and do carry visible text, but a screen-reader
user gets no automatic announcement or per-field association).

## Admin console

**Fixed**: `--muted` and `.eyebrow.coral` contrast; `scope="col"` added to
every `<th>` (9 tables); `aria-current="page"` on the active nav link;
the account-menu trigger's `aria-expanded` — previously set once in markup
and never updated by the open/close handler, so it permanently reported
"collapsed" to assistive tech — now toggles correctly, plus the dropdown
now closes on Escape and returns focus to the trigger; both modals
(`data-create-market-modal`, `data-action-modal`) now carry
`role="dialog" aria-modal="true" aria-labelledby="…"`, close on Escape,
and return focus to whatever triggered them (the action modal also
autofocuses its first field on open); the skip link (`.sr-only` previously
had no `:focus` override, so it never became visible when tabbed to) now
uses a dedicated `.skip-link:focus` rule; sign-in and form-error containers
now carry `role="alert"`.

**Open**: neither modal traps focus (Tab can still reach the page behind
it); the market-boundary polygon drawer (mapbox-gl-draw) has no keyboard
or text-based equivalent — only the circular fallback (center + radius)
is keyboard-operable; the geocoder result list has no
`role="listbox"`/arrow-key roving focus.

## Vet web

**Fixed**: the same `--muted`/`.eyebrow` contrast and `scope="col"` fixes
as admin-console; `aria-current="page"` on the active nav link; all 7
`<nav class="rail-nav">` instances now carry `aria-label`; the capacity
modal now moves focus into itself on open and returns it to the trigger on
close (it already closed on Escape and backdrop click); sign-in and
workstation-error text now carries `role="alert"`; the six Widget Studio
selection button groups (design, color variant, width, per-option
accent/corners/frame/shadow/scale/align, live-preview state, snippet
framework) now carry `aria-pressed`, reflecting selection to assistive
tech instead of relying on a CSS class alone; `.edit-link` and
`.sign-in-back` grew enough padding to clear the 24×24px minimum target
size (WCAG 2.2 SC 2.5.8).

**Open**: no focus trap in the capacity modal.

## Widget demo + the embeddable widget (`public/widget.js`, `apps/widget-demo`)

**Fixed** (in `public/widget.js`, which ships to every clinic's own site):
the `badge` and `ticker` designs built a real `<a>` (`powered()`) as a
child of another `<a>` — invalid HTML that drops the inner link's click
target in most browsers; both now use a new `poweredText()` span instead.
The cream variant's `--tw-muted` contrast fix (above). The mounted
widget's root now carries `role="status" aria-live="polite"` so its
periodic re-fetch-and-re-render announces itself, where before an
unattended background refresh was silent to screen-reader users (WCAG
4.1.3). The ticker's live-status pulse animation now respects
`prefers-reduced-motion`. `COPY.unavailable.word` changed from a bare
em dash (`—`, no semantic meaning on its own) to `"Unavailable"`.

**Fixed** (in `apps/widget-demo`): the gallery page's heading order was
h1 → h3 (design tiles) → h2 ("How a clinic gets one") — invalid; added a
real `<h2>Every design, live</h2>` before the design grid. State/variant/
accent/frame/elements filter chips now carry `aria-current="true"` on the
active choice. The fake decorative nav on the demo clinic page (already
`aria-hidden`) had its three `<a href="#">` links still keyboard-focusable
despite being hidden from assistive tech — added `tabindex="-1"`. Its own
`--muted` contrast and missing `x-frame-options`/`permissions-policy`
headers (present on every other Worker, absent here) are fixed above and
in the security-headers section of `docs/SOC2-READINESS.md`.

## iOS customer app (SwiftUI)

**Fixed**: `TimiColor.muted` contrast (above). Screen and element
transitions (`TimiMorph`, `TimiScreenChange` in `Components.swift`) did
not read `accessibilityReduceMotion` at all — the web app already handles
`prefers-reduced-motion` broadly, the iOS app did not. Added reduce-motion
-aware modifiers (`timiMorph`, `timiScreenTransition`) that fall back to a
quick crossfade, gated `#if !os(Android)` per this file's existing
Skip-bridging convention, and wired the new `.timiScreenTransition()`
modifier into all four of `CustomerRootView.swift`'s route-change call
sites (it previously called `.transition(TimiScreenChange.transition)`
directly, bypassing the new modifier). `TimiTabBar`'s tab buttons now
carry `.accessibilityAddTraits(.isSelected)` for the active tab.
`StaffingNotice`'s decorative stethoscope icon and `ErrorToast`'s warning
triangle are now `.accessibilityHidden(true)`; `ErrorToast`'s dismiss
button now has an accessible label. `TimiToggleRow` and the intake flow's
consent-checkbox row (`IntakeFlowView.acknowledgement`) were both built as
a plain `HStack` with `.onTapGesture` — VoiceOver and Switch Control
cannot reliably activate a bare tap gesture with no `Button` semantics.
Both are now real `Button`s exposed as one combined element via a new
shared `timiToggleAccessibility(label:isOn:)` modifier (name, on/off
value, and the button trait). This mattered most for the intake flow,
since those two rows are the legal-consent checkboxes.

## vet-desktop (macOS, SwiftUI) and vet-windows (WPF)

**Fixed**: the same `#6F7483`/`#6D7487`-family contrast bug, present
verbatim in both platforms' theme files (`TimiVetColor.muted` in
`Theme.swift`, `MutedColor` in `Theme.xaml`) — darkened to `#575D71`.
Icon-only buttons gained accessible names: the mini console's
minimize/hide buttons and the full console's capacity-sheet close button
(SwiftUI, `.accessibilityLabel`), and both `✕` glyph buttons in the WPF
mini window (`AutomationProperties.Name`).

**Open**: neither platform reads its OS's reduce-motion setting
(`accessibilityReduceMotion` / `SystemParameters.HighContrast`) despite
using spring/ease animations for window and button-press transitions. The
compact mini-console/mini-window pill conveys connection health (live /
demo / stale) by dot color alone, with no adjacent text — the full-window
status chip on both platforms already pairs color with text and is the
reference pattern to extend to the compact view. Both are real, scoped
gaps worth a dedicated pass rather than a one-line patch, and are recorded
here rather than papered over.

## What "AA" means here, precisely

This audit checked structure and code against WCAG 2.2 AA success criteria
(1.3.1, 1.4.1, 1.4.3, 1.4.10, 1.4.11, 2.3.3, 2.4.6, 2.5.8, 4.1.2, 4.1.3) by
reading markup, styles, and interaction code — it is not a substitute for
testing with real assistive technology (VoiceOver, NVDA/JAWS, Switch
Control) by people who use it daily, which is the only way to catch what
code review cannot. Treat this document as an engineering-side control, not
as the accessibility program's final word.
