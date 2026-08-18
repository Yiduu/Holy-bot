BEGIN;

-- Mentor follow-up tools
--
-- Gives mentors concrete ways to guide/follow up with mentees beyond
-- messaging and free-text notes:
--   1. mentor_mentee_goals — a small per-mentee checklist of action items /
--      goals the mentor sets (e.g. "Read Psalm 23 this week", "Journal 3x").
--      Shown alongside the mentee card so progress is visible at a glance.
--   2. mentor_notes.last_nudge_sent_at — timestamp of the last quick
--      "check-in" nudge sent to a mentee, so the /nudge endpoint can rate
--      limit itself and the UI can show when the mentor last reached out.

CREATE TABLE IF NOT EXISTS mentor_mentee_goals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mentor_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mentee_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  due_date       DATE,
  is_done        BOOLEAN NOT NULL DEFAULT false,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mentor_mentee_goals_pair ON mentor_mentee_goals(mentor_id, mentee_id);
CREATE INDEX IF NOT EXISTS idx_mentor_mentee_goals_done ON mentor_mentee_goals(mentee_id, is_done);

-- Quick-nudge rate limiting / "last reached out" tracking, stored on the
-- existing per-mentor/per-mentee notes row rather than a new table.
ALTER TABLE mentor_notes ADD COLUMN IF NOT EXISTS last_nudge_sent_at TIMESTAMPTZ;

-- The mentor_notes upsert (POST /api/mentors/notes) already relies on
-- ON CONFLICT (mentor_id, mentee_id); make sure that constraint actually
-- exists so both that endpoint and the new nudge endpoint can upsert safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mentor_notes_mentor_mentee_key'
  ) THEN
    ALTER TABLE mentor_notes ADD CONSTRAINT mentor_notes_mentor_mentee_key UNIQUE (mentor_id, mentee_id);
  END IF;
END $$;

COMMIT;
