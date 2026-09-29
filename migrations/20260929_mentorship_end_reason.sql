BEGIN;

-- Why a mentorship ended, and who ended it.
--
-- A mentee who wants to become a mentor now has to end their current
-- mentorship first, rate the mentor, and say why they're leaving. The reason
-- is stored on the assignment row so admins can read it later.
--
-- ended_by is 'mentee', 'mentor' or 'system' (system = closed automatically
-- when the person was promoted to mentor). Old rows stay NULL.
--
-- Safe to run more than once. The backend falls back to the old two-column
-- update if this hasn't been run yet, so deploy order doesn't matter.
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS end_reason TEXT;
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS ended_by   TEXT;

COMMIT;
