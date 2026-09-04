PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------------
-- Feature: embeddable clinic availability widget (src/widget.js)
--
-- A widget token is a bearer credential a clinic embeds on its own public
-- website. It is scoped, hashed at rest (never stored in the clear — see
-- token_hash), and revocable, and it grants read access to exactly one
-- public endpoint whose response is an explicit whitelist: coarse status,
-- coarse freshness, and a deep link back into Tími. Nothing else about the
-- clinic — name, address, capacity numbers, customer or financial data — is
-- ever reachable through it. See docs/WIDGET.md.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS widget_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The one location this token speaks for. Nullable only because a tenant
  -- can in principle have zero active locations at creation time; every read
  -- path falls back to the tenant's primary location when unset.
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  label TEXT,
  -- sha256(token), hex. The plaintext token is generated once, returned once
  -- in the create response, and never stored — this table can identify a
  -- token presented to it but cannot produce one.
  token_hash TEXT NOT NULL UNIQUE,
  -- First 12 characters of the plaintext token, kept only so a clinic admin
  -- can tell two tokens apart in a list without Tími ever holding enough of
  -- the secret to reconstruct it.
  token_prefix TEXT NOT NULL,
  -- JSON array of https:// origins this token accepts requests from, or
  -- '[]' for "no restriction configured". Checked against Origin/Referer —
  -- best-effort, see src/widget.js for why.
  allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_by TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_widget_tokens_tenant ON widget_tokens(tenant_id, status);

-- Append-only. Token creation, revocation, and anomalous use (an origin
-- mismatch, a rate-limit trip) all land here so a clinic admin — and Tími —
-- can see who created a widget and whether it has been misused.
CREATE TABLE IF NOT EXISTS widget_audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES widget_tokens(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_widget_audit_tenant ON widget_audit_log(tenant_id, created_at DESC);

-- ------------------------------------------------------------------------
-- Feature: clinic overflow tools — stable referral link (src/referrals.js)
--
-- One active slug per tenant, auto-provisioned the first time the clinic
-- console asks for it. /r/:slug (see src/index.js) redirects a pet owner
-- into the customer app with the slug captured as attribution — see the
-- attribution columns below.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS referral_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  click_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_links_tenant ON referral_links(tenant_id, status);

-- ------------------------------------------------------------------------
-- Feature: traffic-source / campaign attribution (src/analytics.js,
-- public/app.js boot)
--
-- Nullable everywhere: attribution is optional context on a search or
-- intake, never a requirement to reach one, and no existing row gains it
-- retroactively.
-- ------------------------------------------------------------------------

ALTER TABLE care_searches ADD COLUMN attribution_source TEXT;
ALTER TABLE care_searches ADD COLUMN attribution_medium TEXT;
ALTER TABLE care_searches ADD COLUMN attribution_campaign TEXT;
-- The referral_links.slug that brought this search in, if any — independent
-- of attribution_source/medium/campaign (a utm_* link and a clinic referral
-- link can both be present, or neither).
ALTER TABLE care_searches ADD COLUMN referral_slug TEXT;

ALTER TABLE intake_requests ADD COLUMN attribution_source TEXT;
ALTER TABLE intake_requests ADD COLUMN attribution_medium TEXT;
ALTER TABLE intake_requests ADD COLUMN attribution_campaign TEXT;
ALTER TABLE intake_requests ADD COLUMN referral_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_care_searches_referral ON care_searches(referral_slug);
CREATE INDEX IF NOT EXISTS idx_intake_requests_referral ON intake_requests(referral_slug);

-- The analytics beacon's optional coarse source tag (e.g. "widget",
-- "referral") — same privacy posture as every other column on this table,
-- see migrations/0010_provider_analytics.sql: never an identifier.
ALTER TABLE analytics_events ADD COLUMN source TEXT;
