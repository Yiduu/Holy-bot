BEGIN;

-- "Notify me" on a full mentor. A mentee joins the list; when the mentor has
-- a free spot again, the oldest entries (one per free spot) get a Telegram
-- message and are removed from the list.
--
-- Safe to run more than once. GET /api/mentors treats a missing table as an
-- empty list, so deploy order doesn't matter.
CREATE TABLE IF NOT EXISTS mentor_waitlist (
  id         BIGSERIAL PRIMARY KEY,
  mentor_id  BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mentor_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentor_waitlist_mentor ON mentor_waitlist (mentor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mentor_waitlist_user   ON mentor_waitlist (user_id);

COMMIT;
