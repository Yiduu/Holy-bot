-- Mentors can switch off the "come back" inactivity reminders sent to their mentees.
ALTER TABLE users ADD COLUMN IF NOT EXISTS remind_inactive_mentees BOOLEAN NOT NULL DEFAULT TRUE;
