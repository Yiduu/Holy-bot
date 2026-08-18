BEGIN;

-- 10-minute-before "starting soon" reminder for live sessions.
--
-- Tracks whether the reminder has already been sent to the host + all
-- invited participants, so the once-a-minute scheduler in bot.js doesn't
-- re-send it on every tick between when it becomes due and the session
-- actually starting.
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;

-- Speeds up the scheduler's query (status='scheduled' AND reminder_sent=false
-- AND scheduled_at <= <10-min-from-now>).
CREATE INDEX IF NOT EXISTS idx_sessions_reminder ON video_sessions(status, reminder_sent, scheduled_at);

COMMIT;
