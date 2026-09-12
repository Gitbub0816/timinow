-- Deactivates the fictional demonstration clinics that migrations
-- 0002_seed.sql and 0003_multi_offer_search.sql insert into EVERY database
-- that runs migrations — production included. The runtime filter in
-- src/db.js listLocations() already keeps these rows out of discovery
-- wherever DEMO_MODE is not "true"; this script is the data-hygiene
-- companion for the production database itself.
--
-- Run against production with:  npm run db:cleanup-demo:remote
-- (wrangler d1 execute timinow --remote --file scripts/remove-demo-seed.sql)
--
-- Deliberately an UPDATE, not a DELETE: production rows may be referenced
-- by historical searches, intakes, and availability reports created while
-- the seed data was live, and every read path already filters on
-- l.active = 1. Deliberately NOT a migration: migrations run against local
-- and test databases too, where the demo clinics are exactly what makes
-- zero-config development and the test suite work.
--
-- Idempotent — safe to run any number of times.
UPDATE locations
SET active = 0
WHERE tenant_id IN (SELECT id FROM tenants WHERE clerk_org_id LIKE 'org_demo_%');
