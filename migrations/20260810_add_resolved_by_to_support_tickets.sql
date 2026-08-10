BEGIN;
-- Tracks who marked the ticket resolved: 'user' (support seeker confirmed their
-- issue is solved) or 'admin' (support team closed it out). NULL = not resolved.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_by TEXT
  CHECK (resolved_by IN ('user', 'admin'));
COMMIT;
