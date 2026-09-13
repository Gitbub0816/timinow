# TímiNOW — Navigation asset family

Primitives only. No interchange artwork, no baked text, no raster, no light/dark pairs.
Every file paints in `currentColor`; state is a tint applied by the renderer.

## Structure
- `Maneuvers/` — 28 primitives, 120×120, 15pt shaft. Context roads are drawn at 0.32 opacity of the same tint.
- `Lanes/` — 14 indication primitives, 120×120, 13pt. One shared stem at (60,116)→(60,74); each indication is a branch from the junction point (60,74). Combine primitives by drawing several branches over one stem — never ship a combined file.
- `Junctions/` — 16 road primitives (roundabout exits are rim-anchored: they start at the junction point, arc the rim, and leave at the correct exit — never a free-floating ring), 640×300, junction point (320,262). Stroke width is set by roadClass: motorway 30, ramp 22, street 18. Active branch = cobalt, inactive = ink at 0.16.
- `RouteShields/` — plates only. Interstate comes in three colours: standard blue, business-loop green, and future/white.
  - `State/by-state/XX.svg` — all 50 states + D.C. Outline markers (AL, AR, FL, GA, ID, LA, MO, ND, NH, NV, NY, OH, OK, WI) are traced from real boundary geometry (us-atlas 3.0.1 / US Census TIGER, projected and simplified by `tools/state-paths.html`), not drawn by hand. The rest follow each state's real marker design and colours (CA green spade, PA keystone, MI/NC diamond, KS sunflower, NM zia, UT beehive, CO flag band, MN/SC blue, VT/SD green, WY yellow with horse, NV/VA/GA/ID black plates, DE/IA/KY/MS/NJ white circle on black, state-silhouette plates for AR/FL/GA/HI/ID/LA/MA/MO/ND/AK). Route numbers are never baked in.
  - `forest-route.svg` — brown national-forest plate.
  - `State/` (archetypes) — 50 states mapped to 10 plate archetypes; states sharing a plate share one file with combined initials (e.g. `state-diamond_MI-NC.svg`). `State/by-state/XX.svg` gives every state a direct alias so the renderer never needs the grouping table. Silhouette states (23 of them) use one abstracted plaque — TímiNOW explains the route rather than redrawing outlines.
  - `County/` — `county-pentagon_ALL.svg` (MUTCD blue/yellow, identical nationwide) plus `county-letter-square_WI-MI-MO.svg` for lettered county trunk routes.
- `Junctions/Roundabout/` — rims and rim-anchored exits for 3–9 legs (`rbt-6legs-exit-4.svg`). Geometry is angular: entry at bottom, exit k at k·360/legs, so any leg count is one formula, not new art.
- Arrival is a destination pin (amber in signal contexts, `currentColor` in the flat set); the on-map destination uses `Destination/destination-target.svg`.
- Lane guidance colour rule: lanes the driver should NOT take are grey (`--road`, 45% when the lane is unusable); lanes they SHOULD take carry the grey→amber signal gradient with an amber arrowhead. Cobalt is reserved for the route ribbon on the map. The renderer overlays `routeNumber` centred; interstate needs an 18% top offset for the red band, state route 10%. Exit numbers support up to 6 characters (e.g. 832A-C) — the badge is a text component, never artwork.
- `MapControls/` — 24×24, 2.3pt stroke.
- `Status/` — hazard / closure / signal / reroute. Coral and amber are literal here (semantic), not tint slots.
- `Destination/` — pin, course indicator, and `destination-target.svg` (on-map destination: cream disc + navy keyline + coral target, legible on both palettes). The flat `Maneuvers/arrive*.svg` target is for the maneuver card, where it takes the card's tint.
- `Maneuvers/signal/` — the same 28 maneuvers with the signal gradient baked in (grey tail → amber head) for the maneuver card; the flat `currentColor` versions remain the default.

## Lane states
| state | tint | opacity |
|---|---|---|
| inactive | ink | 0.26 |
| valid | ink | 0.95 |
| preferred | cobalt | 1.0 |

## Contract
```
JunctionGuidance { maneuver, distance, roadName,
  lanes[]    { indications[], isValid, isPreferred },
  branches[] { direction, isActiveRoute, roadClass },
  signs[]    { routeShield, routeNumber, direction, destinations[], exitNumber, isExitOnly } }
```
If new data requires new artwork, the design is wrong.
