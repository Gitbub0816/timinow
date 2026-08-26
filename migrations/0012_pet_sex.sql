PRAGMA foreign_keys = ON;

-- The pet's sex, asked during onboarding. Nullable: plenty of owners of a
-- newly rescued animal genuinely don't know, and a question that cannot be
-- skipped is a question that gets answered wrong.
ALTER TABLE pets ADD COLUMN sex TEXT CHECK (sex IN ('male', 'female', 'unknown'));
