PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  clerk_org_id TEXT UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('general', 'urgent', 'emergency', 'specialty')),
  address_line1 TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  phone TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  open_24_hours INTEGER NOT NULL DEFAULT 0,
  accepts_walk_ins INTEGER NOT NULL DEFAULT 1,
  auto_accept INTEGER NOT NULL DEFAULT 0,
  arrival_window_minutes INTEGER NOT NULL DEFAULT 20,
  species_json TEXT NOT NULL DEFAULT '["dog","cat"]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  hours_json TEXT NOT NULL DEFAULT '{}',
  base_exam_fee_cents INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_locations_tenant ON locations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_locations_active_kind ON locations(active, kind);

CREATE TABLE IF NOT EXISTS availability_reports (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  intake_status TEXT NOT NULL CHECK (intake_status IN ('available', 'limited', 'confirm_first', 'critical_only', 'diverting', 'closed', 'unverified')),
  stable_wait_min INTEGER,
  stable_wait_max INTEGER,
  capacity_count INTEGER,
  accepts_critical INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('hospital', 'integration', 'timi_request', 'community', 'prediction', 'seed')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  note TEXT,
  reported_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_availability_location_reported ON availability_reports(location_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_availability_expires ON availability_reports(expires_at);

CREATE TABLE IF NOT EXISTS tenant_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  deposit_required INTEGER NOT NULL DEFAULT 0,
  deposit_amount_cents INTEGER NOT NULL DEFAULT 0,
  deposit_refundable INTEGER NOT NULL DEFAULT 1,
  free_cancel_minutes INTEGER NOT NULL DEFAULT 30,
  completed_platform_fee_cents INTEGER NOT NULL DEFAULT 2000,
  no_show_platform_fee_cents INTEGER NOT NULL DEFAULT 500,
  late_cancel_platform_fee_cents INTEGER NOT NULL DEFAULT 500,
  policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_tenant_policies_active ON tenant_policies(tenant_id, active);

CREATE TABLE IF NOT EXISTS intake_requests (
  id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  location_id TEXT NOT NULL REFERENCES locations(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_user_id TEXT,
  pet_name TEXT NOT NULL,
  species TEXT NOT NULL,
  breed TEXT,
  age_years REAL,
  weight_lbs REAL,
  owner_name TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  owner_email TEXT,
  concern_category TEXT NOT NULL,
  concern_summary TEXT NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('routine', 'same_day', 'urgent', 'emergency')),
  red_flags_json TEXT NOT NULL DEFAULT '[]',
  customer_latitude REAL,
  customer_longitude REAL,
  travel_minutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled', 'en_route', 'arrived', 'triaged', 'seen', 'completed', 'no_show')),
  clinic_note TEXT,
  requested_at TEXT NOT NULL,
  decision_at TEXT,
  request_expires_at TEXT NOT NULL,
  arrival_by TEXT,
  policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
  deposit_amount_cents INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required', 'pending', 'requires_action', 'processing', 'paid', 'refunded', 'failed')),
  payment_provider_id TEXT,
  consent_to_contact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_intakes_location_status ON intake_requests(location_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_intakes_public_code ON intake_requests(public_code);
CREATE INDEX IF NOT EXISTS idx_intakes_expiry ON intake_requests(status, request_expires_at);

CREATE TABLE IF NOT EXISTS intake_events (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intake_requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'clinic', 'system', 'integration')),
  actor_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_intake_events_intake ON intake_events(intake_id, created_at);

CREATE TABLE IF NOT EXISTS customer_observations (
  id TEXT PRIMARY KEY,
  intake_id TEXT REFERENCES intake_requests(id) ON DELETE SET NULL,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  milestone TEXT NOT NULL CHECK (milestone IN ('arrived', 'triaged', 'seen', 'departed', 'staff_wait_quote')),
  observed_at TEXT NOT NULL,
  wait_quote_min INTEGER,
  wait_quote_max INTEGER,
  anonymous_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_observations_location_time ON customer_observations(location_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  intake_id TEXT REFERENCES intake_requests(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('dashboard', 'sms', 'email', 'voice')),
  recipient TEXT,
  template_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbox_delivery ON notification_outbox(status, available_at);
