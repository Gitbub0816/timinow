-- A live arrival estimate, so the clinic can see how far away a patient is.
--
-- The console already knew a `travel_minutes` figure, but that is the estimate
-- made once when the offer was quoted: it never moves, so twenty minutes after
-- someone set off it still says whatever it said before they left. A team
-- deciding whether to prepare a room needs the number that changes when the
-- driver misses a turn.
--
-- Deliberately an estimate and not a position. The customer's app already has
-- a live route from Mapbox while it is navigating, and reporting the seconds
-- remaining off that route tells the clinic everything it needs without this
-- table ever holding a trail of where a person actually is. Where somebody is
-- driving is not the clinic's business; when they will arrive is.
--
-- Stored as the raw report rather than a computed arrival time so the freshness
-- is legible: `eta_reported_at` is how old the estimate is, and a console can
-- refuse to show a stale one rather than count down to a number nobody has
-- confirmed for ten minutes.
ALTER TABLE intake_requests ADD COLUMN eta_seconds_remaining INTEGER;
ALTER TABLE intake_requests ADD COLUMN eta_distance_meters INTEGER;
ALTER TABLE intake_requests ADD COLUMN eta_reported_at TEXT;
