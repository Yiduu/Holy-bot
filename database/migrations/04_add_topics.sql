-- 04_add_topics.sql

-- 1. Topics table
CREATE TABLE IF NOT EXISTS topics (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed topics
INSERT INTO topics (name, slug, description) VALUES
('Pornography Addiction', 'porn_addiction', 'Recovery from compulsive pornography use.'),
('Drug Addiction', 'drug_addiction', 'Recovery from substance abuse and chemical dependency.'),
('Alcohol Addiction', 'alcohol_addiction', 'Recovery from alcohol dependency.'),
('Identity Crisis', 'identity_crisis', 'Seeking clarity on purpose and identity in Christ.'),
('Anxiety & Panic', 'anxiety_panic', 'Support for managing anxiety disorders and panic attacks.'),
('Depression', 'depression', 'Support for clinical and situational depression.'),
('Loneliness & Isolation', 'loneliness', 'Overcoming isolation and building community.'),
('Grief & Loss', 'grief_loss', 'Navigating the journey of loss and mourning.'),
('Anger Management', 'anger_management', 'Biblical principles for managing anger.'),
('Self-Harm', 'self_harm', 'Support for overcoming self-harm behaviors.'),
('Suicidal Thoughts', 'suicide_prevention', 'Critical support and hope for those in despair.'),
('Eating Disorders', 'eating_disorders', 'Recovery from body image and eating-related struggles.'),
('Gaming Addiction', 'gaming_addiction', 'Balancing technology and real-life responsibilities.'),
('Social Media Addiction', 'social_media_addiction', 'Breaking free from compulsive digital validation.'),
('Workaholism', 'workaholism', 'Finding rest and balance in a high-pressure world.'),
('Purity & Sexual Integrity', 'sexual_integrity', 'Maintaining holiness in relationships and thought life.'),
('Relationship & Marriage', 'relationship_marriage', 'Building healthy, God-centered relationships.'),
('Parenting Struggles', 'parenting', 'Support for the challenges of raising children.'),
('Financial Stress', 'finances', 'Stewardship and peace in financial difficulty.'),
('Trauma & PTSD', 'trauma_ptsd', 'Healing from past wounds and traumatic experiences.')
ON CONFLICT (slug) DO NOTHING;

-- 2. User Topics (Struggles)
CREATE TABLE IF NOT EXISTS user_topics (
  telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (telegram_id, topic_id)
);

-- 3. Mentor Topics (Expertise)
CREATE TABLE IF NOT EXISTS mentor_topics (
  telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (telegram_id, topic_id)
);

-- 4. Update Assignments and Sessions
ALTER TABLE mentorship_assignments ADD COLUMN IF NOT EXISTS topic_id INTEGER REFERENCES topics(id);
ALTER TABLE video_sessions ADD COLUMN IF NOT EXISTS topic_id INTEGER REFERENCES topics(id);

-- 5. Bible Streaks (Ensuring it exists as per prompt request)
CREATE TABLE IF NOT EXISTS bible_streaks (
  telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  last_read_date DATE
);

-- 6. Journal Entries (Ensuring it exists as per prompt request)
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. User Settings Update
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS verse_time INTEGER DEFAULT 7;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
