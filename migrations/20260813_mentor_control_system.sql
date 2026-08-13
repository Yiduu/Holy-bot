BEGIN;

-- Mentor Control System (admin panel)
--
-- Adds the columns needed for admins to *reversibly* suspend a mentor —
-- distinct from:
--   • mentors.is_active / disqualify   → permanent, demotes role back to 'user'
--   • users.accepting_requests         → the mentor's OWN "pause new requests" toggle
--
-- An admin suspension hides the mentor from mentee discovery and blocks new
-- requests, but keeps their role, history, and existing mentee relationships
-- intact so it can be lifted with no data loss.

ALTER TABLE mentors ADD COLUMN IF NOT EXISTS suspended_by_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mentors ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE mentors ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Private admin notes about a mentor — never shown to the mentor or to
-- mentees. Separate from mentor_applications.admin_note, which the mentor
-- CAN see (it's sent back to them on rejection).
ALTER TABLE mentors ADD COLUMN IF NOT EXISTS admin_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_mentors_suspended ON mentors(suspended_by_admin);

COMMIT;
