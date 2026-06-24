-- 07_add_admin_note_to_mentorship_requests.sql
ALTER TABLE mentorship_requests ADD COLUMN IF NOT EXISTS admin_note TEXT;
