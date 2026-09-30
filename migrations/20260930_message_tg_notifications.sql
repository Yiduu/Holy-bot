-- Remembers which Telegram notification was sent for which app message, so
-- editing/deleting a message in the app can edit/delete the bot's copy too.
-- Safe to run more than once. Run in Supabase: SQL Editor -> paste -> Run.
CREATE TABLE IF NOT EXISTS message_tg_notifications (
  message_id    UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chat_id       BIGINT NOT NULL,
  tg_message_id BIGINT NOT NULL,
  from_id       BIGINT,
  to_id         BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_tg_notif_pair
  ON message_tg_notifications (from_id, to_id);

-- Only the server (service role) touches this table.
ALTER TABLE message_tg_notifications ENABLE ROW LEVEL SECURITY;
