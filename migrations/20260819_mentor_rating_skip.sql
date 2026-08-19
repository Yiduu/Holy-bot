BEGIN;

-- Mentor rating popup: "Skip" must be sticky per mentorship assignment
--
-- Previously, clicking Skip only closed the modal client-side. The
-- /api/users/pending-rating endpoint had no way to know the mentee had
-- already dismissed the prompt, so it kept returning the same ended
-- assignment as "pending" and the popup reappeared on every subsequent
-- page load / session until the mentee actually submitted a rating.
--
-- rating_skipped_at records when the mentee explicitly skipped rating
-- this specific assignment. Once set, pending-rating excludes it, same
-- as when a rating exists. A brand new assignment (reassignment / new
-- mentor) always starts with rating_skipped_at = NULL, so the popup
-- correctly appears again for the new mentorship.
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS rating_skipped_at TIMESTAMPTZ;

COMMIT;
