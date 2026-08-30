/**
 * Temporary match aliases: which clinic is called what, for the next thirty
 * minutes, on one customer's comparison screen.
 *
 * ## What this is for
 *
 * A customer comparing four clinics that have each committed to a wait time
 * can, if shown the names, close the app and drive to whichever one sounds
 * closest — arriving unannounced at a practice that agreed to hold a slot for
 * a patient it now has no record of. Masking the name until confirmation
 * keeps the commitment and the arrival attached to each other.
 *
 * That is a real interest, and it is not a licence to deceive. So the alias
 * is labelled as temporary on every card (`MATCH_ALIAS_LABEL`), the explainer
 * says exactly when the real name appears, and the moment the customer
 * confirms, the concealment ends completely.
 *
 * ## The four properties that matter
 *
 * 1. **Never permanent.** An alias belongs to a session. The same clinic is
 *    Sequoia at 9pm and Harbor at 9:20 — otherwise the alias becomes a name,
 *    and a name that can be looked up is not masking anything.
 * 2. **Stable inside the session.** A refresh, a back-navigation, or a
 *    screen-reader rerender during payment must not rename a card under
 *    somebody's finger. Stability comes from the persisted row and the
 *    (session, clinic) primary key, not from hoping the shuffle is
 *    reproducible.
 * 3. **Unique inside the result set.** Five clinics, five distinct words.
 *    Enforced by UNIQUE(session, alias) in the database.
 * 4. **Independent of everything commercial.** The shuffle reads a session
 *    id, a library version and a secret. It cannot read rating, distance,
 *    wait, fee tier, founding status or sponsorship, because those values are
 *    not passed to it — see `assignAliases`, which takes clinic *ids* and
 *    nothing else about a clinic. A prettier alias for a better-paying clinic
 *    would be an advertising system wearing a privacy feature's clothes.
 *
 * ## How assignment works
 *
 * Aliases are ordered by HMAC(secret, session|version|slug) and candidates by
 * HMAC(secret, session|version|clinicId), then zipped. Ordering the
 * candidates by their own keyed hash rather than by the order the caller
 * happened to pass them is what makes property 4 structural: re-rank the
 * candidate list any way you like and the mapping is identical.
 *
 * Adding a candidate mid-session draws from the aliases this session has not
 * used; removing one leaves every other row untouched. Neither renames
 * anything, because existing rows are never rewritten.
 *
 * ## What a pre-confirmation card may contain
 *
 * `maskedMatchCard` is the whole payload. Tími's operational facts and
 * Google's rating are separately fielded so a client can render Google's
 * attribution inside the rating container where it belongs — and so the
 * entire rating module can be switched off without leaving a hole in the
 * card. Nothing in the payload is a real name, an address, a phone number, a
 * URL, a photo, review text, or a Google Maps link.
 */

import { hasDatabase } from "./db.js";
import { recordAudit } from "./ledger.js";
import { ALIAS_LIBRARY, ALIAS_LIBRARY_VERSION, aliasBySlug } from "./alias-library.js";

/**
 * The persistent text that sits under every alias on every card. Required to
 * be visible without hover, tap, or tooltip: an unexplained pretty name is
 * the deceptive version of this feature.
 */
export const MATCH_ALIAS_LABEL = "Temporary TímiNOW match name";

/** The explainer behind "Why don't I see clinic names?", from the spec. */
export const MATCH_ALIAS_EXPLAINER = Object.freeze({
  question: "Why match names?",
  body: "TímiNOW uses temporary match names while you compare available clinics. "
    + "These are not the clinics' business names. Choose a match using availability, "
    + "travel time, capabilities, and rating. After you confirm your booking, we'll "
    + "immediately show the clinic's real name, address, phone number, and directions."
});

/** What the customer is promised will appear the instant they confirm. */
export const REVEALED_ON_CONFIRMATION = Object.freeze([
  "name", "address", "phone", "directions", "checkInInstructions", "depositPolicy", "cancellationTerms"
]);

export const DEFAULT_SESSION_TTL_MINUTES = 30;

/** Google's attribution, described once so no caller invents its own wording. */
export const GOOGLE_ATTRIBUTION = Object.freeze({
  provider: "GOOGLE_MAPS",
  /** Preferred treatment: the official current logo asset, unmodified. */
  logoRequired: true,
  /** Text fallback for genuinely space-constrained layouts only. */
  text: "Google Maps",
  /** Non-negotiable: inside the same visual container as the rating itself. */
  placement: "inside_rating_container",
  disclosure: "Google Maps ratings are calculated from user reviews. Reviews are not verified "
    + "by Google, though Google checks for and removes fake content when identified."
});

const OFFER_KIND_LABEL = {
  general: "Veterinary clinic",
  urgent: "Urgent care veterinary clinic",
  emergency: "Emergency veterinary hospital",
  specialty: "Specialty veterinary clinic"
};

const TEXT_ENCODER = new TextEncoder();

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The session TTL. Thirty minutes by default and configurable, because the
 * right number is "long enough to finish paying" and that is a product
 * question, not a constant.
 */
export function sessionTtlMinutes(env) {
  const configured = Number(env?.MATCH_ALIAS_TTL_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : DEFAULT_SESSION_TTL_MINUTES;
}

/**
 * The shuffle key.
 *
 * A configured secret gives a keyed deterministic shuffle; without one, a
 * per-session random value is generated instead. Both are permitted by the
 * spec, and stability never depended on determinism anyway — it comes from
 * the persisted mapping. What is *not* permitted is seeding on a clinic id,
 * a user id, a postcode, or anything else globally stable, because that
 * makes the alias a durable label for the clinic.
 */
export function serverSecretFor(env, provided) {
  const secret = provided || env?.MATCH_ALIAS_SECRET || env?.SESSION_SECRET;
  if (secret) return String(secret);
  return `ephemeral:${crypto.randomUUID()}`;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", TEXT_ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(message)));
}

/**
 * A keyed, deterministic, secure shuffle.
 *
 * Each item is sorted by HMAC(secret, seed|item). Note what is absent: the
 * item's position in the input, and any property of the item other than the
 * string identifying it. That absence is the guarantee that alias choice
 * encodes no rank.
 */
export async function keyedShuffle(secret, seed, values) {
  const keyed = await Promise.all(values.map(async (value) => ({
    value,
    key: await hmacHex(secret, `${seed}|${value}`)
  })));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.value < b.value ? -1 : 1)));
  return keyed.map((entry) => entry.value);
}

/* ───────────────────────────────────────────────────── collision checks ─── */

function normalizeName(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Whether an alias would collide with a real business name in this result
 * set or nearby.
 *
 * "Harbor" is a fine alias in a city with no Harbor Animal Hospital and a
 * confusing one where there is: the customer reads it as the clinic's name,
 * which is the one thing an alias must never be mistaken for. Substring
 * matching on the whole word — "Grove" collides with "Grove Veterinary" and
 * with "Willow Grove Pet Clinic", both of which are exactly the problem.
 */
export function collidesWithNames(displayName, names) {
  const alias = normalizeName(displayName);
  if (!alias) return false;
  const pattern = new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
  return (names || []).some((name) => pattern.test(normalizeName(name)));
}

async function denylistedSlugs(env, market) {
  if (!hasDatabase(env)) return new Set();
  const result = await env.DB.prepare(
    "SELECT alias_slug FROM match_alias_denylist WHERE scope = 'GLOBAL' OR market = ?"
  ).bind(market || "__no_market__").all();
  return new Set(result.results.map((row) => row.alias_slug));
}

/* ──────────────────────────────────────────────────────────── sessions ─── */

function sessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id || null,
    searchId: row.search_id || null,
    market: row.market || null,
    aliasLibraryVersion: Number(row.alias_library_version),
    status: row.status,
    ttlMinutes: Number(row.ttl_minutes),
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at || null,
    createdAt: row.created_at
  };
}

export async function getSearchSession(env, searchSessionId) {
  if (!hasDatabase(env) || !searchSessionId) return null;
  const row = await env.DB.prepare("SELECT * FROM search_sessions WHERE id = ? LIMIT 1").bind(searchSessionId).first();
  return sessionFromRow(row);
}

function expiryFrom(ttlMinutes, from = Date.now()) {
  return new Date(from + ttlMinutes * 60_000).toISOString();
}

/**
 * Get or create the session an alias mapping hangs off. Created after the
 * candidates are resolved, exactly as the spec sequences it: there is no
 * session, and so no alias, for a search that found nobody.
 */
export async function ensureSearchSession(env, { searchSessionId, userId = null, searchId = null, market = null, ttlMinutes } = {}) {
  const ttl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0 ? Math.trunc(Number(ttlMinutes)) : sessionTtlMinutes(env);
  const id = searchSessionId || newId("ssn");
  if (!hasDatabase(env)) {
    return { id, userId, searchId, market, aliasLibraryVersion: ALIAS_LIBRARY_VERSION, status: "ACTIVE", ttlMinutes: ttl, expiresAt: expiryFrom(ttl), confirmedAt: null };
  }
  await env.DB.prepare(`
    INSERT OR IGNORE INTO search_sessions (id, user_id, search_id, market, alias_library_version, status, ttl_minutes, expires_at)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
  `).bind(id, userId, searchId, market, ALIAS_LIBRARY_VERSION, ttl, expiryFrom(ttl)).run();
  return await getSearchSession(env, id);
}

/**
 * Push the expiry out. Called when a customer reaches checkout: the mapping
 * has to survive card entry, 3-D Secure, and a bank app round trip, and a
 * card that renames itself mid-payment is the failure this whole file exists
 * to avoid.
 */
export async function extendSearchSession(env, searchSessionId, { minutes } = {}) {
  if (!hasDatabase(env)) return null;
  const ttl = Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Math.trunc(Number(minutes)) : sessionTtlMinutes(env);
  await env.DB.prepare(`
    UPDATE search_sessions SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'ACTIVE'
  `).bind(expiryFrom(ttl), searchSessionId).run();
  return await getSearchSession(env, searchSessionId);
}

/** ACTIVE → CONFIRMED | EXPIRED | CANCELLED. */
export async function markSessionStatus(env, searchSessionId, status) {
  if (!hasDatabase(env)) return null;
  if (!["ACTIVE", "CONFIRMED", "EXPIRED", "CANCELLED"].includes(status)) {
    throw new Error(`Unknown search session status "${status}".`);
  }
  await env.DB.prepare(`
    UPDATE search_sessions
    SET status = ?, confirmed_at = CASE WHEN ? = 'CONFIRMED' THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(status, status, searchSessionId).run();
  return await getSearchSession(env, searchSessionId);
}

/** Sweep sessions past their expiry. Mappings stay for the audit window. */
export async function expireStaleSessions(env) {
  if (!hasDatabase(env)) return 0;
  const result = await env.DB.prepare(`
    UPDATE search_sessions SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ACTIVE' AND datetime(expires_at) < datetime('now')
  `).run();
  return Number(result?.meta?.changes || 0);
}

/* ──────────────────────────────────────────────────────── assignment ─── */

function assignmentFromRow(row) {
  return {
    clinicId: row.clinic_id,
    aliasId: row.alias_id,
    slug: row.slug,
    displayName: row.display_name,
    category: row.category,
    assignedAt: row.assigned_at,
    revealedAt: row.revealed_at || null
  };
}

/** Every alias this session has already handed out. */
export async function sessionMapping(env, searchSessionId) {
  if (!hasDatabase(env) || !searchSessionId) return [];
  const result = await env.DB.prepare(`
    SELECT m.*, a.slug, a.display_name, a.category
    FROM search_match_aliases m
    JOIN match_aliases a ON a.id = m.alias_id
    WHERE m.search_session_id = ?
    ORDER BY m.assigned_at, m.clinic_id
  `).bind(searchSessionId).all();
  return result.results.map(assignmentFromRow);
}

/**
 * Assign one alias to each candidate in a search session.
 *
 * Takes clinic *ids* and nothing else about a clinic. `candidateNames` and
 * `nearbyNames` are used only to exclude words that would read as a real
 * business name — never to choose one.
 *
 * Returns `{ sessionId, assignments, byClinicId, unassigned, excludedCount }`.
 * Existing assignments are returned untouched: calling this again for the
 * same session is how a reload gets the same mapping, and how an added
 * candidate gets a new word without disturbing the others.
 */
export async function assignAliases(env, {
  searchSessionId,
  clinicIds,
  serverSecret,
  userId = null,
  searchId = null,
  market = null,
  ttlMinutes,
  candidateNames = [],
  nearbyNames = []
} = {}) {
  const ids = [...new Set((clinicIds || []).map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return { sessionId: searchSessionId || null, assignments: [], byClinicId: {}, unassigned: [], excludedCount: 0 };

  const session = await ensureSearchSession(env, { searchSessionId, userId, searchId, market, ttlMinutes });
  const secret = serverSecretFor(env, serverSecret);
  const seed = `${session.id}|${session.aliasLibraryVersion}`;
  const excludeNames = [...candidateNames, ...nearbyNames].filter(Boolean);

  const existing = await sessionMapping(env, session.id);
  const alreadyMapped = new Map(existing.map((entry) => [entry.clinicId, entry]));
  const usedAliasIds = new Set(existing.map((entry) => entry.aliasId));
  const needed = ids.filter((id) => !alreadyMapped.has(id));

  let excludedCount = 0;
  let pool;
  if (hasDatabase(env)) {
    const denied = await denylistedSlugs(env, market);
    const result = await env.DB.prepare(
      "SELECT id, slug, display_name, category FROM match_aliases WHERE active = 1 AND library_version = ?"
    ).bind(session.aliasLibraryVersion).all();
    pool = result.results
      .map((row) => ({ id: row.id, slug: row.slug, displayName: row.display_name, category: row.category }))
      .filter((alias) => {
        if (usedAliasIds.has(alias.id)) return false;
        if (denied.has(alias.slug)) { excludedCount += 1; return false; }
        if (collidesWithNames(alias.displayName, excludeNames)) { excludedCount += 1; return false; }
        return true;
      });
  } else {
    // No database: the mapping cannot be persisted, so it is derived instead.
    // Demo and local-harness only — a deployment reaching this branch has no
    // way to keep a promise about stability.
    pool = ALIAS_LIBRARY
      .map((alias) => ({ id: `alias_${alias.slug}`, slug: alias.slug, displayName: alias.displayName, category: alias.category }))
      .filter((alias) => {
        if (usedAliasIds.has(alias.id)) return false;
        if (collidesWithNames(alias.displayName, excludeNames)) { excludedCount += 1; return false; }
        return true;
      });
  }

  // Both sides shuffled by the same keyed hash, then zipped. Candidates are
  // ordered by their own hash rather than by the order they arrived, so the
  // ranking the caller applied cannot influence which word anyone gets.
  const shuffledAliases = await keyedShuffle(secret, `${seed}|alias`, pool.map((alias) => alias.slug));
  const aliasBySlugId = new Map(pool.map((alias) => [alias.slug, alias]));
  const shuffledCandidates = await keyedShuffle(secret, `${seed}|clinic`, needed);

  const fresh = [];
  const unassigned = [];
  shuffledCandidates.forEach((clinicId, index) => {
    const slug = shuffledAliases[index];
    if (!slug) { unassigned.push(clinicId); return; }
    fresh.push({ clinicId, alias: aliasBySlugId.get(slug) });
  });

  if (fresh.length && hasDatabase(env)) {
    // INSERT OR IGNORE against PRIMARY KEY(session, clinic) and
    // UNIQUE(session, alias): a concurrent request that got there first keeps
    // its mapping, and this one re-reads rather than renaming anything.
    await env.DB.batch(fresh.map((entry) => env.DB.prepare(`
      INSERT OR IGNORE INTO search_match_aliases (search_session_id, clinic_id, alias_id)
      VALUES (?, ?, ?)
    `).bind(session.id, entry.clinicId, entry.alias.id)));
  }

  const assignments = hasDatabase(env)
    ? await sessionMapping(env, session.id)
    : [...existing, ...fresh.map((entry) => ({
        clinicId: entry.clinicId,
        aliasId: entry.alias.id,
        slug: entry.alias.slug,
        displayName: entry.alias.displayName,
        category: entry.alias.category,
        assignedAt: new Date().toISOString(),
        revealedAt: null
      }))];

  const byClinicId = {};
  for (const entry of assignments) byClinicId[entry.clinicId] = entry;
  return {
    sessionId: session.id,
    aliasLibraryVersion: session.aliasLibraryVersion,
    expiresAt: session.expiresAt,
    persisted: hasDatabase(env),
    assignments: assignments.filter((entry) => ids.includes(entry.clinicId)),
    byClinicId,
    unassigned,
    excludedCount
  };
}

/**
 * Resolve one alias back to the clinic behind it, and record who looked.
 *
 * Two callers: confirmation, which reveals to the customer who just paid, and
 * a support agent assisting an active booking. Both are logged — an
 * unlogged reveal is an unauditable one, and the mapping is exactly the
 * information an insider could sell.
 */
export async function revealMapping(env, { searchSessionId, clinicId, aliasId, actorId = null, actorRole = "support", reason = null, requestId = null } = {}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to resolve a match alias." };
  if (!searchSessionId || (!clinicId && !aliasId)) {
    return { ok: false, code: "REVEAL_TARGET_REQUIRED", message: "A session and a clinic or alias are required." };
  }

  const row = await env.DB.prepare(`
    SELECT m.*, a.slug, a.display_name, a.category
    FROM search_match_aliases m
    JOIN match_aliases a ON a.id = m.alias_id
    WHERE m.search_session_id = ? AND (m.clinic_id = ? OR m.alias_id = ?)
    LIMIT 1
  `).bind(searchSessionId, clinicId || "", aliasId || "").first();
  if (!row) return { ok: false, code: "MAPPING_NOT_FOUND", message: "No alias mapping for that session." };

  await env.DB.prepare(`
    UPDATE search_match_aliases
    SET revealed_at = COALESCE(revealed_at, CURRENT_TIMESTAMP), revealed_to = COALESCE(revealed_to, ?), reveal_reason = COALESCE(reveal_reason, ?)
    WHERE search_session_id = ? AND clinic_id = ?
  `).bind(actorId, reason, searchSessionId, row.clinic_id).run();

  await recordAudit(env, {
    actorId,
    actorRole,
    action: "match_alias.revealed",
    subjectType: "search_session",
    subjectId: searchSessionId,
    newState: { clinicId: row.clinic_id, aliasId: row.alias_id, alias: row.display_name },
    reason,
    requestId
  });

  return { ok: true, mapping: assignmentFromRow(row) };
}

/**
 * Withdraw a word from the library. Never a delete: sessions that already
 * used it must stay readable, which is the difference between retiring an
 * alias and rewriting history.
 */
export async function deactivateAlias(env, { slug, reason, actorId = null }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!reason) return { ok: false, code: "REASON_REQUIRED", message: "Deactivating an alias requires a reason." };
  const alias = aliasBySlug(slug);
  if (!alias) return { ok: false, code: "ALIAS_NOT_FOUND", message: "No such alias." };
  await env.DB.prepare(`
    UPDATE match_aliases SET active = 0, deactivation_reason = ?, deactivated_by = ?, deactivated_at = CURRENT_TIMESTAMP
    WHERE slug = ?
  `).bind(reason, actorId, alias.slug).run();
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "match_alias.deactivated",
    subjectType: "match_alias", subjectId: alias.slug, newState: { active: false }, reason
  });
  return { ok: true, slug: alias.slug };
}

/** Reactivate a previously withdrawn word. */
export async function reactivateAlias(env, { slug, actorId = null, reason = null }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const alias = aliasBySlug(slug);
  if (!alias) return { ok: false, code: "ALIAS_NOT_FOUND", message: "No such alias." };
  await env.DB.prepare(
    "UPDATE match_aliases SET active = 1, deactivation_reason = NULL, deactivated_by = NULL, deactivated_at = NULL WHERE slug = ?"
  ).bind(alias.slug).run();
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "match_alias.reactivated",
    subjectType: "match_alias", subjectId: alias.slug, newState: { active: true }, reason
  });
  return { ok: true, slug: alias.slug };
}

/**
 * Hold a word back without retiring it — globally, or in one market where a
 * real business of that name operates.
 */
export async function denylistAlias(env, { slug, scope = "GLOBAL", market = null, reason, actorId = null }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const alias = aliasBySlug(slug);
  if (!alias) return { ok: false, code: "ALIAS_NOT_FOUND", message: "No such alias." };
  if (!reason) return { ok: false, code: "REASON_REQUIRED", message: "Denylisting an alias requires a reason." };
  if (scope === "MARKET" && !market) return { ok: false, code: "MARKET_REQUIRED", message: "A market-scoped denylist row needs a market." };
  await env.DB.prepare(`
    INSERT OR IGNORE INTO match_alias_denylist (id, alias_slug, scope, market, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(newId("deny"), alias.slug, scope, scope === "MARKET" ? market : "*", reason, actorId).run();
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "match_alias.denylisted",
    subjectType: "match_alias", subjectId: alias.slug, newState: { scope, market }, reason
  });
  return { ok: true, slug: alias.slug, scope, market };
}

/* ─────────────────────────────────────────────────────── the match card ─── */

/** Whether Google-sourced ratings are switched on. Off is a complete card. */
export function ratingModuleEnabled(env) {
  const raw = env?.GOOGLE_RATINGS_ENABLED;
  if (raw === undefined || raw === null || raw === "") return false;
  return String(raw).toLowerCase() === "true" || raw === true || raw === 1;
}

/**
 * The Google rating sub-module, or null.
 *
 * Null in four cases, all of which leave a usable card: the feature flag is
 * off, there is no snapshot, the snapshot has expired, or the upstream call
 * failed. Stale content is never served — an old rating presented as current
 * misstates Google's data, and "it is the last number we saw" is not a
 * defence anybody would accept.
 */
export function googleRatingModule(snapshot, { enabled = false, now = Date.now() } = {}) {
  if (!enabled || !snapshot) return null;
  const rating = Number(snapshot.rating);
  const count = Number(snapshot.userRatingCount ?? snapshot.user_rating_count);
  if (!Number.isFinite(rating) || !Number.isFinite(count)) return null;
  const expiresAt = snapshot.expiresAt || snapshot.expires_at;
  if (expiresAt && Date.parse(expiresAt) <= now) return null;
  return {
    source: "GOOGLE_MAPS",
    rating: Number(rating.toFixed(1)),
    userRatingCount: Math.trunc(count),
    /**
     * The client renders these three inside one container. The attribution is
     * a property of the rating, not of the card: attached to the card as a
     * whole it would appear to say Google supplied the alias, the wait, and
     * the availability, none of which is true.
     */
    attribution: GOOGLE_ATTRIBUTION,
    fetchedAt: snapshot.fetchedAt || snapshot.fetched_at || null,
    sourcePolicyVersion: snapshot.sourcePolicyVersion || snapshot.source_policy_version || null
  };
}

/**
 * The pre-confirmation payload for one candidate.
 *
 * Everything a customer needs to choose; nothing that lets them arrive
 * without Tími, and nothing that identifies the practice. No name, no street,
 * no phone, no website, no photo, no review text, no coordinates, no Google
 * Maps link — §7.8 forbids the last of these specifically, since a maps link
 * both reveals the clinic and implies the alias is a Google place name.
 *
 * City is omitted too, though the spec's leak test does not name it: a
 * category label plus a small city plus a rating is frequently one clinic.
 * Distance and travel time say where to drive without saying where to.
 *
 * `matchToken` is whatever opaque, expiring reference the caller wants the
 * client to send back on selection. Pass an offer id or a signed token —
 * never the clinic id.
 */
export function maskedMatchCard(location, alias, {
  matchToken = null,
  travelMinutes = null,
  ratingSnapshot = null,
  ratingsEnabled = false,
  now = Date.now()
} = {}) {
  const kind = location?.kind || "general";
  const availability = location?.availability || {};
  const google = googleRatingModule(ratingSnapshot, { enabled: ratingsEnabled, now });

  return {
    matchToken,
    alias: {
      id: alias?.aliasId || alias?.id || null,
      slug: alias?.slug || null,
      displayName: alias?.displayName || null,
      /** Persistent, always rendered, never behind a tooltip. */
      label: MATCH_ALIAS_LABEL,
      isTemporaryAlias: true,
      explainer: MATCH_ALIAS_EXPLAINER
    },
    /** Tími's own operational facts. Visually separated from Google's. */
    timinow: {
      kind,
      kindLabel: OFFER_KIND_LABEL[kind] || OFFER_KIND_LABEL.general,
      distanceMiles: location?.distanceMiles ?? null,
      travelMinutes,
      acceptingNow: availability.intakeStatus === "available" || availability.intakeStatus === "limited",
      availabilityStatus: availability.intakeStatus ?? null,
      estimatedWait: {
        minMinutes: availability.stableWaitMin ?? availability.waitMin ?? null,
        maxMinutes: availability.stableWaitMax ?? availability.waitMax ?? null
      },
      acceptsCritical: availability.acceptsCritical ?? null,
      species: location?.species || [],
      capabilities: location?.capabilities || [],
      open24Hours: location?.open24Hours ?? null,
      acceptsWalkIns: location?.acceptsWalkIns ?? null,
      depositAmountCents: location?.policy?.depositAmountCents ?? null,
      baseExamFeeCents: location?.baseExamFeeCents ?? null
    },
    /** Google Maps content, or null when the module is off or stale. */
    google,
    /** Which side of the card each field came from, for the renderer. */
    attributionBoundary: {
      timinow: ["alias", "acceptingNow", "estimatedWait", "capabilities", "species", "distanceMiles", "travelMinutes"],
      googleMaps: google ? ["rating", "userRatingCount"] : []
    },
    revealedOnConfirmation: REVEALED_ON_CONFIRMATION
  };
}

/**
 * Prove a payload identifies nobody.
 *
 * Written as a reusable check rather than a one-off assertion because this is
 * the property that silently breaks: someone adds a field to the offer
 * serializer six months from now and the mask quietly stops masking. Run it
 * over the payload with the real location in hand and it will say so.
 */
export function scanForIdentityLeak(payload, location) {
  const serialized = JSON.stringify(payload ?? null);
  const haystack = normalizeName(serialized);
  const digits = serialized.replace(/\D/g, "");
  const findings = [];

  const check = (condition, field) => { if (condition) findings.push(field); };
  const nameParts = String(location?.name || "").split(/\s+/).filter((part) => part.length > 3);

  check(location?.name && haystack.includes(normalizeName(location.name)), "name");
  check(nameParts.length > 0 && nameParts.every((part) => haystack.includes(normalizeName(part))), "nameWords");
  const phoneDigits = String(location?.phone || "").replace(/\D/g, "");
  check(phoneDigits.length >= 7 && digits.includes(phoneDigits), "phone");
  const street = location?.addressLine1 || location?.address_line1;
  check(street && haystack.includes(normalizeName(street)), "address");
  check(location?.address && haystack.includes(normalizeName(location.address)), "address");
  check(location?.website && haystack.includes(normalizeName(location.website)), "website");
  check(/https?:\/\//.test(serialized), "url");
  check(/maps\.google|google\.com\/maps|goo\.gl\/maps|googlemapsuri|place_id|placeid/i.test(serialized), "googleMapsLink");
  check(/"(photo|photos|photoUri|reviews?|reviewText|editorialSummary)"\s*:/i.test(serialized), "photoOrReview");
  for (const key of ["latitude", "longitude", "clinicId", "locationId", "tenantId", "providerPlaceId"]) {
    check(new RegExp(`"${key}"\\s*:`).test(serialized), key);
  }
  return { ok: findings.length === 0, findings };
}
