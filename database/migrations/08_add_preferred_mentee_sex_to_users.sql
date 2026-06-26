-- 08_add_preferred_mentee_sex_to_users.sql
-- ============================================================
-- PURPOSE
-- ============================================================
-- Separates a mentor's "who I want to mentor" preference from
-- their biological sex (users.sex).
--
-- users.sex              → the person's biological sex (M/F/prefer_not).
--                          Set at registration. NEVER changed elsewhere.
-- users.preferred_mentee_sex → mentor-only field. Controls which
--                          mentees can see this mentor in the browse list.
--   'M'          → visible only to male mentees
--   'F'          → visible only to female mentees
--   'prefer_not' → visible to BOTH male and female mentees
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_mentee_sex TEXT
  CHECK (preferred_mentee_sex IN ('M', 'F', 'prefer_not'));

-- Backfill existing mentors: the old code wrote the preference
-- into users.sex (overwriting biological sex), so copy it across.
-- Non-mentor users get NULL (column is not used for them).
UPDATE users
SET    preferred_mentee_sex = sex
WHERE  role = 'mentor'
  AND  sex IS NOT NULL;

-- Index for fast lookups in the mentor browse query
CREATE INDEX IF NOT EXISTS idx_users_preferred_mentee_sex
  ON users (preferred_mentee_sex)
  WHERE role = 'mentor';
