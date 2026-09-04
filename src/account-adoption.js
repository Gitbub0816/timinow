/**
 * Post-booking account conversion.
 *
 * A guest who searched, was offered care, paid, and booked with nothing more
 * than a phone number can "Save your info" once they verify that phone
 * through Clerk (see the phone-code sign-in flow already wired in
 * public/app.js). Adopting merges every row the guest session owns — pets,
 * intakes, care searches — onto the now-authenticated Clerk user.
 */

import { hasDatabase } from "./db.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Moves every intake, care search, and pet a guest session owns onto a
 * verified Clerk user, and records the merge.
 *
 * Idempotent by construction, not merely by intent: a second call for the
 * same `(guestId, clerkUserId)` pair finds the `account_adoptions` row from
 * the first call and returns its counts unchanged rather than re-running the
 * UPDATEs — which matters because a naive retry would find nothing left
 * owned by the guest id (the first call already moved it) and report zero
 * rows adopted, reading as "nothing was ever here" instead of "already
 * done". A doubled tap on "Save your info", or a retried request after a
 * flaky connection, is therefore a no-op rather than a second audit entry.
 */
export async function adoptGuestSession(env, actor, guestId) {
  if (!actor?.authenticated) return { ok: false, status: 401, code: "AUTHENTICATION_REQUIRED", message: "Sign in to save your info." };
  if (!guestId || !String(guestId).startsWith("guest_")) return { ok: false, status: 422, code: "GUEST_SESSION_REQUIRED", message: "No guest session to save. Nothing to adopt." };
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to save your info." };

  const clerkUserId = actor.userId;
  const existing = await env.DB.prepare(
    "SELECT * FROM account_adoptions WHERE guest_id = ? AND clerk_user_id = ? LIMIT 1"
  ).bind(guestId, clerkUserId).first();
  if (existing) {
    return {
      ok: true,
      alreadyAdopted: true,
      counts: { intakes: existing.intakes_adopted, searches: existing.searches_adopted, pets: existing.pets_adopted }
    };
  }

  const [intakesResult, searchesResult, petsResult] = await env.DB.batch([
    env.DB.prepare("UPDATE intake_requests SET customer_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_user_id = ?")
      .bind(clerkUserId, guestId),
    env.DB.prepare("UPDATE care_searches SET customer_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_user_id = ?")
      .bind(clerkUserId, guestId),
    // A pet's id is chosen by the client and unique across the whole table
    // (see src/pets.js), so a guest pet can never collide with one the
    // destination account already owns — reassigning the owner column alone
    // is safe, with nothing else to reconcile.
    env.DB.prepare("UPDATE pets SET clerk_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE clerk_user_id = ?")
      .bind(clerkUserId, guestId)
  ]);

  const counts = {
    intakes: intakesResult.meta?.changes || 0,
    searches: searchesResult.meta?.changes || 0,
    pets: petsResult.meta?.changes || 0
  };

  await env.DB.prepare(`
    INSERT INTO account_adoptions (id, guest_id, clerk_user_id, intakes_adopted, searches_adopted, pets_adopted)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(newId("adoption"), guestId, clerkUserId, counts.intakes, counts.searches, counts.pets).run();

  return { ok: true, alreadyAdopted: false, counts };
}
