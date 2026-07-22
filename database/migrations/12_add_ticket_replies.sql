-- Migration to create ticket_replies table and extend support_tickets table

-- Create ticket_replies table for threaded support communications
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin')),
  sender_id   BIGINT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add last_reply_at and reply_count columns to support_tickets
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reply_count INT DEFAULT 0;

-- Indexes for fast thread lookups and sorting
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_created ON ticket_replies(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_tickets_last_reply ON support_tickets(last_reply_at DESC);
