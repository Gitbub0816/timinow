PRAGMA foreign_keys = ON;

-- Where a customer's animals live.
--
-- They lived in the phone's UserDefaults and nowhere else, which meant they
-- were a property of a device rather than of an account: reinstall the app,
-- change phone, or sign in on a second one, and the pets were simply gone —
-- and the person had to retype a name, a species, a weight and whatever
-- medications they had bothered to record, at the moment they were trying to
-- get a sick animal seen. Nothing was broken. There was just nowhere for them
-- to be.
--
-- Deliberately not a medical record. The same rule as care_searches.medications
-- (see 0006): this is what the owner typed, stored as they typed it, and no
-- clinic may rely on it in place of its own history-taking.

CREATE TABLE IF NOT EXISTS pets (
  id TEXT PRIMARY KEY,
  -- Clerk's user id. Not a foreign key: Tími has no users table — Clerk is the
  -- register of people — so there is nothing here to point at.
  clerk_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Checked against VALID_SPECIES in the Worker rather than by a CHECK
  -- constraint, so adding a species is a deploy and not a table rebuild.
  species TEXT NOT NULL,
  breed TEXT,
  weight_lbs REAL,
  birth_year INTEGER,
  -- Which of the two card colours this pet is drawn in. Cosmetic, and
  -- travelling with the pet so it looks the same on a new phone.
  color_token INTEGER NOT NULL DEFAULT 0,
  medications TEXT,
  allergies TEXT,
  -- Soft delete. A pet removed on one phone has to stay removed on the other
  -- one, and a row that is gone cannot say so to a device that has been
  -- offline since before it was deleted.
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The only query this table serves: every pet for one person, newest first.
CREATE INDEX IF NOT EXISTS idx_pets_owner ON pets(clerk_user_id, deleted_at, datetime(created_at));
