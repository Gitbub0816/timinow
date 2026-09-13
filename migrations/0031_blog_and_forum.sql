-- The blog, the community forum, and who is allowed to write in them.
--
-- Three kinds of author, and the difference between them is the whole point of
-- the byline: a TímiNOW post carries TímiNOW's name, a contributor writes on
-- TímiNOW's behalf, and a clinic's post is the clinic's own opinion. Those are
-- different levels of endorsement and the schema records which one applies
-- rather than leaving a surface to infer it from whatever fields are set.

-- ─────────────────────────────────────────────────────────── authorship ──

-- People who may write for TímiNOW without being platform operators.
--
-- Deliberately NOT a row in admin_role_assignments. rolesFor() in
-- src/admin-roles.js returns nothing at all unless isPlatformAdmin() is true,
-- so an ADMIN_ROLES entry for a contributor would mean making every guest
-- writer a platform administrator with read access to the ledger, the
-- hardship queue and every clinic's commercial terms. A contributor is
-- someone who writes a post; that is the entire grant.
CREATE TABLE IF NOT EXISTS content_contributors (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  -- The name that appears in the byline. Held here rather than read from
  -- Clerk so a contributor's byline is a deliberate editorial decision and
  -- does not change because somebody edited their profile.
  display_name TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_by TEXT,
  UNIQUE(clerk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_content_contributors_active ON content_contributors(clerk_user_id, revoked_at);

-- Whether this clinic staff member may publish on the clinic's behalf.
--
-- Granted by that clinic's own org:admin, not by TímiNOW: a practice knows
-- which of its people speak for it and TímiNOW does not.
ALTER TABLE tenant_members ADD COLUMN can_publish_posts INTEGER NOT NULL DEFAULT 0;

-- ───────────────────────────────────────────────────────────────── posts ──

CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  -- URL identity, and the only thing a link depends on. Immutable once
  -- published: a slug that changes is a link somebody has already shared that
  -- now 404s.
  slug TEXT NOT NULL UNIQUE,
  -- platform  — TímiNOW itself, written by a named operator.
  -- contributor — written on TímiNOW's behalf by a named non-operator.
  -- provider  — a clinic's own post. TímiNOW hosts it and does not endorse it.
  author_kind TEXT NOT NULL CHECK (author_kind IN ('platform', 'contributor', 'provider')),
  -- Set for a provider post; null otherwise. This is the multi-tenancy: a
  -- clinic's posts belong to the clinic, and a clinic may only ever read,
  -- edit or withdraw its own.
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id TEXT,
  -- Frozen at publish time, all three of them. A byline is a statement about
  -- who wrote something on a particular day; re-deriving it later from a
  -- profile or a tenant row means an old post silently re-attributes itself
  -- when somebody changes their name or a clinic is renamed.
  author_name TEXT,
  provider_name TEXT,
  title TEXT NOT NULL,
  excerpt TEXT,
  -- Markdown as typed. Rendered on read rather than stored as HTML, so the
  -- sanitiser is applied by whatever is current at render time and not frozen
  -- into the row by whatever was current at write time.
  body_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn', 'removed')),
  published_at TEXT,
  -- Set when an operator takes a post down, with the reason. Provider posts
  -- publish immediately, so this is the control that makes that safe.
  removed_at TEXT,
  removed_by TEXT,
  removed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_posts_live ON blog_posts(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_tenant ON blog_posts(tenant_id, status, published_at DESC);

-- ────────────────────────────────────────────────────────────── comments ──

-- Signed-in only, and live on submission. `status` is what makes that
-- survivable: a reader can hide a comment from themselves by reporting it,
-- and an operator can remove it for everybody.
CREATE TABLE IF NOT EXISTS blog_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'removed')),
  removed_at TEXT,
  removed_by TEXT,
  removed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_comments(post_id, status, created_at);

-- ───────────────────────────────────────────────────────────────── forum ──

-- Two kinds of thread in one table, because they are the same object with a
-- different social contract: a discussion is people talking, a question wants
-- an answer and can mark which reply was it.
CREATE TABLE IF NOT EXISTS forum_threads (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('discussion', 'question')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  -- A reply from a clinic is worth marking as such, and that only means
  -- anything if it is recorded rather than claimed in the text.
  author_kind TEXT NOT NULL DEFAULT 'member' CHECK (author_kind IN ('member', 'contributor', 'provider', 'platform')),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  provider_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'removed')),
  answered_reply_id TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT,
  removed_by TEXT,
  removed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_forum_threads_live ON forum_threads(status, kind, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS forum_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'member' CHECK (author_kind IN ('member', 'contributor', 'provider', 'platform')),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  provider_name TEXT,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'removed')),
  removed_at TEXT,
  removed_by TEXT,
  removed_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_forum_replies_thread ON forum_replies(thread_id, status, created_at);

-- ─────────────────────────────────────────────────────────────── reports ──

-- What a reader presses when something is wrong. One table for every kind of
-- content, because the queue an operator works is one queue.
CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('post', 'comment', 'thread', 'reply')),
  subject_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One report per person per thing. A reader who presses report twice is
  -- reporting once; without this a single upset reader looks like a pile-on.
  UNIQUE(subject_type, subject_id, reporter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_content_reports_open ON content_reports(status, created_at DESC);

-- ─────────────────────────────────────────────────────────── subscribers ──

-- Double opt-in, and the schema enforces it: an address is only mailed while
-- `status` is 'confirmed', which it only reaches by someone following the link
-- sent to that address. Anyone can type anyone's email into a form, and a
-- subscription list built without this is a list of people who never asked.
CREATE TABLE IF NOT EXISTS blog_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  -- Random, single-purpose, and cleared the moment it is used. Also what the
  -- unsubscribe link carries, so leaving is one click and needs no account —
  -- a subscription that is hard to leave is a complaint, and eventually a
  -- deliverability problem for every other email this product sends.
  confirm_token TEXT,
  unsubscribe_token TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  -- Where they signed up, for nothing more than knowing which page works.
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_subscribers_status ON blog_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_blog_subscribers_confirm ON blog_subscribers(confirm_token);
CREATE INDEX IF NOT EXISTS idx_blog_subscribers_unsubscribe ON blog_subscribers(unsubscribe_token);
