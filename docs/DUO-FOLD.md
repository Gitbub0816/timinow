# The fold surface — state, map, and what happens next

**Read this before touching anything under `apps/customer-mobile/Sources/TimiNowUI/Duo*.swift`.**
It is the handoff for whoever picks the fold app up next, and it stays accurate
afterwards as the map of that surface. `CLAUDE.md` still binds — this does not
replace any rule there, it only says where the fold work stands.

---

## 1. Where this stands

The fold app is **built and it compiles, and the owner has rejected the UX.**
That is the honest summary. Everything below the interaction model is scaffolding
the owner intends to redesign in Sketch and then hand-edit in Swift, so treat
the current screens as a working skeleton, not a finished design.

What is settled and should not be quietly undone:

- **Onboarding runs before sign-in**, on the fold exactly as on the phone. A
  stranger is asked their pet's name, not their email address. This was removed
  once and restored; see the comment on `DuoRootView.needsOnboarding`.
- **The menu rail is on the *near* edge**, with the wheel. Putting it on the far
  edge put the one control that moves between sections outside thumb reach.
- **The wheel is on every screen**, onboarding included. Hiding it there made the
  fold app look like it had no navigation at all.
- **A group with one action gets no wheel** — `DuoWheel.soloAction`. A wheel that
  cannot turn is a control that lies about what it does.
- **Clinic identities stay masked until an offer is selected.**
  `DuoContent.maskedName` mirrors `OfferCard.clinic`. Do not widen it.

What is explicitly open:

- The whole visual design of the stage and the wheel. The owner is redesigning
  this in Sketch (local MCP server, `http://localhost:31126/mcp` — reachable only
  from a Claude Code session running on their Mac, never from a cloud session).
- Whether the three-windows-on-an-arc shape survives at all. If it does not, see
  §6 about the geometry check.

---

## 2. Running it

From any directory in the checkout:

```
npm run xcode                        # generate the project, open it in Xcode
npm run ios -- --device 'iPhone Duo' # build and run on the simulator
```

`npm run ios` creates the Duo simulator if none exists, resolves it by udid
rather than by name, and never fails at the last line over a Simulator window.

**`TIMI_DUO=1`** in the scheme's environment forces the fold layout on and skips
the sign-in gate, so the wheel can be worked on in an iPad simulator with no fold
hardware and no live code. It grants nothing — the store still has no token, so
every authenticated call fails exactly as it should, and an environment variable
can only be set by whoever launches the process.

---

## 3. The interaction model

There is no hierarchy, no back stack and no tab bar.

Everything the unfolded app can do is a **group**; every group is a short list of
**actions**. At any moment you are in one group, one action in it has focus, and
pressing the hub takes that action.

| Gesture | Effect |
|---|---|
| Drag on the track or the windows | Scroll the list through the focus window |
| Drag vertically starting on the hub | Change which question is being asked |
| Tap the hub | Commit the focused action |

The three are told apart by **where the drag starts**: within `hubRadius` of the
pivot it is a group change, anywhere else it is a turn. Scrolling is *relative* —
the thumb's travel advances the list, one window of arc per item — because a
viewport of three cannot map a ten-item group onto the arc.

A phone app navigates by moving the screen. This one navigates by moving focus,
because the hand cannot move but the thumb can turn. That is the whole idea; if a
redesign keeps nothing else, keep that.

---

## 4. File map

All under `apps/customer-mobile/Sources/TimiNowUI/`.

| File | What it owns |
|---|---|
| `DuoNavigator.swift` | The model. `DuoAction`, `DuoGroup` (`.menu`/`.choice`/`.single`), `DuoNavigator` (focus, group index, committed answers), and `DuoContent` — every group the app can show, per section. |
| `DuoRootView.swift` | Layout. `DuoLayout.forced`, the onboarding/auth gates, the panels, menu rail placement, handedness, and `take(_:)` which turns a committed action into a store mutation. |
| `DuoStage.swift` | Everything that is not the wheel: answered chips, the focused answer, the safety notice, and `DuoMenuBar`. |
| `DuoWheel.swift` | The control. Geometry constants, the track, the hub button, the gestures, and `DuoWindow`. |
| `DuoAuthStage.swift` | Fold-native identifier and code entry; falls back to `SignInView` for the stages that are genuinely forms. |
| `DuoHinge.swift` | Where the crease physically is, via `reservedRegions(kind: .division)`. Returns CGFloat/Bool only — see §7. |
| `CustomerRootView.swift` | The gate that chooses the fold app at all: `horizontalSizeClass == .regular && verticalSizeClass == .regular`, checked **before** the sign-in branch. |

---

## 5. Every number, and where it is

| What | Where |
|---|---|
| Box, pivot inset, radius, step, focus angle, hub radius | `DuoWheel.swift`, the `Geometry` block near the top |
| Focus vs. peek window sizes | `DuoWheel.swift`, `DuoWindow`'s `.frame(width:height:)` |
| Track extent | `DuoWheel.trackStart` / `trackEnd` — clamped to the real list, so a group of two does not draw travel it does not have |
| Wheel position on screen, menu rail width, stage inset | `DuoRootView.swift`, `menuRailWidth` / `wheelEdgeInset` / `wheelRoom` |
| Colours, shadows, borders | `Theme.swift` (`TimiColor`), used per CLAUDE.md §7 — 2px ink borders, zero-blur offset shadows |

The wheel's constants were settled by rendering the layout at 2× in a browser,
measuring it, and solving for gaps — not by eye. Three earlier versions shipped
with the focus window and the hub overlapping, because SwiftUI draws an overlap
without complaining and clips an overflow without complaining.

---

## 6. The checks that will push back

`npm run check` runs these, among others:

- **`scripts/duo-wheel-geometry.mjs`** parses the constants back out of
  `DuoWheel.swift` and re-derives the layout. It fails the build if a window
  leaves the box, two windows come within 6pt, or the hub clears a window by
  less than 12pt. It parses the source rather than restating the numbers, so it
  cannot drift into confirming its own arithmetic.

  **It assumes three windows on an arc around a pivot.** If a redesign changes
  that shape, this check is wrong and will block correct work — rewrite it
  against the new shape or relax it deliberately. Do not weaken it to get a red
  build green while the shape is unchanged; that is the failure it exists to
  catch.

- **`scripts/swift-parse.mjs`** runs `swiftc -parse` over every Swift source.
  Syntax only — it resolves no modules and checks no types, so it runs anywhere a
  toolchain does, and says so and passes where none exists. It is the cheap half
  of a build, not a substitute for one.

- **`scripts/validate-native.mjs`** carries rules learned from real compile
  failures here: `@Observable` without a `SkipFuse`/`SkipFuseUI` import, CG types
  in a declaration in a transpiled file, and ternaries of bare numeric literals
  handed to overloaded modifiers.

---

## 7. Skip constraints that have already cost time

This target is transpiled to Kotlin by Skip. These are not style preferences:

- **`CGRect` and `CGSize` cannot appear in any declaration in a transpiled
  file** — public or not, because the transpiler reads the whole file. Keep them
  inside function bodies guarded by `#if os(iOS) && !SKIP` and return CGFloat or
  Bool. `func path(in rect: CGRect)` on a `Shape` is the one exemption.
- **`@Observable` files need `import SkipFuse` / `SkipFuseUI`** under
  `#if os(Android)`.
- **A ternary of bare numeric literals** handed to an overloaded modifier
  (`.frame`, `.padding`) is ambiguous — wrap it: `CGFloat(focused ? 5 : 3)`.
- **`Double?` does not bridge to `CGFloat?` through `Optional`** — map it.
- **A `some View` property whose call site ends a `body`** with nothing
  downstream can produce a Skip "unable to match" warning; a concrete
  `ModifiedContent<…>` return type fixes it. `timiCard` in `Theme.swift` is the
  worked example.

---

## 8. Known-open, not fold-specific

- **Clerk rejects phone identifiers** ("Identifier is invalid." for a correctly
  normalised `+1…`). `AuthController.normalizeIdentifier` is right; Phone is not
  enabled on the Clerk instance. Instance configuration, not code.
- **TestFlight** is blocked on the App Store Connect Issuer ID.
- **`.button-primary`** white-on-coral measures 3.22:1 and fails 4.5:1.
  `--coral-dark` `#BD3E31` would give 5.39:1. A brand decision, not a bug fix.
