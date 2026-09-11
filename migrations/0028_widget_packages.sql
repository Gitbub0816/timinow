PRAGMA foreign_keys = ON;

-- ══════════════════════════════════════ Widget packages (the Studio) ═════
--
-- A widget package is a saved design a clinic built in the provider portal's
-- Widget Studio: which of the ten layouts, which color variant, what width,
-- and which optional Tími elements (coverage line, Paw It Forward donate
-- button, reserve CTA) it carries. The package id rides in the embed snippet
-- in plain sight (`data-timi-package="pkg_…"`) — it is configuration, not a
-- credential; the widget token remains the only thing exchanged for status.
--
-- The public status endpoint (src/widget.js handlePublicWidgetStatus) only
-- honors a package whose tenant matches the token's tenant, so one clinic's
-- package id pasted next to another clinic's token changes nothing.
--
-- Design/variant/element vocabularies are enforced in src/widget.js rather
-- than CHECK constraints: the embed script ships new designs faster than
-- migrations ship, and an unknown value degrades to the default design
-- rather than failing the insert.

CREATE TABLE IF NOT EXISTS widget_packages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  design TEXT NOT NULL DEFAULT 'card',
  variant TEXT NOT NULL DEFAULT 'cream',
  size TEXT NOT NULL DEFAULT 'standard',
  elements_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_widget_packages_tenant ON widget_packages(tenant_id, status);
