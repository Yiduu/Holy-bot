-- ============================================================
-- Migration 09: Backfill preferred_mentee_sex + data correction
-- ============================================================
-- Run AFTER migration 08.
-- ============================================================

-- ── Step 1: Backfill from latest APPROVED application ────────
-- For each mentor, find their most-recently-approved application
-- and copy its `sex` value (= the preference they submitted) into
-- the new preferred_mentee_sex column.
UPDATE users u
SET preferred_mentee_sex = sub.app_sex
FROM (
  SELECT DISTINCT ON (telegram_id)
         telegram_id,
         sex AS app_sex
  FROM   mentor_applications
  WHERE  status = 'approved'
    AND  sex IS NOT NULL
  ORDER  BY telegram_id, reviewed_at DESC NULLS LAST
) sub
WHERE u.telegram_id = sub.telegram_id
  AND u.role        = 'mentor'
  AND u.preferred_mentee_sex IS NULL;   -- only fill missing rows

-- ── Step 2: Default remaining mentors to 'prefer_not' ────────
-- Any mentor still missing a preference (no approved application
-- found, or application had no sex value) gets the safe default.
UPDATE users
SET preferred_mentee_sex = 'prefer_not'
WHERE role              = 'mentor'
  AND preferred_mentee_sex IS NULL;

-- ── Step 3: Undo sex-corruption from old approval logic ───────
-- The old admin.js wrote app.sex → users.sex, potentially
-- overwriting a mentor's biological sex with their PREFERENCE.
--
-- We cannot perfectly recover the original biological sex without
-- a separate data source.  The safest automated fix is to set
-- users.sex = 'prefer_not' (unknown) for mentors whose sex was
-- suspiciously overwritten — i.e. where users.sex now equals
-- preferred_mentee_sex AND the value is 'M' or 'F', because a
-- genuine biological sex of M/F is fine; the problem is only
-- when the preference was blindly copied.
--
-- ACTION REQUIRED: Review the output of the diagnostic query
-- below and manually correct any mentor whose biological sex
-- you know has been corrupted.

-- ── Diagnostic: Identify potentially corrupted rows ──────────
-- Run this SELECT to see which mentors may need manual review.
-- (Does NOT modify data.)
SELECT
    u.telegram_id,
    u.anonymous_id,
    u.sex                   AS stored_biological_sex,
    u.preferred_mentee_sex  AS mentee_preference,
    ma.sex                  AS application_preference,
    ma.reviewed_at
FROM  users u
LEFT JOIN LATERAL (
    SELECT sex, reviewed_at
    FROM   mentor_applications
    WHERE  telegram_id = u.telegram_id
      AND  status      = 'approved'
    ORDER  BY reviewed_at DESC NULLS LAST
    LIMIT  1
) ma ON true
WHERE u.role = 'mentor'
ORDER BY u.telegram_id;

-- ── Manual correction template ────────────────────────────────
-- Use this pattern to fix any individual mentor whose biological
-- sex was overwritten.  Replace <TELEGRAM_ID> and <REAL_SEX>:
--
-- UPDATE users
-- SET sex = '<REAL_SEX>'   -- 'M', 'F', or 'prefer_not'
-- WHERE telegram_id = <TELEGRAM_ID>;
