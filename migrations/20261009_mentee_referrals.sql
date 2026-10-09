BEGIN;

-- A mentor "transfers" an active mentee by referring them to another mentor.
-- The mentee stays with the sender until the receiving mentor accepts; a decline
-- leaves everything as it was. Safe to run more than once.
CREATE TABLE IF NOT EXISTS mentee_referrals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assignment_id  UUID   NOT NULL REFERENCES mentorship_assignments(id) ON DELETE CASCADE,
  mentee_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  from_mentor_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  to_mentor_id   BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  note           TEXT,
  status         TEXT   NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mentee_referrals_to   ON mentee_referrals (to_mentor_id, status);
CREATE INDEX IF NOT EXISTS idx_mentee_referrals_from ON mentee_referrals (from_mentor_id, status);
-- Only one open referral per mentee assignment at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_referral_per_assignment
  ON mentee_referrals (assignment_id) WHERE status = 'pending';

ALTER TABLE mentee_referrals ENABLE ROW LEVEL SECURITY;

COMMIT;
