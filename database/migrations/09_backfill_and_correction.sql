-- 09_backfill_and_correction.sql

-- 1. IDENTIFICATION QUERY
-- This query helps identify mentors whose biological sex (users.sex) was overwritten by their application preference.
-- We do this by listing all active mentors, their current users.sex, and their latest approved application sex preference.
-- If the current users.sex is 'prefer_not', it is definitely overwritten and needs correction, as 'prefer_not' is not a valid biological sex for mentors.
SELECT 
    u.telegram_id, 
    u.anonymous_id, 
    u.sex AS current_biological_sex_value,
    la.app_sex AS applied_mentee_preference,
    CASE 
        WHEN u.sex = 'prefer_not' THEN '⚠️ Overwritten (Needs Correction - Change from Both to actual biological sex)'
        ELSE '⚠️ Potentially Overwritten (Verify if correct biological sex)'
    END AS status_check
FROM users u
LEFT JOIN (
    SELECT DISTINCT ON (telegram_id) 
        telegram_id, 
        sex AS app_sex
    FROM mentor_applications
    WHERE status = 'approved'
    ORDER BY telegram_id, submitted_at DESC
) la ON u.telegram_id = la.telegram_id
WHERE u.role = 'mentor';


-- 2. AUTOMATIC PREFERENCE BACKFILL
-- Set the preferred_mentee_sex for all existing mentors based on their latest approved application's sex selection.
-- If they do not have a recorded application, it defaults to 'both'.
-- Note: PostgreSQL automatically sets existing users to 'both' upon column creation due to DEFAULT 'both',
-- so we only need to update those who had an approved application.
WITH latest_applications AS (
    SELECT DISTINCT ON (telegram_id) 
        telegram_id, 
        sex AS app_sex
    FROM mentor_applications
    WHERE status = 'approved'
    ORDER BY telegram_id, submitted_at DESC
)
UPDATE users u
SET preferred_mentee_sex = CASE 
    WHEN la.app_sex = 'prefer_not' THEN 'both'
    ELSE COALESCE(la.app_sex, 'both')
END
FROM latest_applications la
WHERE u.telegram_id = la.telegram_id
  AND u.role = 'mentor';


-- 3. MANUAL CORRECTION TEMPLATE
-- The administrator must manually run this query for each mentor whose biological sex was overwritten,
-- replacing <ACTUAL_SEX> with 'M' (Male) or 'F' (Female), and <TELEGRAM_ID> with the mentor's telegram_id.
--
-- UPDATE users 
-- SET sex = '<ACTUAL_SEX_M_OR_F>' 
-- WHERE telegram_id = <TELEGRAM_ID> AND role = 'mentor';
