PRAGMA foreign_keys = ON;

-- Where a client failure goes so it does not have to go on the customer's
-- screen.
--
-- Every error the apps hit was being rendered verbatim: "Sign in is required
-- to continue. (401 [AUTHENTICATION_REQUIRED] from /api/intakes/
-- intake_be49b8c23b0c4eaf92d4e0beac5ca377/status)". That is a good line in a
-- log and a terrible one on a phone. It tells somebody standing in a car park
-- with a sick animal nothing they can act on, names internal routes and record
-- ids, and — when the cause is a token that expired forty seconds ago —
-- is not even true.
--
-- So the detail comes here instead, where an operator can read it, and the
-- person gets a sentence. `fingerprint` groups the same failure across
-- reports so a console can show "47 times in the last hour" rather than
-- forty-seven rows.

CREATE TABLE IF NOT EXISTS client_errors (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  -- Which app: customer_ios, customer_android, customer_web, vet_macos,
  -- vet_windows, vet_web, admin_web. Free text rather than a CHECK, because a
  -- new surface must never be the reason a report is dropped.
  surface TEXT NOT NULL,
  app_version TEXT,
  -- What the client was doing. A route, not a URL: no ids, no query string.
  path TEXT,
  status INTEGER,
  code TEXT,
  message TEXT,
  -- Anything else worth having, as JSON. Bounded by the Worker.
  detail_json TEXT NOT NULL DEFAULT '{}',
  -- Who and where, when the client knew. Null is normal: the most useful
  -- reports are the ones from somebody who could not sign in.
  clerk_user_id TEXT,
  tenant_id TEXT,
  -- The Worker's own request id for the failing call, when the client had one.
  -- This is what joins a report to the Worker's logs.
  request_id TEXT,
  -- The short code shown to the customer. It is how "it said something about
  -- a reference" becomes one row.
  reference TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_client_errors_recent ON client_errors(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_fingerprint ON client_errors(fingerprint, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_reference ON client_errors(reference);
