BEGIN;

-- Chat History: after a mentorship ends the mentor can keep reading a read-only
-- copy of the conversation, unless the MENTEE switched it off ("Let my mentor
-- keep a copy of our chat") when ending, or later from the rating pop-up.
--
-- true  = mentor may keep the copy (default, so nothing changes for old rows
--         except that mentors can now read what they already took part in)
-- false = the mentee keeps it private; the mentor never sees it.
--
-- Safe to run more than once. Until it is run the Chat History page is simply
-- empty (the backend treats a missing column as "not shared").
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS history_allowed BOOLEAN NOT NULL DEFAULT true;

COMMIT;
