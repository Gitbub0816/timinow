PRAGMA foreign_keys = ON;

-- Three-way calling policy, replacing the voice_calls_enabled boolean as the
-- tenant-level decision (the boolean stays for older clients and as the
-- location-level override the gateway still honors):
--
--   'always'          ring the clinic for every care request (the previous
--                     behavior, and the default)
--   'console_active'  ring only while a Tími console is open — defined as a
--                     console having polled /api/clinic/dashboard within the
--                     last 90 seconds (they poll every 6)
--   'never'           never ring; console and notifications only
--
-- Backfilled from the boolean so a clinic that had already said "no calls"
-- stays a no.
ALTER TABLE tenants ADD COLUMN voice_call_policy TEXT NOT NULL DEFAULT 'always'
  CHECK (voice_call_policy IN ('always', 'console_active', 'never'));
UPDATE tenants SET voice_call_policy = 'never' WHERE voice_calls_enabled = 0;

-- Console presence, written on every clinic dashboard fetch. Deliberately a
-- timestamp rather than a connected/disconnected flag: consoles crash, laptops
-- sleep, and nothing sends a goodbye — recency is the only honest signal.
ALTER TABLE tenants ADD COLUMN console_last_seen_at TEXT;
