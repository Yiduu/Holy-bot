BEGIN;

-- Goal tracking: real-time notifications + "missed" flag
--
-- Adds what's needed for the daily due-date reminder job and the
-- "flag as missed" behavior to run without re-sending duplicate
-- reminders or re-flagging a goal that's already been flagged:
--
--   1. is_missed            — true once a goal's due_date has passed
--                              without it being marked done. Cleared
--                              automatically if the mentor pushes the
--                              due date out or the mentee completes it.
--   2. missed_flagged_at    — when it was flagged, for display/audit.
--   3. last_reminder_sent_on — the (Ethiopia-local) date the "due soon"
--                              reminder last went out for this goal, so
--                              the once-daily scheduler tick never sends
--                              the same reminder twice in one day.

ALTER TABLE mentor_mentee_goals ADD COLUMN IF NOT EXISTS is_missed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mentor_mentee_goals ADD COLUMN IF NOT EXISTS missed_flagged_at TIMESTAMPTZ;
ALTER TABLE mentor_mentee_goals ADD COLUMN IF NOT EXISTS last_reminder_sent_on DATE;

-- Powers both the "due within 48h" reminder query and the "overdue,
-- not done, not yet flagged" missed-goal sweep — both filter on
-- due_date + is_done, so a composite index keeps the daily scheduler
-- tick cheap even as the table grows.
CREATE INDEX IF NOT EXISTS idx_mentor_mentee_goals_due_open
  ON mentor_mentee_goals(due_date, is_done)
  WHERE is_done = false;

COMMIT;
