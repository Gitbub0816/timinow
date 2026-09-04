PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Feature A: guest-to-account conversion.
--
-- Guest identity itself is stateless — a signed cookie minted per visitor,
-- see src/guest-session.js — and needs no table of its own: the guest id
-- already lives in customer_user_id / clerk_user_id on every row a guest
-- creates, exactly like a Clerk user id would. This table exists solely so
-- "did we already merge this guest into this account" is a durable,
-- idempotent, auditable fact instead of an UPDATE that might run twice from a
-- doubled tap or a retried request. See src/account-adoption.js.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_adoptions (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL,
  clerk_user_id TEXT NOT NULL,
  intakes_adopted INTEGER NOT NULL DEFAULT 0,
  searches_adopted INTEGER NOT NULL DEFAULT 0,
  pets_adopted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(guest_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_adoptions_user ON account_adoptions(clerk_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Feature B: shared clinic workstation sessions. See src/workstation.js for
-- the enrollment and session-verification logic these tables back.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workstations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- SHA-256 hex of the enrollment token. The token itself is shown exactly
  -- once, at creation, and is never stored — this hash is the only trace of
  -- it, the same posture as a password.
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_workstations_tenant ON workstations(tenant_id, revoked_at);

CREATE TABLE IF NOT EXISTS workstation_sessions (
  id TEXT PRIMARY KEY,
  workstation_id TEXT NOT NULL REFERENCES workstations(id) ON DELETE CASCADE,
  established_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT,
  -- Ordinary revocation goes through workstations.revoked_at, which kills
  -- every session at once without having to enumerate them. This column is
  -- for the narrower "sign this one device out" action.
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workstation_sessions_workstation ON workstation_sessions(workstation_id, revoked_at);

-- Append-only. Every routine action a workstation session takes — availability
-- update, intake accept/decline, search-target offer/decline — is logged here
-- with the session that performed it, so "clinic + workstation + session +
-- timestamp" is answerable for any action even though no individual signed in.
CREATE TABLE IF NOT EXISTS workstation_audit_log (
  id TEXT PRIMARY KEY,
  workstation_session_id TEXT NOT NULL REFERENCES workstation_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workstation_audit_session ON workstation_audit_log(workstation_session_id, created_at DESC);
