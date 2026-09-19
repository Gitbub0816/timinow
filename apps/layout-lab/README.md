# Layout Lab

An iPad sketchpad for Tími screen layouts. Drag components onto a canvas the
size of a real device, move and resize them, and export the result as JSON.

It is **separate from everything else in this repository on purpose**:

- No network, no API client, no Clerk, no Stripe, no Mapbox, no D1. It renders
  static shapes.
- No dependency on `apps/customer-mobile`. The Tími palette and the card
  treatment are *copied* into `Sources/LayoutLabKit/LabTheme.swift` rather than
  imported, because importing `TimiNowUI` would drag in the whole
  transpiled-for-Android dependency graph — including the Skip package
  identity conflicts documented in `docs/DEPENDENCY-CURRENCY.md` — in order to
  draw some rectangles. The cost is that the two can drift. That is the right
  trade for a sketchpad whose output is a text file.
- Its own bundle identifier (`solutions.clearkey.layoutlab`), so it installs
  alongside Tími rather than over it.

## Run it

```bash
./scripts/build-layout-lab.sh
./scripts/build-layout-lab.sh --device 'iPad Pro 13'
```

With no `--device` it takes the iPad simulator on the newest installed
runtime. `--device` is a case-insensitive substring, and a miss lists the
iPads you actually have rather than every destination Xcode knows about.

Or open it yourself:

```bash
cd apps/layout-lab/Darwin
xcodegen generate
open LayoutLab.xcodeproj
```

`xcodegen generate` is not optional and not a one-time step — the `.xcodeproj`
is generated from `Darwin/project.yml` and is git-ignored, so a fresh clone has
no project until you run it.

The icon is a flat drawing of the app's own subject — a canvas with a
component placed on it, in Tími's palette with the hard offset shadow. It
shares nothing with the Tími icon, so the two are told apart at a glance on a
home screen.

iPad only. The app is three panes side by side and a phone cannot give each of
them enough width to drag between, which is the only interaction it has.

## Two modes

**Components** is where you design. Three panes: the element tree, a live
preview at the component's real size, and every style property of whatever is
selected. A component is a tree of primitives — stack, box, text, icon,
spacer, divider, dot, bar — each with fill, border, corner radius, hard-offset
shadow, padding, spacing, alignment, fixed or flexible size, font size and
weight, tracking, line limit, rotation and opacity.

The seeded library is built from those same primitives. There is no privileged
set: open any component, take it apart, rebuild it. Switching a stack's axis
from row to column is how a tab bar becomes a side rail — same children, one
property.

**Screens** is where you place. Long-press a component in the library and drag
it onto the canvas, or tap to drop one in the middle.

## Edit once, everywhere

Screens hold *instances*, which point at components in a shared library. Edit
a component and every placement of it on every screen changes with it — there
is nothing to propagate by hand. A component that is currently placed cannot
be deleted; the app says how many times it is used instead of leaving
placements pointing at nothing.

Per placement you can still override the text, rotate it, lock it, or scale it
to its frame. Those are properties of the placement, not the component.

## Alignment

Select one thing and the align buttons work against the canvas. Select two or
more and they work **against each other**, on the bounding box of the
selection. Distribute needs three. Match size takes the largest, which is
almost always the one that was sized on purpose.

Dragging magnets to the edges and centres of everything else on the screen,
not only to the grid, and draws a coral guide where it caught.

## Reach, in millimetres

The first version of this app drew the thumb arc as a fraction of the screen.
That is simply wrong — a thumb is the same length whatever it is holding — and
it made a 13-inch canvas look as reachable as a phone.

The arc is now real millimetres converted to points through the device's
measured physical width, and **nothing is drawn at all when that measurement
is missing**. An arc with no basis is worse than no arc, because it gets
believed.

So measure it, which takes about ten seconds:

1. Turn on **Ruler**. A 50mm scale bar appears on the canvas.
2. Hold a real ruler against the iPad screen.
3. Adjust **MM W** in the toolbar until the bar measures 50mm.

Every reach figure becomes true at once. **Thumb mm** and **Stretch** are the
comfortable sweep and the furthest reach with the grip shifting; both are
settings rather than constants, because hands differ by more than designs
usually admit and the point is to test against a real one.

The device presets ship with their physical sizes at zero on purpose. Every
figure would have been recalled rather than measured, and a confidently wrong
millimetre value is exactly the mistake this replaces.

## Nothing is clipped

Components used to be cut through the middle of a word when they overflowed,
which reads as a rendering bug rather than as a layout that needs fixing.
Nothing is clipped now: text shrinks before it truncates and truncates before
it clips, and a component whose contents genuinely do not fit looks wrong in a
way you can act on.

## Export

The Export button shows the whole configuration as JSON — the component
library and the screens together, so a configuration is self-contained and
opens on another device with the components it needs. Copy it, share it, or
*Save to Files* (On My iPad → Layout Lab). The same sheet imports one back.

Frames are in **points**, origin top-left, in the canvas's own coordinates —
the same numbers a SwiftUI `.frame` and `.position` take.

## Deliberately absent

- **It does not generate Swift.** The export describes a layout; turning one
  into a view is a decision with taste in it, and a generator would produce
  code nobody wants to own. Read the JSON and build the layout by hand.
- **No undo.** Autosave plus Reset covers the common mistake. Real undo means a
  command stack, which is more machinery than a sketchpad earns — but this is
  the one on the list most likely to be worth adding next.
- **No nested components.** A component cannot contain another component, only
  primitives. Instances-inside-components is a real feature with real
  bookkeeping behind it, and the tool is useful without it.

If any of those start to hurt in practice, they are worth adding — but each is
a real feature, not an oversight.
