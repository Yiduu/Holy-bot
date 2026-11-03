-- A mentor can pause the inactivity "come back" reminders for one specific mentee.
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS remind_paused BOOLEAN NOT NULL DEFAULT FALSE;
