PRAGMA foreign_keys = ON;

-- A veterinary practice asking to join the network.
--
-- Until now "we'd like to be listed" arrived as an email to the founder, was
-- read on a phone between other things, and had no status anybody could see:
-- a practice that wrote twice got two threads and a practice that wrote once
-- sometimes got nothing. This is the form's landing place — public to write,
-- operator-only to read — so an application is a row with a status rather
-- than a memory.
--
-- Deliberately not a tenant. Nothing here is verified, and an application
-- becomes a tenant only when a platform operator creates one through the
-- admin console's own flow.

CREATE TABLE IF NOT EXISTS provider_applications (
  id TEXT PRIMARY KEY,
  practice_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  -- Free text, not a validated species list: "mostly dogs, some exotics" is a
  -- perfectly good answer on an application form.
  species TEXT,
  message TEXT,
  -- new | contacted | closed. Checked in the Worker rather than by a CHECK
  -- constraint, so adding a stage is a deploy and not a table rebuild.
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The console's one query: everything still in a given stage, newest first.
CREATE INDEX IF NOT EXISTS idx_provider_applications_status
  ON provider_applications(status, datetime(created_at));

-- What people do on Tími's surfaces, counted without identifying anybody.
--
-- The privacy design is the table. There is no raw IP address, no raw user
-- agent, no cookie, and no client-supplied identifier of any kind — a client
-- cannot claim to be somebody, and the server never stores what would prove
-- who they were. The only visitor notion is visitor_hash: a truncated
-- sha256(UTC date + ip + user agent) computed in the Worker, so the same
-- person counts once per day and becomes a different, unlinkable value at
-- midnight UTC. Nothing here can identify anyone across days, nothing is
-- stored on the visitor's device, and so none of it needs a consent banner.

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  -- Which Worker took the beacon (customer, clinic, admin). Set from the
  -- server's own SURFACE var, never from the client, so a beacon cannot file
  -- itself under another console's numbers.
  surface TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The pathname only. The query string is stripped in the Worker before the
  -- row exists, because a query is where an email address or a token lands in
  -- a URL, and this table must never hold one.
  path TEXT,
  -- See the header comment: a day-scoped hash, never an identifier.
  visitor_hash TEXT,
  -- Coarse on purpose. Cloudflare's country code and a two-value device class
  -- answer every product question this table exists for; anything finer is
  -- fingerprinting surface with no question attached.
  country TEXT,
  device TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The two shapes the summary endpoint asks for: a day-by-day count per
-- surface, and one event name over time.
CREATE INDEX IF NOT EXISTS idx_analytics_events_day_surface
  ON analytics_events(date(occurred_at), surface);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name
  ON analytics_events(name, datetime(occurred_at));
