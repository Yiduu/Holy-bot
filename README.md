# Holy Platform - Expanded Counseling Support

A comprehensive Christian counseling platform with support for multiple counseling topics, unified through a powerful Telegram Bot.

## 🚀 Key Features

### 🤖 Telegram Bot (Central Hub)
- **Multi-Topic Registration**: Users select areas of struggle (Porn, Drugs, Anxiety, etc.).
- **Expertise Matching**: Mentors specify expertise topics; users find mentors filtered by topic.
- **Pure Telegram Chat**: Plain-text messaging with context-awareness for mentors (1-hour memory).
- **Bible Streaks & Journaling**: Track spiritual progress and personal reflections.
- **Daily Verses**: Opt-in daily verses with Amharic translation support.
- **Video Sessions**: Schedule and receive session deep links directly in the bot.

### 📱 Telegram Mini-App
- **Video Calls**: Jitsi Meet integration for 1-on-1 and Group sessions.
- **Admin Dashboard**: Manage users, review mentor applications, and manage counseling topics.

## 🛠 Setup

### 1. Database Migrations
Run these in your Supabase SQL editor:
1. `supabase/01_schema.sql`
2. `database/migrations/03_add_features.sql`
3. `database/migrations/04_add_topics.sql` (New: Multi-topic support)

### 2. Environment Variables
```env
TELEGRAM_BOT_TOKEN=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
MINI_APP_URL=...
```

### 3. Installation
```bash
npm install
npm start
```

## 💬 Chat Commands
- `/reply @nickname <message>`: Specifically target a mentee (sets context for 1 hour).
- `/reply @nickname`: Set focus context without sending a message.
- `/apply`: Start the mentor application process.
- `/settopics`: Update your counseling topics.
