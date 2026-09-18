-- Who wrote it, what they are qualified in, and who checked it.
--
-- Veterinary content is YMYL — "your money or your life" — and both search
-- engines and the assistants reading them hold it to a visibly higher bar than
-- other subjects. The single largest quality lever available to this blog is
-- not another paragraph: it is a named veterinarian, with a credential,
-- attached to anything clinical.
--
-- The blog already freezes a byline at publish time (see 0031). These columns
-- extend that with the two facts that matter for a health topic and are
-- otherwise unrepresentable:
--
--   author_credentials      what the author is, e.g. "DVM" or "RVT". Free
--                           text, because credential letters vary by state and
--                           by country and an enum here would be wrong within
--                           a year.
--   reviewer_name           a veterinarian who read it and stands behind it,
--   reviewer_credentials    with their letters, and
--   reviewed_at             when — because "reviewed" with no date is a claim
--                           about the present made in the past.
--
-- All four are nullable and stay null for the non-clinical posts, which is
-- most of what is published here. Nothing infers or defaults them: a review
-- line that appears because a column defaulted is a false statement about a
-- real person, and this is the one place in the schema where that would be
-- actively dangerous.
ALTER TABLE blog_posts ADD COLUMN author_credentials TEXT;
ALTER TABLE blog_posts ADD COLUMN reviewer_name TEXT;
ALTER TABLE blog_posts ADD COLUMN reviewer_credentials TEXT;
ALTER TABLE blog_posts ADD COLUMN reviewed_at TEXT;
