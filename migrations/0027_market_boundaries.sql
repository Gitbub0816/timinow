PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════ Drawn market boundaries ═════════════
--
-- Migration 0024 deliberately made a market a circle — a center and a
-- radius — because that was the same geometric question searches already
-- answered. Real markets are not circles: the East Bay stops at the water,
-- Denver Metro follows the front range, and a circle wide enough to reach
-- one edge overshoots every other. The platform console now draws
-- territories on a map, so a market can carry a hand-drawn polygon.
--
-- `boundary_kind` says which shape answers "is this point in this market":
--   circle  — center_latitude/center_longitude/radius_km, as before. Every
--             existing row lands here via the DEFAULT, and nothing changes
--             for it.
--   polygon — `boundary_geojson` holds a GeoJSON geometry object (a
--             stringified Polygon or MultiPolygon, WGS84 lng/lat order,
--             validated and size-capped in src/markets.js before it is
--             written). D1 has no spatial type, so TEXT plus an app-side
--             even-odd containment test (src/markets.js marketContains) is
--             the whole implementation.
--
-- The circle columns are NOT dropped for polygon markets: the center stays
-- meaningful as the map's fly-to anchor and the distance tiebreaker when two
-- markets overlap, and the radius remains the fallback if the stored
-- geometry ever fails to parse.
--
-- Historical attribution stays frozen by design (same policy as 0024):
-- care_searches.market_id and locations.market_id are stamped at write time,
-- so redrawing a boundary changes future attribution only.

ALTER TABLE markets ADD COLUMN boundary_kind TEXT NOT NULL DEFAULT 'circle'
  CHECK (boundary_kind IN ('circle', 'polygon'));
ALTER TABLE markets ADD COLUMN boundary_geojson TEXT;
