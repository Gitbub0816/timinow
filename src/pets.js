/**
 * A customer's animals, kept with the account rather than with the phone.
 *
 * They lived in UserDefaults and nowhere else. That made them a property of a
 * device: reinstall, replace the phone, or sign in on a second one and they
 * were gone, and somebody had to retype a name, a species, a weight and
 * whatever medications they had recorded — at the moment they were trying to
 * get a sick animal seen.
 *
 * ## Ids come from the client
 *
 * A pet is created on the phone, possibly with no network, and is referred to
 * by that id in the draft the person is already filling in. Minting a new id
 * here would mean the phone holding two identities for one animal and having
 * to reconcile them. So the client's id is the id, and every write is scoped
 * to the owner — an id somebody else already holds is refused rather than
 * overwritten.
 *
 * ## Deletes are soft
 *
 * A pet removed on one phone has to stay removed on the other one, and a row
 * that is simply gone cannot tell a device that has been offline since before
 * the deletion that anything happened. `deleted_at` is what a second device
 * reads to remove its own copy.
 *
 * ## Not a medical record
 *
 * Same rule as `care_searches.medications`: this is what the owner typed,
 * stored as they typed it. Nothing here comes from a veterinarian, none of it
 * is verified, and no clinic may rely on it in place of its own history.
 */

import { VALID_SPECIES } from "./catalog.js";

const MAX_PETS = 99;

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function optionalNumber(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) return undefined;
  return number;
}

export function normalizePetRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    breed: row.breed || "",
    sex: row.sex || "",
    weightLbs: row.weight_lbs === null || row.weight_lbs === undefined ? null : Number(row.weight_lbs),
    birthYear: row.birth_year === null || row.birth_year === undefined ? null : Number(row.birth_year),
    colorToken: Number(row.color_token || 0),
    medications: row.medications || "",
    allergies: row.allergies || "",
    updatedAt: row.updated_at
  };
}

/**
 * Whether a body describes a pet Tími will store, and what it stores.
 *
 * Returns `{ ok: true, pet }` or `{ ok: false, code, message }`. Kept separate
 * from the HTTP layer so the tests can call it directly and so the same rules
 * apply to a single write and to a bulk sync.
 */
export function validatePet(body, { id } = {}) {
  const petId = text(id ?? body?.id, 80);
  if (!petId) return { ok: false, code: "PET_ID_REQUIRED", message: "A pet needs an id." };

  const name = text(body?.name, 60);
  if (!name) return { ok: false, code: "PET_NAME_REQUIRED", message: "Give your pet a name." };

  const species = text(body?.species, 30).toLowerCase();
  if (!VALID_SPECIES.has(species)) {
    return { ok: false, code: "INVALID_SPECIES", message: "Choose a species Tími supports." };
  }

  // `undefined` from optionalNumber means "present and out of range", which is
  // a refusal; `null` means "not supplied", which is normal — most pets have
  // no weight recorded and none of this is required.
  const weightLbs = optionalNumber(body?.weightLbs, 0.1, 400);
  if (weightLbs === undefined) {
    return { ok: false, code: "INVALID_WEIGHT", message: "Weight must be between 0.1 and 400 pounds." };
  }
  const thisYear = new Date().getUTCFullYear();
  const birthYear = optionalNumber(body?.birthYear, 1970, thisYear);
  if (birthYear === undefined) {
    return { ok: false, code: "INVALID_BIRTH_YEAR", message: `Birth year must be between 1970 and ${thisYear}.` };
  }

  const sex = text(body?.sex, 10) || null;
  if (sex !== null && !["male", "female", "unknown"].includes(sex)) {
    return { ok: false, code: "INVALID_SEX", message: "Sex must be male, female, or unknown — or left out." };
  }

  return {
    ok: true,
    pet: {
      id: petId,
      name,
      species,
      breed: text(body?.breed, 80) || null,
      sex,
      weightLbs,
      birthYear: birthYear === null ? null : Math.round(birthYear),
      colorToken: Math.max(0, Math.min(9, Math.round(Number(body?.colorToken) || 0))),
      medications: text(body?.medications, 500) || null,
      allergies: text(body?.allergies, 500) || null
    }
  };
}

export async function listPets(env, clerkUserId) {
  const result = await env.DB.prepare(`
    SELECT * FROM pets
    WHERE clerk_user_id = ? AND deleted_at IS NULL
    ORDER BY datetime(created_at)
  `).bind(clerkUserId).all();
  return result.results.map(normalizePetRow);
}

async function countPets(env, clerkUserId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM pets WHERE clerk_user_id = ? AND deleted_at IS NULL"
  ).bind(clerkUserId).first();
  return Number(row?.total || 0);
}

/**
 * Writes one pet, creating it or replacing it.
 *
 * The `WHERE clerk_user_id = ?` on the conflict branch is the ownership check.
 * Without it, anyone who learned another account's pet id could overwrite that
 * pet by writing to it — the insert would conflict and the update would run
 * regardless of whose row it was.
 */
export async function savePet(env, clerkUserId, pet) {
  const existing = await env.DB.prepare("SELECT clerk_user_id, deleted_at FROM pets WHERE id = ? LIMIT 1")
    .bind(pet.id).first();
  if (existing && existing.clerk_user_id !== clerkUserId) {
    return { ok: false, status: 409, code: "PET_ID_TAKEN", message: "That pet id already belongs to another account." };
  }
  if (!existing && await countPets(env, clerkUserId) >= MAX_PETS) {
    return { ok: false, status: 422, code: "TOO_MANY_PETS", message: `Tími keeps up to ${MAX_PETS} pets on an account.` };
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO pets (
      id, clerk_user_id, name, species, breed, sex, weight_lbs, birth_year,
      color_token, medications, allergies, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      species = excluded.species,
      breed = excluded.breed,
      sex = excluded.sex,
      weight_lbs = excluded.weight_lbs,
      birth_year = excluded.birth_year,
      color_token = excluded.color_token,
      medications = excluded.medications,
      allergies = excluded.allergies,
      -- Writing a pet that was deleted brings it back. Editing something you
      -- can still see on a second device should not silently do nothing.
      deleted_at = NULL,
      updated_at = excluded.updated_at
    WHERE pets.clerk_user_id = ?
  `).bind(
    pet.id, clerkUserId, pet.name, pet.species, pet.breed, pet.sex, pet.weightLbs, pet.birthYear,
    pet.colorToken, pet.medications, pet.allergies, now, now, clerkUserId
  ).run();

  const row = await env.DB.prepare("SELECT * FROM pets WHERE id = ? AND clerk_user_id = ? LIMIT 1")
    .bind(pet.id, clerkUserId).first();
  return { ok: true, pet: normalizePetRow(row) };
}

export async function removePet(env, clerkUserId, petId) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE pets SET deleted_at = ?, updated_at = ? WHERE id = ? AND clerk_user_id = ? AND deleted_at IS NULL"
  ).bind(now, now, petId, clerkUserId).run();
  // A pet that is already gone is not an error: two devices can both delete
  // it, and the second one has got what it asked for.
  return { ok: true, removed: Boolean(result.meta?.changes) };
}

/**
 * The first sign-in after this shipped.
 *
 * Somebody already has pets on their phone and no row anywhere. This takes the
 * local set, stores whatever is not stored yet, and answers with everything
 * the account holds — so upgrading keeps the animals that were already there
 * instead of quietly replacing them with nothing.
 *
 * Local copies never overwrite a stored pet: another device may have edited it
 * since, and a stale copy from a phone that has been in a pocket for a week is
 * the wrong winner. New pets are added, known ones are left alone.
 */
export async function syncPets(env, clerkUserId, localPets) {
  const incoming = Array.isArray(localPets) ? localPets.slice(0, MAX_PETS) : [];
  const stored = await listPets(env, clerkUserId);
  const known = new Set(stored.map((pet) => pet.id));
  // Deleted ones are known too, or every sync would resurrect a pet that was
  // removed on another device.
  const deleted = await env.DB.prepare(
    "SELECT id FROM pets WHERE clerk_user_id = ? AND deleted_at IS NOT NULL"
  ).bind(clerkUserId).all();
  for (const row of deleted.results) known.add(row.id);

  const rejected = [];
  for (const candidate of incoming) {
    const validation = validatePet(candidate);
    if (!validation.ok) { rejected.push({ id: candidate?.id ?? null, code: validation.code }); continue; }
    if (known.has(validation.pet.id)) continue;
    const saved = await savePet(env, clerkUserId, validation.pet);
    if (!saved.ok) rejected.push({ id: validation.pet.id, code: saved.code });
  }

  return { pets: await listPets(env, clerkUserId), rejected };
}
