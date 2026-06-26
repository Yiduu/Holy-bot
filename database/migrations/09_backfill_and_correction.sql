-- 09_backfill_and_correction.sql
-- ============================================================
-- Correctness guard after migration 08.
-- ============================================================
-- Some mentors may have had their users.sex field overwritten
-- by the old admin approval logic (it wrote the "preference"
-- value into users.sex).  We cannot recover the true biological
-- sex from the DB at this point, but we CAN ensure the preference
-- column is always populated for every mentor, defaulting to
-- 'prefer_not' (visible to both sexes) when no preference was set.
-- ============================================================

-- Ensure every mentor has a preferred_mentee_sex value.
-- Mentors with no preference default to 'prefer_not' (both sexes).
UPDATE users
SET    preferred_mentee_sex = 'prefer_not'
WHERE  role = 'mentor'
  AND  preferred_mentee_sex IS NULL;

-- Safety: ensure the check constraint is in place (idempotent).
-- (Supabase/Postgres does not support ALTER CONSTRAINT, so we
--  only add if the column was created without it somehow.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.check_constraints
    WHERE  constraint_name LIKE '%preferred_mentee_sex%'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_preferred_mentee_sex_check
      CHECK (preferred_mentee_sex IN ('M', 'F', 'prefer_not'));
  END IF;
END;
$$;
