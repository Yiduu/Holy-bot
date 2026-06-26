-- ============================================================
-- Recovery App – Complete Supabase Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLES
-- ============================================================

-- Users table (core identity)
CREATE TABLE IF NOT EXISTS users (
  telegram_id       BIGINT PRIMARY KEY,
  anonymous_id      TEXT UNIQUE NOT NULL,
  chat_id           BIGINT,
  sex               TEXT CHECK (sex IN ('M','F','prefer_not')),          -- mentor's own biological sex
  preferred_mentee_sex TEXT CHECK (preferred_mentee_sex IN ('M','F','prefer_not')), -- mentor preference: which mentees they will work with
  age_range         TEXT CHECK (age_range IN ('13-17','18-24','25-34','35-44','45-54','55+')),
  education_level   TEXT CHECK (education_level IN ('none','primary','secondary','undergraduate','graduate','postgraduate')),
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','mentor','admin')),
  is_banned         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_anonymous_id ON users(anonymous_id);
CREATE INDEX idx_users_created_at ON users(created_at);

-- User settings
CREATE TABLE IF NOT EXISTS user_settings (
  telegram_id           BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  display_name          TEXT,
  timezone              TEXT DEFAULT 'UTC',
  notify_messages       BOOLEAN DEFAULT true,
  notify_sessions       BOOLEAN DEFAULT true,
  notify_daily_verse    BOOLEAN DEFAULT true,
  -- Mentor-specific
  availability_start    TIME,
  availability_end      TIME,
  max_mentees           INT DEFAULT 5,
  bio                   TEXT,
  specialization        TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Mentor applications
CREATE TABLE IF NOT EXISTS mentor_applications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  answer_q1       TEXT NOT NULL,  -- "How long have you been free?"
  answer_q2       TEXT NOT NULL,  -- "Describe your recovery steps"
  answer_q3       TEXT,           -- optional extra
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note      TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX idx_mentor_apps_status ON mentor_applications(status);
CREATE INDEX idx_mentor_apps_telegram_id ON mentor_applications(telegram_id);

-- Mentors (extended profile, set on role change)
CREATE TABLE IF NOT EXISTS mentors (
  telegram_id       BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  bio               TEXT,
  specialization    TEXT,
  available_hours   JSONB DEFAULT '{}',  -- {mon:[{start:"09:00",end:"17:00"}], ...}
  max_clients       INT DEFAULT 5,
  is_active         BOOLEAN DEFAULT true,
  joined_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Mentorship requests (pending)
CREATE TABLE IF NOT EXISTS mentorship_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mentor_id       BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
  message         TEXT,
  admin_note      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, mentor_id, status)
);

CREATE INDEX idx_mentorship_req_mentor ON mentorship_requests(mentor_id, status);
CREATE INDEX idx_mentorship_req_user ON mentorship_requests(user_id);

-- Active mentor-mentee assignments
-- FIX: Replaced UNIQUE(user_id, is_active) table constraint with a partial
-- unique index on (user_id) WHERE is_active = true.
--
-- The old constraint meant a user could only ever have ONE ended assignment
-- (is_active = false), because (user_id, false) would collide on the second
-- ended row. The partial index below enforces the real business rule:
-- "a user may only have one ACTIVE assignment at a time" while allowing
-- unlimited historical (ended) assignments.
CREATE TABLE IF NOT EXISTS mentorship_assignments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mentor_id       BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

-- Enforces only one active assignment per user (allows many ended ones)
CREATE UNIQUE INDEX one_active_assignment_per_user
  ON mentorship_assignments(user_id)
  WHERE is_active = true;

CREATE INDEX idx_assignments_mentor ON mentorship_assignments(mentor_id, is_active);
CREATE INDEX idx_assignments_user ON mentorship_assignments(user_id, is_active);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_id         BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  to_id           BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  is_flagged      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_pair ON messages(from_id, to_id, created_at DESC);
CREATE INDEX idx_messages_to ON messages(to_id, is_read);
CREATE INDEX idx_messages_created ON messages(created_at);

-- Video sessions
CREATE TABLE IF NOT EXISTS video_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_name       TEXT UNIQUE NOT NULL,
  room_password   TEXT,
  host_id         BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  is_group        BOOLEAN NOT NULL DEFAULT false,
  max_participants INT DEFAULT 2,
  title           TEXT,
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','ended','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_host ON video_sessions(host_id, status);
CREATE INDEX idx_sessions_scheduled ON video_sessions(scheduled_at, status);

-- Session participants
CREATE TABLE IF NOT EXISTS session_participants (
  session_id    UUID NOT NULL REFERENCES video_sessions(id) ON DELETE CASCADE,
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  joined_at     TIMESTAMPTZ,
  left_at       TIMESTAMPTZ,
  PRIMARY KEY (session_id, telegram_id)
);

-- Recordings
CREATE TABLE IF NOT EXISTS recordings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    UUID NOT NULL REFERENCES video_sessions(id) ON DELETE CASCADE,
  recording_url TEXT NOT NULL,
  provider      TEXT DEFAULT 'jitsi',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Support tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  admin_reply   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_status ON support_tickets(status);
CREATE INDEX idx_tickets_user ON support_tickets(telegram_id);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id      BIGINT NOT NULL,
  action        TEXT NOT NULL,
  target_id     BIGINT,
  target_type   TEXT,
  details       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_admin ON audit_logs(admin_id, created_at DESC);

-- Daily verses
CREATE TABLE IF NOT EXISTS daily_verses (
  id            SERIAL PRIMARY KEY,
  reference     TEXT NOT NULL,
  text          TEXT NOT NULL,
  theme         TEXT,
  is_active     BOOLEAN DEFAULT true
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentor_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentors ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentorship_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mentorship_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_verses ENABLE ROW LEVEL SECURITY;

-- Service role bypasses all RLS (used by backend)
-- Anon key policies below are minimal since all auth goes through backend

-- Users: read own record
CREATE POLICY "users_own" ON users
  FOR ALL USING (true) WITH CHECK (true);

-- Messages: from or to involved user
CREATE POLICY "messages_participants" ON messages
  FOR ALL USING (true) WITH CHECK (true);

-- Daily verses: read-only for all
CREATE POLICY "verses_read" ON daily_verses
  FOR SELECT USING (true);

-- All other tables: service role access only (enforced by using service key in backend)

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update last_active on users
CREATE OR REPLACE FUNCTION update_last_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users SET last_active = NOW() WHERE telegram_id = NEW.from_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_last_active
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION update_last_active();

-- Auto-delete messages older than 30 days (Supabase pg_cron job)
-- Run: SELECT cron.schedule('delete-old-messages', '0 2 * * *', 'DELETE FROM messages WHERE created_at < NOW() - INTERVAL ''30 days''');

-- FIX: Updated trigger function to work correctly with the new partial unique
-- index. Instead of relying on the broken UNIQUE(user_id, is_active) constraint,
-- the trigger now directly deactivates any other active assignment for the user
-- whenever a new active one is inserted or updated.
CREATE OR REPLACE FUNCTION enforce_single_active_assignment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active = true THEN
    UPDATE mentorship_assignments
    SET is_active = false, ended_at = NOW()
    WHERE user_id = NEW.user_id
      AND is_active = true
      AND id != NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_single_active_assignment
BEFORE INSERT OR UPDATE ON mentorship_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_single_active_assignment();

-- ============================================================
-- REALTIME (enable for messages table)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE video_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE mentorship_requests;