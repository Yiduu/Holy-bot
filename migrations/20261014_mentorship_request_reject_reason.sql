BEGIN;

-- Why a mentor declined a mentorship request. Shown to the mentee in the
-- Telegram notification. Cleared again when the mentee re-requests.
--
-- Safe to run more than once. The backend retries without this column if it
-- has not been run yet, so deploy order does not matter.
ALTER TABLE mentorship_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT;

COMMIT;
