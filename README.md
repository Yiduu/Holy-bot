# Holy — Anonymous Christian Counseling Platform

A Telegram bot paired with a Mini App for anonymous peer counseling and
mentorship. Users pick a topic they're struggling with (pornography, drugs,
anxiety, and others — configurable), get matched with a mentor, and can chat,
video call, track a Bible-reading streak, and journal. Admins run the whole
thing from a dashboard in the Mini App.

## What's in the box

**Telegram bot**
- Registration flow that assigns an anonymous handle (`Warrior_9XkL2` style)
- Topic-based mentor matching — mentees pick struggles, mentors pick expertise
- Plain-text chat routed through the bot, with a one-hour "reply context"
  window (`/reply @nickname`) so a mentor talking to several people at once
  doesn't have to repeat a target on every message
- Daily Bible verses, opt-in, with Amharic translations
- Session reminders and follow-up nudges for mentors
- Bot commands: `/start`, `/menu`, `/apply` (mentor application), `/settopics`,
  `/end` (end an active mentorship), `/reply`, `/repair_assignments`

**Mini App (frontend/)**
- Onboarding and profile setup
- Chat with Telegram-style **voice messages** (hold the mic to record, slide
  left to cancel, slide up to lock) and **file / photo / video attachments**
  (paperclip menu, preview with caption, upload progress, retry). Files are
  stored on Telegram, in the chat of `ADMIN_TELEGRAM_ID` — see `MIGRATIONS.md`
- 1-on-1 and group video calls via Jitsi Meet
- Bible streak tracking and personal journaling
- Support ticket system with threaded replies
- Admin dashboard (`admin.html`): user management, mentor application
  review, message moderation, support tickets, topic management, broadcast
  messages, audit log

**Backend**
- Node.js / Express, Socket.IO for real-time chat presence, Supabase for
  the database and auth
- Telegram WebApp `initData` signature verification on every authenticated
  request
- Tiered rate limiting (general API, auth endpoints, broadcast)
- Winston logging, optional Sentry error tracking (just leave `SENTRY_DSN`
  blank to skip it)
- English and Amharic UI strings (`local/en.json`, `local/am.json`,
  `frontend/locales.js`)

## Setup

### 1. Environment variables

Copy `.env.example` to `.env` and fill it in. Every variable the app reads is
listed there with a comment on what it's for.

### 2. Database

The schema is split across three migration folders for historical reasons.
Follow `MIGRATIONS.md` — it lists the exact files and order to run them in
against your Supabase project's SQL editor.

### 3. Install and run

```bash
npm install
npm start        # or: npm run dev, for nodemon
```

### 4. Telegram side

Register your bot with [@BotFather](https://t.me/BotFather), point its Mini
App URL at wherever you deploy `frontend/` (Render, in the reference
deployment), and set `MINI_APP_URL` accordingly in your `.env`.

### 5. Locking down CORS for production

By default `ALLOWED_ORIGIN` is unset and CORS falls back to `*`, which is
fine for local development. Before you go live, set `ALLOWED_ORIGIN` in your
`.env` to your actual Mini App URL.

## Deployment notes

The reference deployment runs on Render with Supabase as the database. There's
no CI pipeline and no automated test suite yet — testing so far has been
manual. If you're picking this up as a buyer, budget time for at least a
smoke-test pass before pointing it at real users.

## License

See `LICENSE.md`.
