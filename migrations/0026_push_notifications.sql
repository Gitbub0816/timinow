PRAGMA foreign_keys = ON;

-- ════════════════════════════════════ Native push (APNs) plumbing ════════
--
-- The SMS in notifyFirstOfferBySms (src/index.js, migration-independent) is
-- the only way a backgrounded customer app currently learns a clinic
-- answered. This table is the missing half: one row per device this
-- customer (or this guest session) has asked to be pushed to, so the same
-- "first offer" moment can also wake the phone with a real notification
-- instead of relying on a text arriving and being tapped.
--
-- One row per physical device registration, not per account — a customer
-- signed in on two phones gets two rows, and both are pushed. `device_token`
-- is UNIQUE on its own (not composite with the owner) because APNs tokens are
-- already globally unique per device+app install, and because the upsert in
-- src/push.js (POST /api/push/register-device) needs a single conflict
-- target to re-register the same phone cleanly after a reinstall or a token
-- rotation, however the account (or lack of one) attached to that token has
-- changed since.
--
-- customer_user_id / guest_session_id are both nullable and mutually
-- exclusive in practice (see src/push.js registerDevice): a signed-in
-- customer's rows carry the Clerk user id in the first column, an anonymous
-- visitor's carry their guest session id (src/guest-session.js) in the
-- second. Kept as two columns rather than reusing care_searches' single
-- customer_user_id column (which stores a guest id there too, see
-- src/guest-session.js's header comment) because a device token is a
-- credential that can outlive a single guest session across an app
-- reinstall — a future account-adoption pass (src/account-adoption.js) needs
-- to be able to tell "this token was registered while signed out" apart from
-- "this token was registered by a real account" without string-sniffing an
-- id prefix.
CREATE TABLE IF NOT EXISTS push_device_tokens (
  id TEXT PRIMARY KEY,
  customer_user_id TEXT,
  guest_session_id TEXT,
  device_token TEXT NOT NULL UNIQUE,
  -- Free text rather than a CHECK: today this is only ever 'ios', and a
  -- CHECK constraining it to a single value is a schema change waiting to
  -- happen the day Android push arrives. src/push.js already validates it
  -- against a small allowlist before it ever reaches this column.
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Bumped on every successful re-registration (the same token POSTed
  -- again — app relaunch, permission re-granted, etc.) and read by nothing
  -- yet, but it is the column an eventual "stop pushing devices nobody has
  -- opened the app on in N months" sweep would key off.
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set the moment APNs answers 410 Gone or BadDeviceToken for this token
  -- (see sendApnsPush in src/push.js), or when the phone itself asks to
  -- unregister (DELETE /api/push/register-device, e.g. on sign-out). A
  -- revoked row is never deleted — its history is harmless and deleting it
  -- would let the same dead token be re-inserted and retried forever by a
  -- caller that raced the revocation.
  revoked_at TEXT
);

-- The lookup sendPushForFirstOffer actually runs: every live token for a
-- search's customer or guest id. Partial (WHERE revoked_at IS NULL) so a
-- phone that reinstalled and re-registered a new token does not leave the
-- old, now-revoked row slowing down every push fan-out to that customer.
CREATE INDEX IF NOT EXISTS idx_push_device_tokens_customer ON push_device_tokens(customer_user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_push_device_tokens_guest ON push_device_tokens(guest_session_id) WHERE revoked_at IS NULL;

-- A second, independent "sent once" marker alongside care_searches'
-- sms_notified_at (Feature B). Deliberately its own column rather than
-- reusing that one: src/push.js sendPushForFirstOffer and src/index.js
-- notifyFirstOfferBySms are called side by side and neither may block or
-- suppress the other (see the call site in respondToCareSearch) — APNs not
-- being configured, or every registered device having gone stale, must
-- never stop the SMS from claiming its own send, and a carrier failure on
-- the SMS side must never stop the push from claiming its own.
ALTER TABLE care_searches ADD COLUMN push_notified_at TEXT;
