PRAGMA foreign_keys = ON;

-- The voice gateway's call log. One row per attempted outbound call to a
-- clinic on behalf of a `care_search_targets` row. `notification_outbox`
-- remains the queue of intent ("Tími should try calling this clinic"); this
-- table is the record of what actually happened on the phone.
CREATE TABLE IF NOT EXISTS clinic_call_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT REFERENCES notification_outbox(id) ON DELETE SET NULL,
  search_id TEXT NOT NULL REFERENCES care_searches(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES care_search_targets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  to_number TEXT NOT NULL,
  from_number TEXT,
  provider TEXT NOT NULL DEFAULT 'twilio',
  provider_call_sid TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled')),
  digits TEXT,
  outcome TEXT CHECK (outcome IN ('accepted', 'declined', 'no_response', 'error')),
  attempt INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  started_at TEXT,
  answered_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_attempts_target ON clinic_call_attempts(target_id);
CREATE INDEX IF NOT EXISTS idx_call_attempts_provider_sid ON clinic_call_attempts(provider_call_sid);
CREATE INDEX IF NOT EXISTS idx_call_attempts_status_created ON clinic_call_attempts(status, created_at);

-- Per-location and per-tenant calling preferences. A clinic's own console
-- (owned by another agent) is expected to expose toggles that write these
-- columns; the voice gateway only reads them.
ALTER TABLE locations ADD COLUMN voice_phone TEXT;
ALTER TABLE locations ADD COLUMN voice_calls_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE tenants ADD COLUMN voice_calls_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN voice_quiet_hours_json TEXT NOT NULL DEFAULT '{}';
