BEGIN;

-- Per-task reminders for challenge goals.
--
--   goal_tasks.remind_at            Ethiopia local time this task should be
--                                   reminded at. NULL = no per-task reminder;
--                                   the task then follows the goal's old daily
--                                   reminder (goals.reminder_time) exactly as
--                                   before, so existing challenges are unchanged.
--   goal_tasks.task_reminder_sent_on  The (Ethiopia) date the per-task reminder
--                                   was claimed. Separate from
--                                   last_reminder_sent_on (daily reminder) so the
--                                   two paths can never overwrite each other.
--   goals.final_reminder_sent_on    The date the 11:00 PM "still unfinished"
--                                   reminder went out for the goal: once a day.
--
-- No duplicates: the daily reminder job ignores any task that has remind_at,
-- and both new reminders are claimed with a conditional UPDATE before sending.

ALTER TABLE goal_tasks ADD COLUMN IF NOT EXISTS remind_at TIME;
ALTER TABLE goal_tasks ADD COLUMN IF NOT EXISTS task_reminder_sent_on DATE;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS final_reminder_sent_on DATE;

CREATE INDEX IF NOT EXISTS idx_goal_tasks_remind_pending
  ON goal_tasks(due_date)
  WHERE status = 'pending' AND remind_at IS NOT NULL;

COMMIT;
