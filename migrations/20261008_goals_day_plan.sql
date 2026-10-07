BEGIN;

-- Per-day challenge plans: the mentor can give every calendar day its own
-- tasks (or none, for a rest day) instead of repeating one daily template.
-- The tasks themselves live in goal_tasks as before; this flag only tells
-- the API not to repeat a template when a challenge's end date is extended.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS custom_days BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
