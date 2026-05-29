-- Mentor private notes on mentees
CREATE TABLE IF NOT EXISTS mentor_notes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mentor_id       BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mentee_id       BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mentor_notes_pair ON mentor_notes(mentor_id, mentee_id);
