-- Lets edits made inside the Telegram bot chat reach the app and the other
-- person's Telegram copy. Self-contained and safe to run more than once
-- (creates the table too, in case 20260930_message_tg_notifications.sql
-- was not run).
CREATE TABLE IF NOT EXISTS message_tg_notifications (
  message_id    UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chat_id       BIGINT,
  tg_message_id BIGINT,
  from_id       BIGINT,
  to_id         BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recipient copy may be missing (send failed) while the source still matters.
ALTER TABLE message_tg_notifications ALTER COLUMN chat_id DROP NOT NULL;
ALTER TABLE message_tg_notifications ALTER COLUMN tg_message_id DROP NOT NULL;

-- The sender's OWN Telegram message, when they typed it in the bot chat.
ALTER TABLE message_tg_notifications ADD COLUMN IF NOT EXISTS src_chat_id BIGINT;
ALTER TABLE message_tg_notifications ADD COLUMN IF NOT EXISTS src_tg_message_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_msg_tg_notif_pair
  ON message_tg_notifications (from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_msg_tg_notif_src
  ON message_tg_notifications (src_chat_id, src_tg_message_id);

ALTER TABLE message_tg_notifications ENABLE ROW LEVEL SECURITY;
