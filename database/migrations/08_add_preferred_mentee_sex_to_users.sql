-- ============================================================
-- Migration 08: Add preferred_mentee_sex column to users table
-- ============================================================
-- This separates the mentor's OWN biological sex (users.sex)
-- from the mentor's PREFERENCE about which mentees they want
-- to work with (users.preferred_mentee_sex).
--
-- Values: 'M'  → mentors male mentees only
--         'F'  → mentors female mentees only
--         'prefer_not' → mentors both / no preference
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_mentee_sex TEXT
    CHECK (preferred_mentee_sex IN ('M', 'F', 'prefer_not'));

-- Index for fast filtering in the mentors list query
CREATE INDEX IF NOT EXISTS idx_users_preferred_mentee_sex
  ON users (preferred_mentee_sex)
  WHERE role = 'mentor';

COMMENT ON COLUMN users.preferred_mentee_sex IS
  'Mentor preference: which mentee sex they want to work with.
   M = male mentees only, F = female mentees only,
   prefer_not = both / no preference.
   Populated when an application is approved.
   Never changes users.sex (biological sex).';
