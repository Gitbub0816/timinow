PRAGMA foreign_keys = ON;

-- Operator roles. Until now the console asked one question — is this a
-- platform administrator — which was honest when everything it did was
-- reading, and stopped being adequate once the same screens could waive a
-- clinic's fees for the life of its participation or move money out of
-- restricted custody.
--
-- An operator with no row here is a SUPPORT_ADMIN: reads everything, changes
-- nothing that matters. That is the safe direction for existing operators to
-- land in, and it makes granting real authority a deliberate act.
CREATE TABLE IF NOT EXISTS admin_role_assignments (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'SUPPORT_ADMIN',
    'CLINIC_OPERATIONS_ADMIN',
    'FINANCE_ADMIN',
    'COMPLIANCE_ADMIN',
    'SUPER_ADMIN'
  )),
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Revoked rather than deleted: who held what authority, and when, is the
  -- question an audit asks, and a deleted row cannot answer it.
  revoked_at TEXT,
  revoked_by TEXT,
  reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_role_unique
  ON admin_role_assignments(clerk_user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_role_user ON admin_role_assignments(clerk_user_id);

-- Dual approval for the actions where one person acting alone is the risk:
-- manual ledger adjustments, Treasury releases, fee and founding changes,
-- guarantee overrides, and restoring a clinic terminated for Cause.
CREATE TABLE IF NOT EXISTS admin_approvals (
  id TEXT PRIMARY KEY,
  -- Identifies the specific pending action. Two approvals of the same
  -- request_id are two people agreeing to the same thing; two different
  -- request_ids are two different things.
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  -- A hash of what was approved, so a request cannot be edited between the
  -- first approval and the second and still count as approved.
  payload_hash TEXT,
  note TEXT,
  approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One approval per person per request. Approving your own request twice is
-- the failure mode this exists to prevent, and the one most likely to be
-- reached by accident.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_approval_unique
  ON admin_approvals(request_id, action, approver_id);
CREATE INDEX IF NOT EXISTS idx_admin_approval_request ON admin_approvals(request_id, action);
