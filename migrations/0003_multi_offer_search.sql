PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS care_searches (
  id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
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
  radius_miles REAL NOT NULL DEFAULT 50,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'offers_ready', 'selected', 'expired', 'cancelled')),
  max_offers INTEGER NOT NULL DEFAULT 5 CHECK (max_offers BETWEEN 1 AND 5),
  target_limit INTEGER NOT NULL DEFAULT 30 CHECK (target_limit BETWEEN 1 AND 30),
  selected_offer_id TEXT,
  selected_intake_id TEXT REFERENCES intake_requests(id),
  legal_version TEXT NOT NULL,
  legal_accepted_at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  collection_expires_at TEXT NOT NULL,
  search_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_care_searches_customer ON care_searches(customer_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_searches_collection ON care_searches(status, collection_expires_at);
CREATE INDEX IF NOT EXISTS idx_care_searches_expiry ON care_searches(status, search_expires_at);

CREATE TABLE IF NOT EXISTS care_search_targets (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES care_searches(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  rank INTEGER NOT NULL,
  travel_minutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('contacting', 'awaiting_response', 'offered', 'selected', 'declined', 'released', 'expired')),
  contacted_at TEXT,
  responded_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(search_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_search_targets_clinic ON care_search_targets(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_targets_search ON care_search_targets(search_id, status, rank);

CREATE TABLE IF NOT EXISTS care_offers (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES care_searches(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL UNIQUE REFERENCES care_search_targets(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  response_type TEXT NOT NULL CHECK (response_type IN ('available_now', 'available_at', 'emergency_intake')),
  status TEXT NOT NULL CHECK (status IN ('active', 'selected', 'released', 'expired', 'withdrawn')),
  available_at TEXT,
  arrival_by TEXT,
  wait_min INTEGER,
  wait_max INTEGER,
  clinic_note TEXT,
  policy_snapshot_json TEXT NOT NULL DEFAULT '{}',
  deposit_amount_cents INTEGER NOT NULL DEFAULT 0,
  base_exam_fee_cents INTEGER,
  offered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_care_offers_search ON care_offers(search_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_care_offers_expiry ON care_offers(status, expires_at);

ALTER TABLE intake_requests ADD COLUMN source_search_id TEXT REFERENCES care_searches(id);
ALTER TABLE intake_requests ADD COLUMN selected_offer_id TEXT REFERENCES care_offers(id);
CREATE INDEX IF NOT EXISTS idx_intakes_source_search ON intake_requests(source_search_id);

INSERT OR IGNORE INTO tenants (id, clerk_org_id, name, slug) VALUES
  ('tenant_cedar', 'org_demo_cedar', 'Cedar Grove Veterinary Urgent Care', 'cedar-grove'),
  ('tenant_solano', 'org_demo_solano', 'Solano Pet Emergency', 'solano-pet-emergency');

INSERT OR IGNORE INTO locations (
  id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone,
  latitude, longitude, open_24_hours, accepts_walk_ins, auto_accept, arrival_window_minutes,
  species_json, capabilities_json, hours_json, base_exam_fee_cents
) VALUES
  ('loc_cedar', 'tenant_cedar', 'Cedar Grove Veterinary Urgent Care', 'cedar-grove-urgent', 'urgent', '4027 Mowry Avenue', 'Fremont', 'CA', '94538', '(510) 555-0172', 37.5485, -121.9886, 0, 1, 0, 35, '["dog","cat"]', '["urgent","same_day","minor_injury","vomiting","imaging"]', '{"daily":{"open":"08:00","close":"22:00"}}', 9500),
  ('loc_solano', 'tenant_solano', 'Solano Pet Emergency', 'solano-pet-emergency', 'emergency', '1850 Solano Avenue', 'Berkeley', 'CA', '94707', '(510) 555-0186', 37.8918, -122.2811, 1, 1, 0, 25, '["dog","cat","rabbit"]', '["emergency","urgent","surgery","oxygen","imaging","overnight"]', '{"always":"open"}', 17500);

INSERT OR IGNORE INTO tenant_policies (
  id, tenant_id, version, deposit_required, deposit_amount_cents, deposit_refundable,
  free_cancel_minutes, completed_platform_fee_cents, no_show_platform_fee_cents,
  late_cancel_platform_fee_cents, policy_json
) VALUES
  ('policy_cedar_v1', 'tenant_cedar', 1, 1, 5000, 1, 20, 2000, 500, 500, '{"label":"Urgent-care arrival hold"}'),
  ('policy_solano_v1', 'tenant_solano', 1, 1, 7500, 1, 15, 2000, 500, 500, '{"label":"Emergency intake deposit","nonRefundableAfterArrival":true}');

INSERT OR IGNORE INTO availability_reports (
  id, location_id, intake_status, stable_wait_min, stable_wait_max, capacity_count,
  accepts_critical, source, confidence, note, reported_at, expires_at, created_by
) VALUES
  ('availability_cedar_seed', 'loc_cedar', 'available', 20, 40, 2, 0, 'hospital', 'high', 'Two urgent-care arrivals currently available.', datetime('now'), datetime('now', '+30 minutes'), 'demo-clinic'),
  ('availability_solano_seed', 'loc_solano', 'limited', 50, 90, 2, 1, 'hospital', 'high', 'Emergency intake is open; all patients are triaged on arrival.', datetime('now'), datetime('now', '+30 minutes'), 'demo-clinic');
