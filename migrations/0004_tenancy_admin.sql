PRAGMA foreign_keys = ON;

-- Platform operators. Only rows in this table (or the PLATFORM_ADMIN_* env allowlists)
-- may create a tenant. Tenant admins can never write to this table.
CREATE TABLE IF NOT EXISTS platform_admins (
  clerk_user_id TEXT PRIMARY KEY,
  email TEXT,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mirror of Clerk organization membership so the Worker can authorize without a
-- Backend API round trip on every request. Clerk remains the source of truth;
-- these rows are reconciled on sign-in and on every admin-console mutation.
CREATE TABLE IF NOT EXISTS tenant_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  clerk_org_id TEXT NOT NULL,
  clerk_membership_id TEXT,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'org:member' CHECK (role IN ('org:admin', 'org:member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(clerk_user_id, status);

CREATE TABLE IF NOT EXISTS tenant_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clerk_invitation_id TEXT,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'org:member' CHECK (role IN ('org:admin', 'org:member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant ON tenant_invitations(tenant_id, status);

-- Append-only trail for every privileged mutation made from the admin console
-- or a tenant console. Never updated or deleted by application code.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('platform', 'tenant')),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant ON admin_audit_log(tenant_id, created_at DESC);

ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN clerk_org_slug TEXT;
ALTER TABLE tenants ADD COLUMN contact_email TEXT;
ALTER TABLE tenants ADD COLUMN created_by TEXT;

CREATE INDEX IF NOT EXISTS idx_tenants_clerk_org ON tenants(clerk_org_id);
