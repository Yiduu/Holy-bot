BEGIN;

-- Goals v2: one-time tasks, progressive tasks and day-by-day challenges
--
-- Replaces the flat mentor_mentee_goals checklist with two tables:
--
--   goals       — the thing the mentor sets (a one-time task, a progressive
--                 "do it N times" task, or a dated challenge such as a
--                 30-day program).
--   goal_tasks  — the individually trackable items under a goal. A one-time
--                 goal has one task, a progressive goal has N, and a
--                 challenge has one task per task-template entry per
--                 calendar day.
--
-- Rules the schema supports (the API enforces the timing rules):
--   • Mentees can only tick today's task (one-time tasks: until their
--     due date). Past days are closed; only the mentor can reopen them.
--   • A pending task whose due_date has passed is flipped to 'missed' by
--     goal_sweep_missed(), safe to call every few minutes, so a server
--     restart never skips a night.
--   • A missed day breaks the streak. Days already done are never wiped.
--   • Every completion can carry a short note from the mentee.
--
-- "Today" is always passed in by the caller (Ethiopia date, see
-- utils/goalRules.js), never read from the database clock, so the app and
-- the database cannot disagree about what "passed" means.
--
-- The old mentor_mentee_goals table is left untouched. Existing rows are
-- copied across with the SAME id, so Telegram deep links
-- (start=goal_<id>) and "Mark as done" buttons keep working. Drop the old
-- table only after the API has been switched over.

CREATE TABLE IF NOT EXISTS goals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mentor_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mentee_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('one_time', 'progressive', 'challenge')),
  title          TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description    TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  start_date     DATE,
  end_date       DATE,
  target_count   INT CHECK (target_count IS NULL OR target_count BETWEEN 1 AND 1000),
  -- Challenge only: the tasks created for every day, e.g. ["Prayer","Journal entry"]
  task_template  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Ethiopia local time of the daily reminder; NULL = no daily reminder
  reminder_time  TIME,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT goals_challenge_dates CHECK (
    type <> 'challenge'
    OR (start_date IS NOT NULL AND end_date IS NOT NULL
        AND end_date >= start_date AND end_date - start_date <= 365)
  ),
  CONSTRAINT goals_progressive_target CHECK (
    type <> 'progressive' OR target_count IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS goal_tasks (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  goal_id               UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  -- Denormalised from goals so per-person queries and realtime pushes
  -- need no join.
  mentor_id             BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mentee_id             BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  title                 TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  position              INT NOT NULL DEFAULT 0,
  due_date              DATE,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'done', 'missed', 'skipped')),
  completed_at          TIMESTAMPTZ,
  completed_by          BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  -- Short note the mentee can attach when completing the task
  note                  TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  note_at               TIMESTAMPTZ,
  missed_flagged_at     TIMESTAMPTZ,
  reopened_at           TIMESTAMPTZ,
  reopened_by           BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  last_reminder_sent_on DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Makes challenge generation idempotent: re-running it can't duplicate a day.
  CONSTRAINT goal_tasks_unique_slot UNIQUE (goal_id, due_date, position)
);

CREATE INDEX IF NOT EXISTS idx_goals_pair
  ON goals(mentor_id, mentee_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_mentee_active
  ON goals(mentee_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_goal_tasks_goal_due
  ON goal_tasks(goal_id, due_date, position);
CREATE INDEX IF NOT EXISTS idx_goal_tasks_mentee_due
  ON goal_tasks(mentee_id, due_date);
-- Powers the missed-task sweep and the reminder query: only open tasks.
CREATE INDEX IF NOT EXISTS idx_goal_tasks_pending_due
  ON goal_tasks(due_date) WHERE status = 'pending';

-- Same posture as the rest of the schema: the backend uses the service
-- role, which bypasses RLS; no policies means no direct client access.
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_tasks ENABLE ROW LEVEL SECURITY;

-- ─── Missed-task sweep ──────────────────────────────────────────────────
-- Flips every pending task whose due date is before p_today to 'missed' in
-- one atomic statement and returns the rows it changed, so the caller can
-- send exactly one notification per newly-missed task. Re-running it
-- returns nothing new, so it is safe on a short interval and after downtime.
CREATE OR REPLACE FUNCTION goal_sweep_missed(p_today DATE)
RETURNS SETOF goal_tasks
LANGUAGE sql
AS $$
  UPDATE goal_tasks t
     SET status = 'missed',
         missed_flagged_at = NOW(),
         updated_at = NOW()
   WHERE t.status = 'pending'
     AND t.due_date IS NOT NULL
     AND t.due_date < p_today
  RETURNING t.*;
$$;

-- ─── Streak ─────────────────────────────────────────────────────────────
-- Consecutive fully-done days ending today (if today is already done) or
-- yesterday. A day counts as done when every non-skipped task on it is done.
-- Skipped tasks are neutral: a day with only skipped tasks neither extends
-- nor breaks the streak. Today still pending is not yet a failure.
CREATE OR REPLACE FUNCTION goal_current_streak(p_goal UUID, p_today DATE)
RETURNS INT
LANGUAGE sql
STABLE
AS $$
  WITH days AS (
    SELECT due_date AS d, bool_and(status = 'done') AS ok
      FROM goal_tasks
     WHERE goal_id = p_goal
       AND due_date IS NOT NULL
       AND due_date <= p_today
       AND status <> 'skipped'
     GROUP BY due_date
  ),
  relevant AS (
    SELECT d, ok FROM days WHERE d < p_today OR ok
  ),
  runs AS (
    SELECT bool_and(ok) OVER (ORDER BY d DESC ROWS UNBOUNDED PRECEDING) AS in_run
      FROM relevant
  )
  SELECT COALESCE(count(*) FILTER (WHERE in_run), 0)::int FROM runs;
$$;

-- ─── Carry existing goals across ────────────────────────────────────────
-- Every old goal becomes a one-time goal with one task, keeping its id.
INSERT INTO goals (id, mentor_id, mentee_id, type, title, end_date, status, completed_at, created_at)
SELECT g.id, g.mentor_id, g.mentee_id, 'one_time', LEFT(g.title, 200), g.due_date,
       CASE WHEN g.is_done THEN 'completed' ELSE 'active' END,
       g.completed_at, COALESCE(g.created_at, NOW())
  FROM mentor_mentee_goals g
ON CONFLICT (id) DO NOTHING;

INSERT INTO goal_tasks (goal_id, mentor_id, mentee_id, title, position, due_date, status,
                        completed_at, completed_by, missed_flagged_at, last_reminder_sent_on, created_at)
SELECT g.id, g.mentor_id, g.mentee_id, LEFT(g.title, 200), 0, g.due_date,
       CASE WHEN g.is_done THEN 'done'
            WHEN g.is_missed THEN 'missed'
            ELSE 'pending' END,
       g.completed_at,
       CASE WHEN g.is_done THEN g.mentee_id END,
       g.missed_flagged_at, g.last_reminder_sent_on, COALESCE(g.created_at, NOW())
  FROM mentor_mentee_goals g
 WHERE NOT EXISTS (SELECT 1 FROM goal_tasks t WHERE t.goal_id = g.id);

COMMIT;
