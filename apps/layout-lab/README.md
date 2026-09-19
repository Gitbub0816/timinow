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
```

Or open it yourself:

```bash
cd apps/layout-lab/Darwin
xcodegen generate
open LayoutLab.xcodeproj
```

`xcodegen generate` is not optional and not a one-time step — the `.xcodeproj`
is generated from `Darwin/project.yml` and is git-ignored, so a fresh clone has
no project until you run it.

iPad only. The app is three panes side by side and a phone cannot give each of
them enough width to drag between, which is the only interaction it has.

## Using it

**Add** — tap a row in the left palette to drop one in the middle, or press
and hold it and drag it onto the canvas. (The press is deliberate: a plain drag
would win against the palette's own scrolling and make the list unscrollable.) Dropping outside the canvas cancels rather than placing the
component somewhere you cannot reach it again.

**Move and resize** — drag the component; drag the blue square at its
bottom-right corner to resize. Both snap to the grid while *Snap* is on. The
inspector on the right takes exact numbers when dragging is not precise enough.

**Reach overlay** — the dashed green arc is the comfortable thumb sweep for the
handedness selected in the toolbar. It is the reason this app exists: it is
there to make an unreachable control obvious while you are placing it, rather
than after the build. Turn it off with *Reach*.

**Screens** — tabs above the canvas. Tap the open tab to rename it, long-press
any tab to delete. Four are seeded from real Tími screens (Intake, Offers,
Tracker) plus a blank one, because a navigation idea is only judgeable against
something that looks like the thing it has to navigate.

**Canvas size** — presets in the toolbar, or type width and height directly.
The *Fold, open* preset is measured from a screenshot of the Duo simulator
(2000×1406 px halved for @2x), not from a spec sheet — which is exactly why
the field is editable. Correct it once the real figure is known.

**Export** — the Export button shows the whole configuration as JSON. Copy it,
share it, or *Save to Files*, which writes it into the app's Documents folder
where the Files app can see it (On My iPad → Layout Lab). The same sheet
imports a configuration back.

Work is autosaved to `Documents/layout-lab.json` on every change and restored
at launch. *Reset* puts the seeded screens back.

## The configuration format

```jsonc
{
  "version": 1,
  "exportedAt": "2026-09-19T18:20:00Z",
  "device": { "name": "iPad 11\" landscape", "width": 1194, "height": 834 },
  "handedness": "right",
  "gridStep": 8,
  "screens": [
    {
      "id": "…",
      "name": "Intake",
      "nodes": [
        { "id": "…", "kind": "topBar", "x": 0, "y": 0,
          "width": 1194, "height": 64, "label": "", "variant": 0, "locked": false }
      ]
    }
  ]
}
```

Frames are in **points**, origin top-left, in the canvas's own coordinates —
the same numbers a SwiftUI `.frame` and `.position` take, so the export reads
as instructions rather than as data needing a translation layer.

`kind` values are the vocabulary of the format. **Adding a case to `LabKind` is
safe; renaming one silently breaks every saved configuration**, because the raw
value is what the JSON stores.

## What is in the palette

45 components in six groups — 31 of them navigation, which is the point:

| Group | What is in it |
| --- | --- |
| Bars & rails | top bar, tab bar, tabs with a centre action, side rail, floating pill, toolbar, sidebar list |
| Moving between | back, breadcrumb, menu button, search, segmented, chip row |
| Where you are | progress dots, step bar, page dots, status strip |
| Thumb-first | Pilot, deck, board, radial dial, thumb arc, action rail, floating action, speed dial |
| Surfaces | bottom sheet, modal card, grabber, split divider, toast, drawer handle |
| Content | wordmark, headline, body, text field, primary and quiet buttons, species chips, offer card, clinic row, map, countdown, price row, legal notice, pet avatar |

Several have variants — the inspector shows a picker when a component has more
than one look.

## Deliberately absent

- **It does not generate Swift.** The export describes a layout; turning one
  into a view is a decision with taste in it, and a generator would produce
  code nobody wants to own. Read the JSON and build the layout by hand.
- **No undo.** Autosave plus Reset covers the common mistake. Real undo means a
  command stack, which is more machinery than a sketchpad earns.
- **No multi-select.** One component at a time.

If any of those start to hurt in practice, they are worth adding — but each is
a real feature, not an oversight.
