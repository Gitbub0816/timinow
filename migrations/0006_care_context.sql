PRAGMA foreign_keys = ON;

-- Two additions, both about telling a clinic something true before the animal
-- arrives.
--
-- 1. Optional medications and allergies on the animal.
--
--    Free text, never required, and never a medical record: Tími is not a
--    records system and does not receive anything from a veterinarian. It is
--    what the owner chose to type, passed along verbatim so a receptionist is
--    not hearing "he's on something for his heart, I forget what" down a phone
--    line. The clinic still confirms everything at the door.
--
--    Stored on the search and on the intake rather than only on the device,
--    because the clinic that has to read it is on the other side of both.
--
-- 2. Which credential staffs a location.
--
--    A location run by a veterinary technician is not the same offer as one
--    with a veterinarian on the floor. Technicians work under veterinarian
--    supervision and, in every US state, may not diagnose, prognose, prescribe
--    or perform surgery — so a customer choosing between offers has to be able
--    to see it, and it has to be set by a platform operator when the provider
--    is created, not self-declared.

ALTER TABLE care_searches ADD COLUMN medications TEXT;
ALTER TABLE care_searches ADD COLUMN allergies TEXT;

ALTER TABLE intake_requests ADD COLUMN medications TEXT;
ALTER TABLE intake_requests ADD COLUMN allergies TEXT;

-- SQLite cannot add a CHECK constraint to an existing table, so the allowed
-- values are enforced in the Worker (VALID_STAFFING in src/catalog.js) rather
-- than declared here. The default keeps every existing location a
-- veterinarian-staffed one, which is what they were before this column
-- existed.
ALTER TABLE locations ADD COLUMN staffing_level TEXT NOT NULL DEFAULT 'veterinarian';

-- An operator's own words, shown alongside the standard notice. Optional: the
-- standard notice is the part that has to be right.
ALTER TABLE locations ADD COLUMN staffing_note TEXT;
