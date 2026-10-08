'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// HOLY HELPER BOT — Complete Rewrite
// Modules: State, Localization, Formatting, Mentor Search, Chat, Streaks,
//          Journal, Verse, Settings, Scheduler, Rating, Waiting List
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { ethiopiaToday, ethiopiaTimeHM, addDays, daysBetween, trailingMissedDays } = require('./utils/goalRules');
const { setTaskDone: setGoalTaskDone, emitGoal } = require('./utils/goalService');
const fs = require('fs');
const path = require('path');
const { emitToUser } = require('./utils');
require('dotenv').config();


const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: {
    // Without a timeout, a stalled DB leaves scheduler queries hanging forever
    // and they keep holding connections. Fail fast instead.
    // Re-throw timeouts as AbortError: supabase-js retries reads 3x (67s total)
    // on anything else, but never on an AbortError.
    fetch: async (url, opts = {}) => {
      try {
        return await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(15000) });
      } catch (e) {
        if (e && e.name === 'TimeoutError') {
          const err = new Error('Supabase request timed out after 15000ms');
          err.name = 'AbortError';
          throw err;
        }
        throw e;
      }
    },
  },
});
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Handle polling/network errors gracefully to prevent process crashes and clean up logs
bot.on('polling_error', (error) => {
  if (error.code === 'EFATAL' && error.message.includes('ECONNRESET')) {
    console.warn('[Bot] Polling connection reset (ECONNRESET). Telegram or network closed the connection. Retrying...');
  } else {
    console.warn('[Bot] Polling warning:', error.message || error);
  }
});

bot.on('error', (error) => {
  console.error('[Bot] General error:', error);
});
console.log('[Bot] MINI_APP_URL from env =', process.env.MINI_APP_URL);
const APP_URL = process.env.MINI_APP_URL || 'https://holy-bot-etvy.onrender.com';
console.log('[Bot] APP_URL set to =', APP_URL);
const { HTML, esc, card, goldButton, goldCallback, goldKeyboard } = require('./utils/notifyStyle');

// Set the chat menu button only if explicitly enabled in env (prevents wiping BotFather settings on deploy)
if (process.env.AUTO_SET_MENU_BUTTON === 'true') {
  bot.setChatMenuButton({
    menu_button: {
      type: 'web_app',
      text: process.env.MENU_BUTTON_TEXT || 'Holy App',
      web_app: {
        url: APP_URL
      }
    }
  }).catch(err => console.warn('[Bot] Failed to set menu button:', err.message));
}

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_MENTEES = parseInt(process.env.MAX_MENTEES_DEFAULT || '3');
const PAGE_SIZE = 5;

// ─── Localization ─────────────────────────────────────────────────────────────

const locales = {};
function loadLocales() {
  const dir = path.join(__dirname, 'local');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json')) {
      const lang = file.replace('.json', '');
      locales[lang] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  }
}
try { loadLocales(); } catch (e) { console.warn('[i18n] Could not load locales:', e.message); }

// Language cache: telegram_id -> 'en' | 'am'
const langCache = new Map();

async function getUserLang(chatId) {
  if (langCache.has(chatId)) return langCache.get(chatId);
  const { data } = await supabase.from('user_settings').select('language').eq('telegram_id', chatId).single();
  const lang = data?.language || 'en';
  langCache.set(chatId, lang);
  return lang;
}

function setLangCache(chatId, lang) { langCache.set(chatId, lang); }

/**
 * t(chatId, key, replacements?) — async translation helper.
 * Falls back to English if key missing in current language.
 */
async function t(chatId, key, replacements = {}) {
  const lang = await getUserLang(chatId);
  let str = (locales[lang]?.[key]) ?? (locales['en']?.[key]) ?? key;
  for (const [k, v] of Object.entries(replacements)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return str;
}

// Synchronous version when lang is already known
function tSync(lang, key, replacements = {}) {
  let str = (locales[lang]?.[key]) ?? (locales['en']?.[key]) ?? key;
  for (const [k, v] of Object.entries(replacements)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return str;
}

// Escape characters that break Telegram Markdown (parse_mode: 'Markdown')
// Only *, _, ` need escaping in legacy Markdown mode
function mdEscape(str) {
  if (!str) return '';
  return String(str).replace(/([*_`])/g, '\\$1');
}

// ─── State Management ─────────────────────────────────────────────────────────

const userStates = new Map(); // telegram_id -> { step, targetId, expires, tempData }

function setState(chatId, step, targetId = null, tempData = {}) {
  userStates.set(chatId, { step, targetId, expires: Date.now() + 3600000, tempData });
}

function clearState(chatId) { userStates.delete(chatId); }

function getState(chatId) {
  const state = userStates.get(chatId);
  if (state && state.expires < Date.now()) { userStates.delete(chatId); return null; }
  return state;
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function formatUserDateTime(dateStr, timezone = 'Africa/Addis_Ababa') {
  let tz = timezone;
  if (!tz || tz === 'UTC') tz = 'Africa/Addis_Ababa';
  // NOTE: dateStyle/timeStyle cannot be combined with timeZoneName in the
  // same Intl.DateTimeFormat options object — V8 throws
  // "RangeError: Invalid option : option" for that combination. Using the
  // granular field options (year/month/day/hour/minute) instead of the
  // dateStyle/timeStyle shorthand avoids the conflict while still
  // including the timezone abbreviation (e.g. "EAT").
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: tz, timeZoneName: 'short'
    });
  } catch {
    try {
      return new Date(dateStr).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
    } catch {
      return new Date(dateStr).toLocaleString();
    }
  }
}

function isOnline(lastActivity) {
  if (!lastActivity) return false;
  return Date.now() - new Date(lastActivity).getTime() < ONLINE_THRESHOLD_MS;
}

function onlineBadge(lastActivity) {
  return isOnline(lastActivity) ? '🟢' : '⚪';
}

function renderStars(rating, count) {
  if (!rating || !count) return '⭐ No ratings yet';
  const full = Math.round(rating);
  return '⭐'.repeat(full) + '☆'.repeat(5 - full) + ` (${rating.toFixed(1)}, ${count} reviews)`;
}

// ─── Safe Send Helper ─────────────────────────────────────────────────────────

async function safeSend(chatId, text, extra = {}) {
  if (!chatId) return;
  const { skipOpenAnchor, ...sendOptions } = extra; // skipOpenAnchor no longer used, kept for call-site compatibility
  try { return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...sendOptions }); }
  catch (err) { console.error(`[Bot] Failed to send to ${chatId}:`, err.message); }
}

// Send a styled notification card (HTML) with an optional coloured "open app" button.
//   content: { icon, title, body, quote, fields, footer }  (plain text, escaped by card())
//   btn:     { label, url? }  -> gold web-app button; url defaults to the app home.
function sendCard(chatId, content, btn) {
  const extra = { ...HTML };
  if (btn) extra.reply_markup = goldKeyboard(btn.label, btn.url || APP_URL);
  return safeSend(chatId, card(content), extra);
}

async function safeSendLoading(chatId, text) {
  return safeSend(chatId, `⏳ ${text}`);
}

async function deleteMessage(chatId, messageId) {
  try { await bot.deleteMessage(chatId, messageId); } catch { }
}

// ─── Update Last Activity ─────────────────────────────────────────────────────

async function touchActivity(chatId) {
  await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('telegram_id', chatId);
}

// ─── Main Menu ────────────────────────────────────────────────────────────────

async function showMainMenu(chatId, customText) {
  return showPersistentMenu(chatId, customText);
}

// Builds the bottom reply-keyboard rows for a given role/lang. Pulled out
// of showPersistentMenu so other send paths (chat notifications) can
// reattach the same keyboard without duplicating the layout, and without
// needing a full showMainMenu-style text message.
function buildPersistentKeyboard(role, lang) {
  const kb = [
    [tSync(lang, 'btn_find_mentor'), tSync(lang, 'btn_my_chat')],
    [tSync(lang, 'btn_streak'), tSync(lang, 'btn_journal')],
    [tSync(lang, 'btn_verse'), tSync(lang, 'btn_settings')]
  ];

  if (role === 'mentor' || role === 'admin') {
    kb.push([tSync(lang, 'btn_my_mentees'), tSync(lang, 'btn_schedule')]);
  } else {
    kb.push([tSync(lang, 'btn_apply_mentor')]);
  }

  return { keyboard: kb, resize_keyboard: true, one_time_keyboard: false };
}

async function showPersistentMenu(chatId, customText) {
  const [{ data: user }, lang] = await Promise.all([
    supabase.from('users').select('role, anonymous_id').eq('telegram_id', chatId).single(),
    getUserLang(chatId)
  ]);
  const role = user?.role || 'user';
  const menuText = customText || tSync(lang, 'menu_welcome', { nick: user?.anonymous_id || '' });

  await safeSend(chatId, menuText, {
    reply_markup: buildPersistentKeyboard(role, lang)
  });
}

async function showCancelKeyboard(chatId, promptText) {
  const lang = await getUserLang(chatId);
  return safeSend(chatId, promptText, {
    reply_markup: {
      inline_keyboard: [[{ text: tSync(lang, 'btn_cancel'), callback_data: 'cancel_operation' }]]
    }
  });
}

async function showTextInputWithCancel(chatId, promptText, nextState, tempData = {}) {
  setState(chatId, nextState, null, tempData);
  const lang = await getUserLang(chatId);
  return safeSend(chatId, promptText, {
    reply_markup: {
      inline_keyboard: [[{ text: tSync(lang, 'btn_cancel'), callback_data: 'cancel_application' }]]
    }
  });
}

// ─── Topic Picker ─────────────────────────────────────────────────────────────

// Topics store English in `name` and Amharic in `name_am`. Show only one language,
// falling back to English if an Amharic name has not been added yet.
function topicLabel(topic, lang = 'en') {
  if (!topic) return '?';
  return (lang === 'am' && topic.name_am) ? topic.name_am : (topic.name || '?');
}

async function getTopicPickerKeyboard(selectedIds = [], actionPrefix = 'reg_topic_', lang = 'en') {
  const { data: topics } = await supabase.from('topics').select('id, name, name_am').eq('is_active', true).order('name');
  if (!topics) return { inline_keyboard: [] };

  const buttons = topics.map(t => {
    const isSelected = selectedIds.includes(t.id);
    return [{ text: `${isSelected ? '✅' : '⬜'} ${topicLabel(t, lang)}`, callback_data: `${actionPrefix}${t.id}` }];
  });
  buttons.push([{ text: tSync(lang, 'btn_done'), callback_data: `${actionPrefix}done` }]);
  return { inline_keyboard: buttons };
}

async function getMentorTopicKeyboard(chatId, lang = 'en') {
  const { data: topics } = await supabase.from('topics').select('id, name, name_am').eq('is_active', true).order('name');
  const { data: mentorTopics } = await supabase.from('mentor_topics').select('topic_id').eq('telegram_id', chatId);
  const selectedIds = (mentorTopics || []).map(mt => mt.topic_id);
  if (!topics) return { inline_keyboard: [] };

  const buttons = topics.map(t => {
    const isSelected = selectedIds.includes(t.id);
    return [{ text: `${isSelected ? '✅' : '⬜'} ${topicLabel(t, lang)}`, callback_data: `toggle_topic_${t.id}` }];
  });
  buttons.push([
    { text: tSync(lang, 'btn_done'), callback_data: 'topic_done' },
    { text: tSync(lang, 'btn_cancel'), callback_data: 'topic_cancel' }
  ]);
  return { inline_keyboard: buttons };
}

// ─── Inline Calendar ──────────────────────────────────────────────────────────

function getEthiopiaNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' }));
}

function getCalendarKeyboard(year, month, lang = 'en') {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const header = `${months[month]} ${year}`;
  const keyboard = { inline_keyboard: [] };

  // Month navigation row
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  keyboard.inline_keyboard.push([
    { text: "◀️", callback_data: `cal_nav_${prevYear}_${prevMonth}` },
    { text: header, callback_data: "noop" },
    { text: "▶️", callback_data: `cal_nav_${nextYear}_${nextMonth}` }
  ]);

  // Weekdays row
  const weekdays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  keyboard.inline_keyboard.push(weekdays.map(d => ({ text: d, callback_data: "noop" })));

  // Days grid
  const firstDay = new Date(Date.UTC(year, month, 1));
  let dayOfWeek = (firstDay.getUTCDay() + 6) % 7; // 0=Mo, 6=Su
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  let currentRow = Array(dayOfWeek).fill({ text: " ", callback_data: "noop" });
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    currentRow.push({ text: d.toString(), callback_data: `cal_select_${dateStr}` });
    if (currentRow.length === 7) {
      keyboard.inline_keyboard.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    while (currentRow.length < 7) currentRow.push({ text: " ", callback_data: "noop" });
    keyboard.inline_keyboard.push(currentRow);
  }

  keyboard.inline_keyboard.push([{ text: tSync(lang, 'btn_back'), callback_data: 'menu_schedule' }]);
  return keyboard;
}

// ─── Time Selection ───────────────────────────────────────────────────────────

function getTimeSlotsKeyboard(lang = 'en') {
  const slots = ["09:00 AM", "12:00 PM", "03:00 PM", "06:00 PM", "09:00 PM"];
  const keyboard = { inline_keyboard: [] };

  // Two slots per row
  for (let i = 0; i < slots.length; i += 2) {
    const row = slots.slice(i, i + 2).map(s => ({ text: s, callback_data: `time_select_${s}` }));
    keyboard.inline_keyboard.push(row);
  }

  keyboard.inline_keyboard.push([{ text: tSync(lang, 'btn_custom_time'), callback_data: 'time_custom' }]);
  keyboard.inline_keyboard.push([{ text: tSync(lang, 'btn_back'), callback_data: 'menu_schedule' }]);
  return keyboard;
}

// ─── Session Creation Helper ──────────────────────────────────────────────────

async function createVideoSession(chatId, date, time12h) {
  const lang = await getUserLang(chatId);
  const state = getState(chatId);
  if (!state) return;

  // Parse 12h time to 24h
  const match = time12h.trim().match(/^(0?[1-9]|1[0-2]):([0-5][0-9])\s?(AM|PM)$/i);
  if (!match) return safeSend(chatId, tSync(lang, 'invalid_time_format'));

  let hours = parseInt(match[1]);
  const minutes = match[2];
  const ampm = match[3].toUpperCase();

  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;

  const time24 = `${String(hours).padStart(2, '0')}:${minutes}`;

  // Combine date and time in Ethiopia timezone and convert to UTC
  const localIso = `${date}T${time24}:00+03:00`;
  const scheduledAt = new Date(localIso);

  if (isNaN(scheduledAt.getTime())) return safeSend(chatId, tSync(lang, 'invalid_datetime'));
  if (scheduledAt.getTime() < Date.now()) return safeSend(chatId, tSync(lang, 'time_past'));

  try {
    console.log(`[Scheduler] Creating session for ${chatId} at ${scheduledAt.toISOString()}`);
    const roomName = `holy_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const roomPassword = Math.random().toString(36).substring(2, 10);
    const isGroup = state.tempData.type === 'group';
    const menteeId = state.tempData.mentee_id ? parseInt(state.tempData.mentee_id) : null;

    // NOTE: video_sessions has no mentor_id/mentee_id columns (see
    // supabase/01_schema.sql) — only host_id. Passing mentor_id/mentee_id
    // here made every insert fail with a "column does not exist" error,
    // which is why scheduling always ended in "Failed to schedule
    // session." Participants (host + mentee) belong in the separate
    // session_participants table instead, matching how the mini app's
    // POST /api/sessions/create already does it correctly.
    const { data: sess, error } = await supabase.from('video_sessions').insert({
      host_id: chatId,
      scheduled_at: scheduledAt.toISOString(),
      is_group: isGroup,
      title: isGroup ? 'Group Session' : '1-on-1 Session',
      room_name: roomName,
      room_password: roomPassword,
      status: 'scheduled',
      max_participants: isGroup ? 10 : 2
    }).select().single();

    if (error) throw error;

    // Add host as a participant
    await supabase.from('session_participants').insert({ session_id: sess.id, telegram_id: chatId });

    // Add mentee as a participant for private sessions
    if (menteeId && !isGroup) {
      await supabase.from('session_participants').insert({ session_id: sess.id, telegram_id: menteeId });
    }

    // Format confirmation details for the mentor
    const { data: mentorSettings } = await supabase.from('user_settings').select('timezone').eq('telegram_id', chatId).single();
    let hostTimezone = mentorSettings?.timezone || 'Africa/Addis_Ababa';
    if (!hostTimezone || hostTimezone === 'UTC') hostTimezone = 'Africa/Addis_Ababa';

    const dateStr = scheduledAt.toLocaleDateString('en-US', { timeZone: hostTimezone, dateStyle: 'medium' });
    // NOTE: timeStyle can't be combined with timeZoneName in the same
    // Intl.DateTimeFormat options — that combination throws
    // "RangeError: Invalid option : option", which is what was making
    // every scheduling attempt fail with "Failed to schedule session."
    // Granular hour/minute options avoid the conflict while still
    // showing the timezone abbreviation (e.g. "EAT").
    const timeStr = scheduledAt.toLocaleTimeString('en-US', {
      timeZone: hostTimezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
    const typeLabel = state.tempData.type === 'private' ? 'Private' : 'Group';

    const mAm = lang === 'am';
    const mentorMsg = card({
      icon: '✅',
      title: mAm ? 'ስብሰባው ተይዟል' : 'Session Scheduled',
      body: mAm ? 'ስብሰባዎ በተሳካ ሁኔታ ተዘጋጅቷል።' : 'Your session is all set.',
      fields: [
        ['📆', mAm ? 'ቀን' : 'Date', dateStr],
        ['⏰', mAm ? 'ሰዓት' : 'Time', timeStr],
        ['👥', mAm ? 'ዓይነት' : 'Type', state.tempData.type === 'private' ? (mAm ? 'የግል' : 'Private') : (mAm ? 'የቡድን' : 'Group')],
      ],
    });

    // A button that opens the session page inside the app, instead of a raw
    // link in the message text (same as the mentee invite and the reminders).
    await bot.sendMessage(chatId, mentorMsg, {
      ...HTML,
      reply_markup: goldKeyboard(tSync(lang, 'btn_join_session'), `${APP_URL}?start=session_${sess.id}`)
    });
    console.log(`[Scheduler] Success: Session ${sess.id} created for mentor ${chatId}`);

    if (menteeId && !isGroup) {
      await notifySessionInvite(menteeId, {
        session_id: sess.id,
        host: 'Your mentor',
        title: 'Session',
        scheduled_at: scheduledAt.toISOString()
      });
    }
    clearState(chatId);
    await showMainMenu(chatId);
  } catch (e) {
    console.error(`[Scheduler] Error creating session:`, e.message);
    await safeSend(chatId, `❌ Failed to schedule session. Please try again.`);
  }
}

// Friendly "please register" card with a gold Register button, used wherever
// an unregistered person taps a deep link or a command that needs an account.
async function sendRegisterPrompt(chatId, lang = 'en', reason = 'welcome') {
  const am = lang === 'am';
  const body = reason === 'apply'
    ? (am ? 'አማካሪ ለመሆን ማመልከት ከመቻልዎ በፊት በ Holy መተግበሪያ ይመዝገቡ።' : 'Please register in the Holy app before applying to be a mentor.')
    : (am ? 'ወደ Holy የምክር ቦት እንኳን በደህና መጡ። ለምክርና ለመንፈሳዊ እድገት የተዘጋጀ ቦታ ነው። ለመጀመር በመተግበሪያው ይመዝገቡ።'
          : 'Welcome to Holy Counseling, a dedicated space for mentorship and spiritual growth. Register in the Holy app to get started.');
  const text = card({
    icon: '🕊️',
    title: am ? 'እንኳን ደህና መጡ' : 'Welcome',
    body,
    footer: am ? 'ጉዞዎ እዚህ ይጀምራል 🌱' : 'Your journey starts here 🌱',
  });
  return safeSend(chatId, text, { ...HTML, reply_markup: goldKeyboard(am ? 'ይመዝገቡ' : 'Register', `${APP_URL}?start=register`) });
}

// ─── Registration Wizard ──────────────────────────────────────────────────────

async function startRegistration(chatId, startParam = null) {
  setState(chatId, 'reg_sex', null, { startParam });
  await safeSend(chatId, "Welcome! Let's get you set up. First, what is your sex?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Male', callback_data: 'reg_sex_M' }, { text: 'Female', callback_data: 'reg_sex_F' }]
      ]
    }
  });
}

// ─── Mentor Search with Sorting, Pagination, Availability ────────────────────

const SORT_OPTIONS = ['rating', 'experience', 'random'];

async function listMentors(chatId, page = 0, topicId, sort = 'rating') {
  const lang = await getUserLang(chatId);

  // Loading indicator
  const loadMsg = await safeSendLoading(chatId, tSync(lang, 'loading_mentors'));

  const numericTopicId = Number(topicId);
  if (isNaN(numericTopicId)) {
    if (loadMsg) await deleteMessage(chatId, loadMsg.message_id);
    return safeSend(chatId, tSync(lang, 'no_mentors_topic'));
  }

  const { data: mIds } = await supabase.from('mentor_topics').select('telegram_id').eq('topic_id', numericTopicId);
  const ids = (mIds || []).map(x => x.telegram_id);

  if (!ids.length) {
    if (loadMsg) await deleteMessage(chatId, loadMsg.message_id);
    return safeSend(chatId, tSync(lang, 'no_mentors_topic'));
  }

  // Check waiting list eligibility
  const { data: existingWait } = await supabase.from('waiting_list').select('id')
    .eq('user_id', chatId).eq('topic_id', numericTopicId).eq('notified', false).single();

  // Get user's sex for same‑sex matching
  const { data: userData } = await supabase
    .from('users')
    .select('sex')
    .eq('telegram_id', chatId)
    .single();

  const userSex = userData?.sex;

  let query = supabase.from('users')
    .select('telegram_id, anonymous_id, rating, rating_count, last_active, user_settings(bio, display_name, max_mentees)')
    .in('telegram_id', ids)
    .eq('is_banned', false)
    .eq('role', 'mentor');

  // Apply same‑sex filter (unless user chose 'prefer_not')
  if (userSex && userSex !== 'prefer_not') {
    query = query.or(`sex.eq.${userSex},sex.eq.prefer_not`);
  }

  const { data: allMentors, error: queryError } = await query;
  if (queryError) {
    console.error('[listMentors] Supabase error:', queryError.message);
    if (loadMsg) await deleteMessage(chatId, loadMsg.message_id);
    return safeSend(chatId, tSync(lang, 'no_mentors_topic'));
  }

  // Count active mentees per mentor to filter out full ones
  if (!allMentors?.length) {
    if (loadMsg) await deleteMessage(chatId, loadMsg.message_id);
    return safeSend(chatId, tSync(lang, 'no_mentors_topic'));
  }

  const mentorIds = allMentors.map(m => m.telegram_id);
  const { data: assignments } = await supabase.from('mentorship_assignments')
    .select('mentor_id')
    .in('mentor_id', mentorIds)
    .eq('is_active', true);

  const menteeCount = {};
  (assignments || []).forEach(a => { menteeCount[a.mentor_id] = (menteeCount[a.mentor_id] || 0) + 1; });

  let available = allMentors.filter(m => (menteeCount[m.telegram_id] || 0) < (m.user_settings?.max_mentees || DEFAULT_MAX_MENTEES));

  // Sort
  if (sort === 'rating') {
    available.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } else if (sort === 'experience') {
    // Use rating_count as proxy for experience
    available.sort((a, b) => (b.rating_count || 0) - (a.rating_count || 0));
  } else if (sort === 'random') {
    available.sort(() => Math.random() - 0.5);
  }

  const total = available.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const paginated = available.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (loadMsg) await deleteMessage(chatId, loadMsg.message_id);

  if (!paginated.length) {
    // No available mentors — offer waiting list
    const kb = { inline_keyboard: [] };
    if (!existingWait) {
      kb.inline_keyboard.push([{ text: tSync(lang, 'btn_join_waitlist'), callback_data: `waitlist_join_${numericTopicId}` }]);
    } else {
      kb.inline_keyboard.push([{ text: tSync(lang, 'btn_already_waitlist'), callback_data: 'noop' }]);
    }
    return safeSend(chatId, tSync(lang, 'all_mentors_full'), { reply_markup: kb });
  }

  await safeSend(chatId, `🔍 *${tSync(lang, 'mentor_list_title')}* (${tSync(lang, 'page_indicator', { cur: page + 1, total: totalPages })})`, { skipOpenAnchor: true });

  for (const m of paginated) {
    const badge = onlineBadge(m.last_active);
    const displayName = mdEscape(m.user_settings?.display_name || m.anonymous_id);
    const bio = mdEscape(m.user_settings?.bio || tSync(lang, 'no_bio'));
    const stars = renderStars(m.rating, m.rating_count);
    const status = isOnline(m.last_active) ? tSync(lang, 'status_online') : tSync(lang, 'status_away');
    const slots = (m.user_settings?.max_mentees || DEFAULT_MAX_MENTEES) - (menteeCount[m.telegram_id] || 0);

    let text = `${badge} *${displayName}*\n`;
    text += `${tSync(lang, 'label_status')}: ${status}\n`;
    text += `${tSync(lang, 'label_rating')}: ${stars}\n`;
    text += `${tSync(lang, 'label_slots')}: ${slots}\n`;
    text += `${tSync(lang, 'label_bio')}: ${bio.substring(0, 80)}${bio.length > 80 ? '…' : ''}`;

    // Each mentor gets their own message with their Request button directly
    // beneath them, instead of a shared button block after the whole list.
    await safeSend(chatId, text, {
      reply_markup: { inline_keyboard: [[{ text: `${tSync(lang, 'btn_request')} ${displayName}`, callback_data: `mentor_req_${m.telegram_id}_${numericTopicId}` }]] },
      skipOpenAnchor: true
    });
  }

  // Sort + pagination controls apply to the whole list, so they go in one
  // trailing message rather than attached to any single mentor.
  const sortRow = SORT_OPTIONS.map(s => ({
    text: `${s === sort ? '✅ ' : ''}${tSync(lang, `sort_${s}`)}`,
    callback_data: `mentor_sort_${s}_${numericTopicId}_${page}`
  }));
  const controlButtons = [sortRow];

  const navRow = [];
  if (page > 0) navRow.push({ text: tSync(lang, 'btn_prev'), callback_data: `mentors_page_${page - 1}_${numericTopicId}_${sort}` });
  if (page < totalPages - 1) navRow.push({ text: tSync(lang, 'btn_next'), callback_data: `mentors_page_${page + 1}_${numericTopicId}_${sort}` });
  if (navRow.length) controlButtons.push(navRow);

  const controlsLabel = lang === 'am' ? '⚙️ ደርድር/ገጽ' : '⚙️ Sort / page';
  await safeSend(chatId, controlsLabel, { reply_markup: { inline_keyboard: controlButtons } });
}

// Sends each mentee as its own message with its Chat/End buttons directly
// beneath it, instead of one big list followed by a detached button block.
async function sendMenteeList(chatId, lang, mentees) {
  await safeSend(chatId, `👥 *${tSync(lang, 'my_mentees_title')}*`, { skipOpenAnchor: true });

  for (let i = 0; i < mentees.length; i++) {
    const m = mentees[i];
    const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', m.user_id).single();
    const menteeText = `👤 @${mdEscape(u?.anonymous_id || String(m.user_id))} (${mdEscape(topicLabel(m.topics, lang))})`;
    const isLast = i === mentees.length - 1;
    await safeSend(chatId, menteeText, {
      reply_markup: {
        inline_keyboard: [[
          { text: lang === 'am' ? '💬 አውራ' : '💬 Chat', callback_data: `focus_chat_${m.user_id}` },
          { text: `❌ ${tSync(lang, 'btn_end')} @${u?.anonymous_id || m.user_id}`, callback_data: `end_mentorship_${m.user_id}` }
        ]]
      },
      skipOpenAnchor: !isLast
    });
  }
}

// ─── Waiting List ─────────────────────────────────────────────────────────────

async function joinWaitingList(chatId, topicId) {
  const lang = await getUserLang(chatId);
  await supabase.from('waiting_list').upsert(
    { user_id: chatId, topic_id: topicId, joined_at: new Date().toISOString(), notified: false },
    { onConflict: 'user_id,topic_id' }
  );
  await sendCard(chatId, {
    icon: '⏳',
    title: lang === 'am' ? 'ተጠባባቂ ዝርዝር ውስጥ ገብተዋል' : "You're on the Waiting List",
    body: tSync(lang, 'waitlist_joined'),
    footer: lang === 'am' ? 'ትዕግስትዎ ዋጋ ይኖረዋል 🙏' : 'Good things are worth the wait 🙏',
  });
}

async function notifyWaitingList(topicId) {
  const { data: waiting } = await supabase.from('waiting_list')
    .select('user_id')
    .eq('topic_id', topicId)
    .eq('notified', false)
    .order('joined_at')
    .limit(3);

  if (!waiting?.length) return;
  for (const w of waiting) {
    const lang = await getUserLang(w.user_id);
    await sendCard(w.user_id, {
      icon: '🎉',
      title: lang === 'am' ? 'የአማካሪ ቦታ ክፍት ሆኗል' : 'A Mentor Spot Opened Up',
      body: tSync(lang, 'waitlist_mentor_available').replace(/\s*\/menu\s*$/, '').replace(/[፦:]\s*$/, lang === 'am' ? '።' : '.'),
      footer: lang === 'am' ? 'ቦታው ከመሞላቱ በፊት ፍጠኑ 💛' : 'Be quick before it fills up 💛',
    }, { label: lang === 'am' ? 'አማካሪዎችን ክፈት' : 'Find a Mentor', url: `${APP_URL}?start=mentors` });
    await supabase.from('waiting_list').update({ notified: true }).eq('user_id', w.user_id).eq('topic_id', topicId);
  }
}

// ─── Chat Forwarding ──────────────────────────────────────────────────────────

async function getActiveChatPartners(chatId) {
  const { data: mentorAss } = await supabase.from('mentorship_assignments').select('mentor_id').eq('user_id', chatId).eq('is_active', true);
  if (mentorAss?.length > 0) return { role: 'mentee', partners: mentorAss.map(a => a.mentor_id) };

  const { data: menteeAss } = await supabase.from('mentorship_assignments').select('user_id').eq('mentor_id', chatId).eq('is_active', true);
  if (menteeAss?.length > 0) return { role: 'mentor', partners: menteeAss.map(a => a.user_id) };

  return null;
}

async function forwardMessage(fromId, toId, text, srcMessageId = null) {
  // Insert message into database
  const { data: msg, error } = await supabase
    .from('messages')
    .insert({ from_id: fromId, to_id: toId, content: text })
    .select()
    .single();

  if (error) {
    console.error('[forwardMessage] DB error:', error);
    return;
  }

  // Send Telegram notification (existing code)
  const [{ data: sender }, { data: recipient }] = await Promise.all([
    supabase.from('users').select('anonymous_id, role').eq('telegram_id', fromId).single(),
    supabase.from('users').select('chat_id, role').eq('telegram_id', toId).single()
  ]);

  const lang = await getUserLang(toId);
  if (recipient?.chat_id) {
    const roleLabel = sender?.role === 'mentor' ? tSync(lang, 'role_mentor') : tSync(lang, 'role_mentee');
    const msgText = tSync(lang, 'msg_from_partner', { role: roleLabel, nick: mdEscape(sender?.anonymous_id), text: mdEscape(text) });
    // Reattach the bottom reply keyboard here too — this notification is
    // often the first message a recipient sees in a session, and without a
    // keyboard field on it the client can be left showing no keyboard at
    // all until the user types /start.
    const sentCopy = await safeSend(recipient.chat_id, msgText, {
      reply_markup: buildPersistentKeyboard(recipient.role || 'user', lang)
    });
    setState(toId, 'chat_active', fromId);

    // Remember both Telegram messages so an edit in the bot chat can follow
    // (sender's own message -> app row -> recipient's copy).
    if (srcMessageId || sentCopy) {
      const { error: mapErr } = await supabase.from('message_tg_notifications').upsert({
        message_id: msg.id,
        chat_id: sentCopy?.chat.id ?? null,
        tg_message_id: sentCopy?.message_id ?? null,
        src_chat_id: srcMessageId ? fromId : null,
        src_tg_message_id: srcMessageId || null,
        from_id: fromId,
        to_id: toId,
      });
      if (mapErr) console.warn('[Bot] Could not store message mapping:', mapErr.message);
    }
  }

  // ✨ NEW: Emit socket event for mini app real-time update
  if (global.io && global.onlineUsers) {
    const recipientSocket = global.onlineUsers.get(String(toId));
    if (recipientSocket) {
      global.io.to(recipientSocket).emit('new_message', msg);
      console.log(`[Socket] Real-time message sent to ${toId}`);
    }
  }
}

// ─── Voice / File Attachment Forwarding ───────────────────────────────────────
// Shared logic for resolving which active mentorship partner a message should
// go to. Used by both plain-text forwarding (above) and file/voice forwarding
// (below) so the "which partner" behavior stays identical for every message
// type.
// `pending` (optional) is the message/file we couldn't deliver yet because
// the sender has multiple active partners. When supplied, we stash it on
// the user's state and prompt with tappable buttons instead of asking the
// user to type `/reply @nickname` — nicknames contain underscores, which
// legacy Markdown mangles in the list (see mdEscape usage below), so
// hand-typed matches were unreliable. Buttons carry the real telegram_id in
// callback_data, so there's nothing to mistype or mis-render.
async function resolveChatTarget(chatId, state, pending = null) {
  const partnersInfo = await getActiveChatPartners(chatId);
  if (!partnersInfo) {
    const lang = await getUserLang(chatId);
    await safeSend(chatId, tSync(lang, 'no_active_mentor'), {
      reply_markup: { inline_keyboard: [[{ text: tSync(lang, 'btn_find_mentor'), callback_data: 'menu_mentors' }]] }
    });
    return null;
  }

  if (partnersInfo.partners.length === 1) {
    return partnersInfo.partners[0];
  }

  if (state?.step === 'chat_active' && state.targetId) {
    return state.targetId;
  }

  const lang = await getUserLang(chatId);
  const { data: mentees } = await supabase.from('users').select('telegram_id, anonymous_id').in('telegram_id', partnersInfo.partners);

  if (pending) {
    setState(chatId, 'awaiting_target', null, { pending });
    const buttons = mentees.map(m => [{ text: m.anonymous_id, callback_data: `select_target_${m.telegram_id}` }]);
    await safeSend(chatId, tSync(lang, 'select_target_prompt'), { reply_markup: { inline_keyboard: buttons } });
    return null;
  }

  // Fallback path (e.g. legacy /reply without a pending payload): keep the
  // typed list, but escape anonymous_id so a stray underscore doesn't get
  // eaten by Markdown italics parsing and silently corrupt the nickname
  // the user sees/copies.
  let listStr = tSync(lang, 'multiple_partners') + '\n\n';
  mentees.forEach((m, i) => listStr += `${i + 1}. @${mdEscape(m.anonymous_id)}\n`);
  listStr += `\n${tSync(lang, 'use_reply_cmd')}`;
  await safeSend(chatId, listStr);
  return null;
}

// Detect which kind of attachment (if any) a Telegram message object carries.
// Returns null for ordinary text messages.
function detectFileType(msg) {
  if (msg.voice) return 'voice';
  if (msg.audio) return 'audio';
  if (msg.video) return 'video';
  if (msg.document) return 'document';
  if (msg.photo && msg.photo.length) return 'photo';
  return null;
}

// Pull the metadata Telegram gives us for each attachment type into a common
// shape: { file_id, file_size, mime_type, duration, file_name }.
function extractFileMeta(msg, fileType) {
  switch (fileType) {
    case 'voice':
      return {
        file_id: msg.voice.file_id,
        file_size: msg.voice.file_size || null,
        mime_type: msg.voice.mime_type || 'audio/ogg',
        duration: msg.voice.duration || null,
        file_name: null
      };
    case 'audio':
      return {
        file_id: msg.audio.file_id,
        file_size: msg.audio.file_size || null,
        mime_type: msg.audio.mime_type || null,
        duration: msg.audio.duration || null,
        file_name: msg.audio.file_name || msg.audio.title || null
      };
    case 'video':
      return {
        file_id: msg.video.file_id,
        file_size: msg.video.file_size || null,
        mime_type: msg.video.mime_type || 'video/mp4',
        duration: msg.video.duration || null,
        file_name: msg.video.file_name || null
      };
    case 'document':
      return {
        file_id: msg.document.file_id,
        file_size: msg.document.file_size || null,
        mime_type: msg.document.mime_type || null,
        duration: null,
        file_name: msg.document.file_name || null
      };
    case 'photo': {
      // Telegram sends the same photo at several resolutions; the last
      // entry in the array is always the largest.
      const largest = msg.photo[msg.photo.length - 1];
      return {
        file_id: largest.file_id,
        file_size: largest.file_size || null,
        mime_type: 'image/jpeg',
        duration: null,
        file_name: null
      };
    }
    default:
      return null;
  }
}

// Insert a voice/audio/video/document/photo message into Supabase, forward
// the actual file to the recipient on Telegram (using the persistent
// file_id, so we never re-upload the bytes ourselves), and push a real-time
// socket update to the mini app — mirroring forwardMessage() above.
async function forwardFileMessage(fromId, toId, fileType, meta, caption = '') {
  const { data: msg, error } = await supabase
    .from('messages')
    .insert({
      from_id: fromId,
      to_id: toId,
      content: caption, // caption doubles as the text content; may be ''
      file_id: meta.file_id,
      file_type: fileType,
      file_size: meta.file_size,
      mime_type: meta.mime_type,
      duration: meta.duration,
      file_name: meta.file_name
    })
    .select()
    .single();

  if (error) {
    console.error('[forwardFileMessage] DB error:', error);
    return;
  }

  const [{ data: sender }, { data: recipient }] = await Promise.all([
    supabase.from('users').select('anonymous_id, role').eq('telegram_id', fromId).single(),
    supabase.from('users').select('chat_id, role').eq('telegram_id', toId).single()
  ]);

  if (recipient?.chat_id) {
    const lang = await getUserLang(toId);
    const roleLabel = sender?.role === 'mentor' ? tSync(lang, 'role_mentor') : tSync(lang, 'role_mentee');
    // e.g. "🎙️ Your mentee, Lotus, sent you a voice message."
    // (Wording lives in local/*.json: msg_from_partner_file + file_label_*.
    // No "@": these are anonymous handles, not Telegram usernames, and an "@"
    // makes Telegram render them as a tappable mention of a real account.)
    const fileIcons = { voice: '🎙️', audio: '🎵', video: '🎬', photo: '🖼️', document: '📎' };
    const label = tSync(lang, 'msg_from_partner_file', {
      icon: fileIcons[fileType] || '📎',
      role: roleLabel,
      nick: mdEscape(sender?.anonymous_id),
      type: tSync(lang, `file_label_${fileType}`)
    });
    // Same keyboard reattachment as forwardMessage — see comment there.
    await safeSend(recipient.chat_id, label, {
      reply_markup: buildPersistentKeyboard(recipient.role || 'user', lang)
    });

    // Forward the actual file using its file_id — Telegram re-serves the
    // same stored bytes, so this costs no extra bandwidth or storage on our side.
    try {
      const sendOpts = caption ? { caption } : {};
      switch (fileType) {
        case 'voice': await bot.sendVoice(recipient.chat_id, meta.file_id, sendOpts); break;
        case 'audio': await bot.sendAudio(recipient.chat_id, meta.file_id, sendOpts); break;
        case 'video': await bot.sendVideo(recipient.chat_id, meta.file_id, sendOpts); break;
        case 'photo': await bot.sendPhoto(recipient.chat_id, meta.file_id, sendOpts); break;
        case 'document': await bot.sendDocument(recipient.chat_id, meta.file_id, sendOpts); break;
      }
    } catch (err) {
      console.error(`[forwardFileMessage] Failed to forward ${fileType} to ${toId}:`, err.message);
    }

    setState(toId, 'chat_active', fromId);
  }

  // ✨ Emit socket event for mini app real-time update (same event name as
  // text messages — the mini app inspects msg.file_type to decide how to render it).
  if (global.io && global.onlineUsers) {
    const recipientSocket = global.onlineUsers.get(String(toId));
    if (recipientSocket) {
      global.io.to(recipientSocket).emit('new_message', msg);
      console.log(`[Socket] Real-time ${fileType} message sent to ${toId}`);
    }
  }
}

// Entry point called from the message handler once we know msg carries an
// attachment. Resolves the active chat partner (same rule as text messages)
// then forwards.
async function handleFileMessage(chatId, msg, fileType, state) {
  const meta = extractFileMeta(msg, fileType);
  if (!meta || !meta.file_id) return;

  const caption = (msg.caption || '').trim();
  const targetId = await resolveChatTarget(chatId, state, { type: 'file', fileType, meta, caption });
  if (!targetId) return;

  await forwardFileMessage(chatId, targetId, fileType, meta, caption);
}

// ─── Rating System ────────────────────────────────────────────────────────────

async function promptRating(userId, mentorId) {
  const lang = await getUserLang(userId);
  const { data: mentor } = await supabase.from('users').select('anonymous_id, public_alias').eq('telegram_id', mentorId).single();
  const displayName = mentor?.public_alias || mentor?.anonymous_id;
  setState(userId, 'rating_pending', mentorId, { mentorId });
  await safeSend(userId, card({
    icon: '⭐',
    title: lang === 'am' ? 'ልምድዎን ደረጃ ይስጡ' : 'Rate Your Mentor',
    body: tSync(lang, 'rate_mentor_prompt', { name: displayName }),
    footer: lang === 'am' ? 'አስተያየትዎ ሌሎችን ይረዳል 🙏' : 'Your feedback helps others 🙏',
  }), {
    ...HTML,
    reply_markup: {
      inline_keyboard: [
        [1, 2, 3, 4, 5].map(n => ({ text: '⭐'.repeat(n), callback_data: `rate_${mentorId}_${n}` }))
      ]
    }
  });
}

async function submitRating(chatId, mentorId, stars) {
  const lang = await getUserLang(chatId);
  const { data: mentor } = await supabase.from('users').select('rating, rating_count').eq('telegram_id', mentorId).single();
  const oldCount = mentor?.rating_count || 0;
  const oldRating = mentor?.rating || 0;

  const { data: existing } = await supabase
    .from('mentor_ratings')
    .select('stars')
    .eq('mentor_id', mentorId)
    .eq('user_id', chatId)
    .maybeSingle();

  let newCount, newRating;
  if (existing) {
    newCount = oldCount;
    newRating = oldCount > 0 ? (oldRating * oldCount - existing.stars + stars) / oldCount : stars;
  } else {
    newCount = oldCount + 1;
    newRating = (oldRating * oldCount + stars) / newCount;
  }

  await supabase.from('users').update({ rating: newRating, rating_count: newCount }).eq('telegram_id', mentorId);
  await supabase.from('mentor_ratings').upsert(
    { mentor_id: mentorId, user_id: chatId, stars, created_at: new Date().toISOString() },
    { onConflict: 'mentor_id,user_id' }
  );

  clearState(chatId);
  await sendCard(chatId, {
    icon: '💛',
    title: lang === 'am' ? 'አስተያየትዎን ስለላኩ እናመሰግናለን' : 'Thank You for Your Feedback',
    body: tSync(lang, 'rating_submitted', { stars: '⭐'.repeat(stars) }),
  });
  await showMainMenu(chatId);
}

// ─── Mentee → mentor guard ────────────────────────────────────────────────────

// A current mentee has to end their mentorship, rate the mentor and give a
// reason before applying, and that form lives in the mini app. Returns true
// (after pointing them there) when the user still has an active mentor.
async function blockApplyIfActiveMentee(chatId, lang) {
  const { data: active } = await supabase
    .from('mentorship_assignments').select('id')
    .eq('user_id', chatId).eq('is_active', true).maybeSingle();
  if (!active) return false;
  await safeSend(chatId, card({
    icon: '🌿',
    title: lang === 'am' ? 'መጀመሪያ የአሁኑን የምክር ጉዞ ይዝጉ' : 'Finish Your Current Mentorship First',
    body: tSync(lang, 'apply_end_mentorship_first'),
  }), { ...HTML, reply_markup: goldKeyboard(tSync(lang, 'btn_open_app'), APP_URL) });
  return true;
}

// ─── End Mentorship ───────────────────────────────────────────────────────────

// opts.skipRatingPrompt: the caller already collected a rating (mini app's
// end-and-rate flow), so don't send the Telegram rating prompt as well.
function endedCard(lang, body) {
  return {
    icon: '🕊️',
    title: lang === 'am' ? 'የምክር ጉዞው ተጠናቅቋል' : 'Mentorship Ended',
    body,
    footer: lang === 'am' ? 'ለጊዜዎ እናመሰግናለን 💛' : 'Thank you for walking this journey 💛',
  };
}

async function endMentorship(chatId, partnerId, initiatorRole, opts = {}) {
  // Get initiator and partner details
  const [{ data: initiator }, { data: partner }] = await Promise.all([
    supabase.from('users').select('anonymous_id').eq('telegram_id', chatId).single(),
    supabase.from('users').select('anonymous_id').eq('telegram_id', partnerId).single()
  ]);

  const initiatorName = initiator?.anonymous_id || 'Someone';
  const partnerName = partner?.anonymous_id || 'the other user';

  // Record who ended it on the still-active row (analytics). Ignored if the
  // ended_by column hasn't been migrated yet.
  await supabase.from('mentorship_assignments')
    .update({ ended_by: initiatorRole === 'mentor' ? 'mentor' : 'mentee' })
    .eq('is_active', true)
    .or(`and(mentor_id.eq.${chatId},user_id.eq.${partnerId}),and(mentor_id.eq.${partnerId},user_id.eq.${chatId})`);

  // Update assignment: mark it inactive
  await supabase.from('mentorship_assignments')
    .update({ is_active: false, ended_at: new Date().toISOString() })
    .or(`and(mentor_id.eq.${chatId},user_id.eq.${partnerId}),and(mentor_id.eq.${partnerId},user_id.eq.${chatId})`);

  // The mentor just got a spot back - tell anyone waiting on them.
  require('./utils').notifyMentorWaitlist(supabase, initiatorRole === 'mentor' ? chatId : partnerId).catch(() => {});

  // Mark all unread messages between these two users as read so the badge
  // clears immediately for both parties without requiring a page reload.
  await supabase
    .from('messages')
    .update({ is_read: true })
    .or(`and(from_id.eq.${chatId},to_id.eq.${partnerId}),and(from_id.eq.${partnerId},to_id.eq.${chatId})`)
    .eq('is_read', false);

  // Custom messages based on who ended
  const initiatorLang = await getUserLang(chatId);
  const partnerLang = await getUserLang(partnerId);

  if (initiatorRole === 'mentor') {
    // Mentor ended it → notify mentee
    await sendCard(chatId, endedCard(initiatorLang, tSync(initiatorLang, 'mentorship_ended')));
    await sendCard(partnerId, endedCard(partnerLang, tSync(partnerLang, 'mentorship_ended_by_mentor', { mentor: initiatorName })));
    await promptRating(partnerId, chatId);
  } else {
    // Mentee ended it → notify mentor
    await sendCard(chatId, endedCard(initiatorLang, tSync(initiatorLang, 'mentorship_ended')));
    await sendCard(partnerId, endedCard(partnerLang, tSync(partnerLang, 'mentorship_ended_by_mentee', { mentee: initiatorName })));
    if (!opts.skipRatingPrompt) await promptRating(chatId, partnerId);
  }

  // Live update for the other person (rating prompt, chat, badges) if the app is open.
  if (global._io) {
    global._io.to(`user:${partnerId}`).emit('mentorship_ended', { by: initiatorRole });
  }

  // Check waiting list for now-available mentor
  const { data: mt } = await supabase.from('mentor_topics').select('topic_id').eq('telegram_id',
    initiatorRole === 'mentor' ? chatId : partnerId
  );
  for (const row of mt || []) await notifyWaitingList(row.topic_id);
}

// ─── Amharic Translation ──────────────────────────────────────────────────────

async function getAmharicVerse(verseText) {
  try {
    const res = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(verseText)}&langpair=en|am`);
    return res.data?.responseData?.translatedText || null;
  } catch { return null; }
}

// ─── Daily Verse ──────────────────────────────────────────────────────────────

async function handleDailyVerse(chatId) {
  const lang = await getUserLang(chatId);
  const { data: vs } = await supabase.from('daily_verses').select('*').eq('is_active', true).order('id', { ascending: true });
  const v = vs?.[Math.floor(Date.now() / 86400000) % (vs.length || 1)];
  if (!v) return safeSend(chatId, tSync(lang, 'no_verse'));

  let text = `📖 *${tSync(lang, 'verse_title')}*\n*${mdEscape(v.reference)}*\n\n${mdEscape(v.text)}`;
  await safeSend(chatId, text);
}

// ─── Streak ───────────────────────────────────────────────────────────────────

async function handleStreakFlow(chatId) {
  const lang = await getUserLang(chatId);
  let [{ data: s }, { data: vs }] = await Promise.all([
    supabase.from('bible_streaks').select('*').eq('telegram_id', chatId).single(),
    supabase.from('daily_verses').select('*').eq('is_active', true).order('id', { ascending: true })
  ]);

  const v = vs?.[Math.floor(Date.now() / 86400000) % (vs?.length || 1)] || { reference: '...', text: '...' };
  const now = getEthiopiaNow();
  const today = now.toISOString().split('T')[0];
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  const yestStr = yest.toISOString().split('T')[0];

  // Reset logic: if last read was before yesterday, streak is broken
  if (s && s.last_read_date && s.last_read_date !== today && s.last_read_date !== yestStr) {
    await supabase.from('bible_streaks').update({ current_streak: 0 }).eq('telegram_id', chatId);
    s.current_streak = 0;
  }

  const alreadyRead = s?.last_read_date === today;

  const text = tSync(lang, 'streak_display', {
    count: s?.current_streak || 0,
    longest: s?.longest_streak || 0,
    reference: mdEscape(v.reference),
    verse: mdEscape(v.text)
  });

  const kb = { inline_keyboard: [] };
  if (!alreadyRead) kb.inline_keyboard.push([{ text: tSync(lang, 'btn_mark_read'), callback_data: 'streak_mark' }]);
  else kb.inline_keyboard.push([{ text: tSync(lang, 'streak_already_read'), callback_data: 'noop' }]);

  await safeSend(chatId, text, { reply_markup: kb });
}

async function markStreakAsRead(chatId) {
  const lang = await getUserLang(chatId);
  const now = getEthiopiaNow();
  const today = now.toISOString().split('T')[0];
  const { data: s } = await supabase.from('bible_streaks').select('*').eq('telegram_id', chatId).single();

  if (!s) {
    await supabase.from('bible_streaks').insert({ telegram_id: chatId, current_streak: 1, longest_streak: 1, last_read_date: today });
  } else if (s.last_read_date !== today) {
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    const consecutive = s.last_read_date === yest.toISOString().split('T')[0];
    const n = consecutive ? s.current_streak + 1 : 1;
    await supabase.from('bible_streaks').update({
      current_streak: n, longest_streak: Math.max(n, s.longest_streak || 0), last_read_date: today
    }).eq('telegram_id', chatId);
  }
  await safeSend(chatId, tSync(lang, 'streak_marked'));
  await handleStreakFlow(chatId);
}

// ─── Journal ──────────────────────────────────────────────────────────────────

async function viewJournalEntries(chatId, page = 0) {
  const lang = await getUserLang(chatId);
  const { data: es } = await supabase.from('journal_entries').select('id, content, created_at')
    .eq('telegram_id', chatId).order('created_at', { ascending: false })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

  if (!es?.length) return safeSend(chatId, tSync(lang, 'journal_empty'));

  const buttons = es.map(e => [{
    text: `${new Date(e.created_at).toLocaleDateString()}: ${e.content.substring(0, 20)}…`,
    callback_data: `journal_read_${e.id}`
  }]);
  const nav = [];
  if (page > 0) nav.push({ text: tSync(lang, 'btn_prev'), callback_data: `journal_view_${page - 1}` });
  nav.push({ text: tSync(lang, 'btn_next'), callback_data: `journal_view_${page + 1}` });
  buttons.push(nav);

  await safeSend(chatId, `📜 *${tSync(lang, 'journal_title')}*`, { reply_markup: { inline_keyboard: buttons } });
}

async function readJournalEntry(chatId, id) {
  const lang = await getUserLang(chatId);
  const { data: e } = await supabase.from('journal_entries').select('*').eq('id', id).single();
  if (e) await safeSend(chatId, `📅 ${formatUserDateTime(e.created_at)}\n\n${e.content}`, {
    reply_markup: { inline_keyboard: [[{ text: tSync(lang, 'btn_back'), callback_data: 'journal_view_0' }]] }
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function format12h(hour) {
  const h = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h}:00 ${ampm}`;
}

async function showSettings(chatId) {
  const lang = await getUserLang(chatId);
  const [{ data: user }, { data: s }] = await Promise.all([
    supabase.from('users').select('role').eq('telegram_id', chatId).single(),
    supabase.from('user_settings').select('*').eq('telegram_id', chatId).single()
  ]);

  const kb = {
    inline_keyboard: [
      [{ text: `${tSync(lang, 'settings_verse_notif')}: ${s?.notify_daily_verse ? tSync(lang, 'on') : tSync(lang, 'off')}`, callback_data: 'settings_toggle_notify_daily_verse' }],
      [{ text: `${tSync(lang, 'settings_msg_notif')}: ${s?.notify_messages ? tSync(lang, 'on') : tSync(lang, 'off')}`, callback_data: 'settings_toggle_notify_messages' }],
      [{ text: `${tSync(lang, 'settings_verse_time')}: ${format12h(s?.verse_time ?? 0)}`, callback_data: 'settings_time' }],
      [{ text: `${tSync(lang, 'settings_language')}: ${lang === 'en' ? 'EN' : 'አማ'}`, callback_data: 'settings_lang' }],
      [{ text: `${tSync(lang, 'settings_my_topics')}`, callback_data: 'settings_topics' }]
    ]
  };

  if (user?.role === 'mentor' || user?.role === 'admin') {
    kb.inline_keyboard.push([{ text: `${tSync(lang, 'settings_expertise_topics')}`, callback_data: 'menu_mentor_topics' }]);
  }

  await safeSend(chatId, tSync(lang, 'settings_title'), { reply_markup: kb });
}

async function toggleSetting(chatId, field) {
  const { data: s } = await supabase.from('user_settings').select('*').eq('telegram_id', chatId).single();

  // Default to true if settings are missing
  const currentValue = s ? s[field] : true;
  const newValue = !currentValue;

  if (!s) {
    const lang = await getUserLang(chatId);
    await supabase.from('user_settings').insert({ telegram_id: chatId, language: lang, [field]: newValue });
  } else {
    await supabase.from('user_settings').update({ [field]: newValue }).eq('telegram_id', chatId);
  }
  await showSettings(chatId);
}

// ─── Mentorship Helpers ───────────────────────────────────────────────────────

async function acceptMentorship(mentorId, userId, topicId) {
  const mentorLang = await getUserLang(mentorId);
  const userLang = await getUserLang(userId);

  // Verify mentor capacity (max_mentees lives in user_settings, not users)
  const { data: mentor } = await supabase.from('users').select('user_settings(max_mentees)').eq('telegram_id', mentorId).single();
  const { data: current } = await supabase.from('mentorship_assignments').select('id').eq('mentor_id', mentorId).eq('is_active', true);
  if ((current?.length || 0) >= (mentor?.user_settings?.max_mentees || DEFAULT_MAX_MENTEES)) {
    await sendCard(mentorId, {
      icon: '📋',
      title: mentorLang === 'am' ? 'የተመካሪ ቁጥርዎ ሞልቷል' : 'You Are at Capacity',
      body: tSync(mentorLang, 'mentor_at_capacity'),
    }, { label: tSync(mentorLang, 'btn_open_app') });
    await sendCard(userId, rejectedCard(userLang), { label: userLang === 'am' ? 'አማካሪዎችን ይፈልጉ' : 'Find a Mentor', url: `${APP_URL}?start=mentors` });
    await notifyWaitingList(topicId);
    return;
  }

  // RACE-CONDITION GUARD: a mentee can have several pending requests out at
  // once (they messaged multiple mentors). If another mentor already accepted
  // one of those requests, bail out here instead of creating a second active
  // assignment — the follow-up reconciliation below still catches the rare
  // case where two accepts land within the same instant.
  const { data: existingActive } = await supabase
    .from('mentorship_assignments')
    .select('mentor_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (existingActive) {
    await supabase.from('mentorship_requests').update({
      status: 'rejected',
      admin_note: 'Mentee already matched with another mentor',
      updated_at: new Date().toISOString()
    }).eq('mentor_id', mentorId).eq('user_id', userId);
    const { data: menteeInfo } = await supabase.from('users').select('anonymous_id, user_settings(display_name)').eq('telegram_id', userId).single();
    const menteeName = menteeInfo?.user_settings?.display_name || menteeInfo?.anonymous_id || 'A mentee';
    await safeSend(mentorId, tSync(mentorLang, 'mentorship_request_cancelled_elsewhere', { nick: mdEscape(menteeName) }));
    return;
  }

  // CRITICAL FIX: Ensure mentor_id is the mentor, user_id is the mentee
  const { error } = await supabase.from('mentorship_assignments').insert({
    mentor_id: mentorId,
    user_id: userId,
    topic_id: topicId,
    is_active: true,
    assigned_at: new Date().toISOString()
  });

  if (error) {
    console.error('[Accept] Insert error:', error);
    return;
  }

  await supabase.from('mentorship_requests').update({ status: 'accepted' }).eq('mentor_id', mentorId).eq('user_id', userId);
  await sendCard(userId, {
    icon: '🎉',
    title: userLang === 'am' ? 'የምክር ጥያቄዎ ተቀባይነት አግኝቷል' : 'Mentorship Request Accepted',
    body: tSync(userLang, 'mentorship_accepted'),
    footer: userLang === 'am' ? 'አዲስ ጉዞ ይጀምራል 🌱' : 'A new journey begins 🌱',
  }, { label: userLang === 'am' ? 'አሁን ያውሩ' : 'Chat Now' });
  await sendCard(mentorId, {
    icon: '🤝',
    title: mentorLang === 'am' ? 'ጥያቄውን ተቀብለዋል' : 'Request Accepted',
    body: tSync(mentorLang, 'mentorship_accepted_mentor'),
    footer: mentorLang === 'am' ? 'እግዚአብሔር ያበርታዎት 🙏' : 'Thank you for serving 🙏',
  }, { label: tSync(mentorLang, 'btn_open_app') });

  // The mentee may have requested several mentors at once — now that one has
  // accepted, auto-reject their other still-pending requests so mentors
  // don't sit on stale requests for someone who's already been matched.
  await rejectOtherPendingRequestsForUser(userId, mentorId);

  // Notify mini app via socket so it refreshes without needing a manual reload
  try {
    // Sockets join `user:<id>` (the old bare-id room had no members).
    const io = global._io;
    if (io) {
      io.to(`user:${mentorId}`).to(`user:${userId}`).emit('mentorship_request_updated', { status: 'accepted' });
    }
  } catch (e) {
    console.error('[bot] socket emit error (non-fatal):', e.message);
  }

  // Log success
  console.log(`[Accept] Assignment created: mentor=${mentorId}, user=${userId}, topic=${topicId}`);
}

function rejectedCard(lang) {
  return {
    icon: '💌',
    title: lang === 'am' ? 'የምክር ጥያቄ ምላሽ' : 'Mentorship Request Update',
    body: tSync(lang, 'mentor_rejected'),
    footer: lang === 'am' ? 'ተስፋ አይቁረጡ፤ ሌላ አማካሪ ይጠብቅዎታል 🌱' : 'Another mentor is ready to walk with you 🌱',
  };
}

async function rejectMentorship(mentorId, userId) {
  const mentorLang = await getUserLang(mentorId);
  const userLang = await getUserLang(userId);
  await supabase.from('mentorship_requests').update({ status: 'rejected' }).eq('mentor_id', mentorId).eq('user_id', userId);
  await sendCard(userId, rejectedCard(userLang), { label: userLang === 'am' ? 'አማካሪዎችን ይፈልጉ' : 'Find a Mentor', url: `${APP_URL}?start=mentors` });
  await sendCard(mentorId, {
    icon: '☑️',
    title: mentorLang === 'am' ? 'ጥያቄው ውድቅ ተደርጓል' : 'Request Declined',
    body: tSync(mentorLang, 'reject_confirmed'),
  });
  const io = global._io;
  if (io) {
    io.to(`user:${mentorId}`).to(`user:${userId}`).emit('mentorship_request_updated', { status: 'rejected' });
  }
}

async function rejectOtherPendingRequestsForUser(userId, acceptedMentorId, exceptRequestId) {
  try {
    // Includes 'accepted' as well as 'pending': if two mentors accepted the
    // same mentee within the same instant, the DB trigger
    // (enforce_single_active_assignment) already resolved which assignment
    // is truly active, but the loser's request row can be left stuck on
    // 'accepted' with no matching active assignment and no notification.
    // Sweeping both statuses here reconciles that stale state.
    let query = supabase
      .from('mentorship_requests')
      .select('*, user:user_id(anonymous_id, user_settings(display_name))')
      .eq('user_id', userId)
      .in('status', ['pending', 'accepted'])
      .neq('mentor_id', acceptedMentorId);

    // Only applied when explicitly provided — .neq('id', undefined) would
    // otherwise produce an invalid filter and silently return zero rows.
    if (exceptRequestId) query = query.neq('id', exceptRequestId);

    const { data: requests, error: fetchErr } = await query;

    if (fetchErr) {
      console.error('[rejectOtherPendingRequests] Fetch error:', fetchErr.message);
      return;
    }

    if (!requests || requests.length === 0) return;

    const requestIds = requests.map(r => r.id);

    const { error: updateErr } = await supabase
      .from('mentorship_requests')
      .update({
        status: 'rejected',
        admin_note: 'Mentee already matched with another mentor',
        updated_at: new Date().toISOString()
      })
      .in('id', requestIds);

    if (updateErr) {
      console.error('[rejectOtherPendingRequests] Update error:', updateErr.message);
      return;
    }

    for (const reqData of requests) {
      const mentorId = reqData.mentor_id;
      const menteeName = reqData.user?.user_settings?.display_name || reqData.user?.anonymous_id || 'A mentee';

      try {
        const mentorLang = await getUserLang(mentorId);
        await sendCard(mentorId, {
          icon: '🔔',
          title: mentorLang === 'am' ? 'ጥያቄው አይገኝም' : 'Request No Longer Available',
          body: tSync(mentorLang, 'mentorship_request_cancelled_elsewhere', { nick: menteeName }),
        });
      } catch (botErr) {
        console.error(`[rejectOtherPendingRequests] Bot notify error for mentor ${mentorId}:`, botErr.message);
      }

      try {
        if (global.io && global.onlineUsers) {
          const socketId = global.onlineUsers.get(String(mentorId));
          if (socketId) {
            global.io.to(socketId).emit('mentorship_request_updated', {
              requestId: reqData.id,
              status: 'rejected'
            });
          }
        }
      } catch (socketErr) {
        console.error(`[rejectOtherPendingRequests] Socket emit error for mentor ${mentorId}:`, socketErr.message);
      }
    }

    console.log(`[rejectOtherPendingRequests] Successfully rejected ${requests.length} other pending requests for mentee=${userId}`);
  } catch (err) {
    console.error('[rejectOtherPendingRequests] Unexpected error:', err.message);
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notifyMentorApproved(chatId) {
  const lang = await getUserLang(chatId);
  await safeSend(chatId, card({
    icon: '🎊',
    title: lang === 'am' ? 'ማመልከቻዎ ጸድቋል' : 'Application Approved',
    body: tSync(lang, 'mentor_approved'),
    footer: lang === 'am' ? 'እግዚአብሔር ያበርታዎት 🙏' : 'Thank you for serving 🙏',
  }), { ...HTML, reply_markup: goldKeyboard(tSync(lang, 'btn_open_app'), APP_URL) });
  const { data: mt } = await supabase.from('mentor_topics').select('topic_id').eq('telegram_id', chatId);
  if (!mt?.length) {
    const kb = await getMentorTopicKeyboard(chatId, lang);
    await safeSend(chatId, tSync(lang, 'set_expertise_prompt'), { reply_markup: kb });
  } else {
    await showMainMenu(chatId);
  }
}

async function notifyMentorRejected(chatId) {
  const lang = await getUserLang(chatId);
  const { data: app } = await supabase.from('mentor_applications').select('admin_note')
    .eq('telegram_id', chatId).order('reviewed_at', { ascending: false }).limit(1).single();
  const msg = card({
    icon: '💌',
    title: lang === 'am' ? 'የማመልከቻዎ ውጤት' : 'Application Update',
    body: tSync(lang, 'mentor_application_rejected'),
    fields: [['📝', tSync(lang, 'admin_note'), app?.admin_note]],
    footer: lang === 'am' ? 'በሌላ ጊዜ እንደገና መሞከር ይችላሉ 🌱' : 'You are welcome to apply again later 🌱',
  });
  await safeSend(chatId, msg, HTML);
}

// Delivers one broadcast item (plain text, or media with an optional caption)
// to a single chat. Returns true when Telegram accepted it. The admin's text is
// tried as Markdown first; if Telegram rejects the formatting (a stray * or _),
// the same content goes out as plain text instead of being dropped.
async function sendBroadcastItem(chatId, { text, media }) {
  const send = (parseMode) => {
    const opts = parseMode ? { parse_mode: parseMode } : {};
    opts.reply_markup = goldKeyboard('Open App', APP_URL);
    if (!media) return bot.sendMessage(chatId, text, opts);
    if (text) opts.caption = text;
    switch (media.type) {
      case 'photo': return bot.sendPhoto(chatId, media.file_id, opts);
      case 'video': return bot.sendVideo(chatId, media.file_id, opts);
      case 'animation': return bot.sendAnimation(chatId, media.file_id, opts);
      case 'voice': return bot.sendVoice(chatId, media.file_id, opts);
      case 'audio': return bot.sendAudio(chatId, media.file_id, opts);
      default: return bot.sendDocument(chatId, media.file_id, opts);
    }
  };
  try {
    await send('Markdown');
    return true;
  } catch (err) {
    let lastErr = err;
    if (/can't parse entities/i.test(err.message)) {
      try { await send(); return true; } catch (retryErr) { lastErr = retryErr; }
    }
    console.error(`[Broadcast] Failed to send to ${chatId}:`, lastErr.message);
    return false;
  }
}

// `media` is { type, file_id } as minted by the admin broadcast route. Nothing
// is added around the admin's text (members get exactly what was written),
// except the gold Open App button underneath.
async function broadcastToAll(message, roleFilter, media = null) {
  const users = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase.from('users').select('telegram_id').eq('is_banned', false);
    if (roleFilter) query = query.eq('role', roleFilter);
    const { data, error } = await query.order('telegram_id').range(from, from + 999);
    if (error) throw new Error(error.message);
    users.push(...data);
    if (data.length < 1000) break;
  }

  // Telegram allows ~30 messages/second overall, so go out in batches of 20
  // and never faster than one batch per second.
  const BATCH = 20;
  let sent = 0, failed = 0;
  for (let i = 0; i < users.length; i += BATCH) {
    const startedAt = Date.now();
    const results = await Promise.all(
      users.slice(i, i + BATCH).map((u) => sendBroadcastItem(u.telegram_id, { text: message, media }))
    );
    results.forEach((ok) => (ok ? sent++ : failed++));
    const wait = 1000 - (Date.now() - startedAt);
    if (wait > 0 && i + BATCH < users.length) await new Promise((r) => setTimeout(r, wait));
  }
  return { sent, failed, total: users.length };
}

async function notifySessionInvite(chatId, sessionInfo) {
  const lang = await getUserLang(chatId);
  const { data: settings } = await supabase.from('user_settings').select('timezone').eq('telegram_id', chatId).single();
  let recipientTimezone = settings?.timezone || 'Africa/Addis_Ababa';
  if (!recipientTimezone || recipientTimezone === 'UTC') recipientTimezone = 'Africa/Addis_Ababa';

  const scheduledAt = sessionInfo.scheduled_at || sessionInfo.scheduledAt;
  const timeStr = scheduledAt
    ? new Intl.DateTimeFormat('en-US', {
      timeZone: recipientTimezone,
      weekday: 'short', year: 'numeric', month: 'short',
      day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(scheduledAt))
    : 'TBD';

  const am = lang === 'am';
  const text = card({
    icon: '📅',
    title: am ? 'አዲስ ስብሰባ ተይዟል' : 'New Session Scheduled',
    body: am ? 'ለእርስዎ አዲስ የቀጥታ ስብሰባ ተዘጋጅቷል። መቀላቀልዎን አይርሱ!' : 'A new live session has been set up for you. Be sure to join!',
    fields: [
      ['👤', am ? 'አስተናጋጅ' : 'Host', sessionInfo.host],
      ['🎯', am ? 'ርዕስ' : 'Title', sessionInfo.title],
      ['⏰', am ? 'ሰዓት' : 'Time', timeStr],
    ],
    footer: am ? 'ቀጠሮዎን ያክብሩ 🙏' : 'See you there 🙏',
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(tSync(lang, 'btn_join_session'), `${APP_URL}?start=session_${sessionInfo.session_id}`)
  });
}

// "Starting soon" reminder — sent to the host and every invited participant
// roughly 10 minutes before a scheduled live session begins.
async function notifySessionReminder(chatId, sessionInfo) {
  const lang = await getUserLang(chatId);
  const am = lang === 'am';
  const text = card({
    icon: '⏰',
    title: am ? 'ስብሰባዎ ሊጀምር ነው' : 'Your Session Starts Soon',
    body: am ? 'የቀጥታ ውይይትዎ በ10 ደቂቃ ውስጥ ይጀምራል።' : 'Your live session begins in about 10 minutes.',
    fields: [['🎯', am ? 'ርዕስ' : 'Title', sessionInfo.title]],
    footer: am ? 'ዝግጁ ይሁኑ፤ ይጠብቁዎታል 🙏' : 'Get ready, everyone is waiting for you 🙏',
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(tSync(lang, 'btn_join_session'), `${APP_URL}?start=session_${sessionInfo.session_id}`)
  });
}

// "Your mentee is waiting" ping — sent to the host when a participant is in the
// lobby before the host has arrived. Callers throttle this per session.
async function notifySessionWaiting(chatId, sessionInfo) {
  const lang = await getUserLang(chatId);
  const am = lang === 'am';
  const who = sessionInfo.waiting_name || (am ? 'አንድ ተሳታፊ' : 'A participant');
  const text = card({
    icon: '🙋',
    title: am ? 'አንድ ተሳታፊ እየጠበቀዎት ነው' : 'Someone Is Waiting for You',
    body: am ? `${who} በመጠበቂያ ክፍሉ ውስጥ ነው።` : `${who} is in the lobby right now.`,
    fields: [['🎯', am ? 'ርዕስ' : 'Title', sessionInfo.title]],
    footer: am ? 'አሁን ይቀላቀሉ 🙏' : 'Hop in whenever you are ready 🙏',
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(tSync(lang, 'btn_join_session'), `${APP_URL}?start=session_${sessionInfo.session_id}`)
  });
}

// "Session has started" ping — sent the moment a session actually goes live.
async function notifySessionStarted(chatId, sessionInfo) {
  const lang = await getUserLang(chatId);
  const am = lang === 'am';
  const text = card({
    icon: '🔴',
    title: am ? 'ስብሰባው ተጀምሯል' : 'Session Is Live',
    body: am ? 'የቀጥታ ውይይቱ አሁን ተጀምሯል። እባክዎ አሁን ይቀላቀሉ።' : 'Your live session has just started. Please join now.',
    fields: [['🎯', am ? 'ርዕስ' : 'Title', sessionInfo.title]],
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(tSync(lang, 'btn_join_session'), `${APP_URL}?start=session_${sessionInfo.session_id}`)
  });
}

// Notifies all configured admins that a new mentor application has come in.
// Used by BOTH the bot's own /apply flow and the mini app's
// POST /api/users/apply-mentor route, so admins get pinged the same way
// no matter which surface the applicant used to apply.
async function notifyAdminNewMentorApplication(applicantTelegramId, sex, educational_background, about) {
  const adminIds = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_CHAT_ID;
  if (!adminIds) return;

  const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', applicantTelegramId).single();
  const adminMsg = card({
    icon: '🆕',
    title: 'New Mentor Application',
    body: 'A member has applied to become a mentor. Review the details below.',
    fields: [
      ['👤', 'User', u?.anonymous_id || String(applicantTelegramId)],
      ['⚧', 'Sex', sex],
      ['🎓', 'Education', educational_background],
      ['💬', 'About', about || ''],
    ],
  });

  for (const id of adminIds.split(',')) {
    if (id.trim()) {
      await safeSend(id.trim(), adminMsg, {
        ...HTML,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `admin_approve_${applicantTelegramId}`, style: 'success' },
            { text: 'Reject', callback_data: `admin_reject_${applicantTelegramId}`, style: 'danger' }
          ]]
        }
      });
    }
  }
}

async function notifyMentorshipRequest(mentorId, requesterId, requesterName, requesterSex, requesterAge, topic) {
  const lang = await getUserLang(mentorId);
  const am = lang === 'am';
  const topicName = (topic && typeof topic === 'object') ? topicLabel(topic, lang) : topic;
  const sex = requesterSex === 'M' ? (am ? 'ወንድ' : 'Male')
    : requesterSex === 'F' ? (am ? 'ሴት' : 'Female')
    : (am ? 'አልተገለጸም' : 'Not specified');
  const text = card({
    icon: '🙏',
    title: am ? 'አዲስ የምክር ጥያቄ' : 'New Mentorship Request',
    body: am ? 'አንድ ሰው በእርስዎ እገዛ ይፈልጋል። ጥያቄውን ለመገምገም መተግበሪያውን ይክፈቱ።' : 'Someone is looking for your guidance. Open the app to review and respond.',
    fields: [
      ['👤', am ? 'ከ' : 'From', requesterName],
      ['📖', am ? 'ርዕስ' : 'Topic', topicName],
      ['⚧', am ? 'ጾታ' : 'Sex', sex],
      ['🎂', am ? 'ዕድሜ' : 'Age', requesterAge || (am ? 'አልተገለጸም' : 'Not specified')],
    ],
    footer: am ? 'ፈጣን ምላሽ ትልቅ ተስፋ ይሰጣል 💛' : 'A quick reply can mean a lot 💛',
  });

  await safeSend(mentorId, text, {
    ...HTML,
    reply_markup: goldKeyboard(am ? 'ጥያቄዎችን ይመልከቱ' : 'View Requests', `${APP_URL}?start=requests`)
  });
}

async function notifyMentorshipAccepted(userId, mentorName) {
  const lang = await getUserLang(userId);
  const am = lang === 'am';
  const text = card({
    icon: '🎉',
    title: am ? 'የምክር ጥያቄዎ ተቀባይነት አግኝቷል' : 'Mentorship Request Accepted',
    body: am
      ? `አማካሪ ${mentorName} ጥያቄዎን ተቀብለዋል። አሁን በመተግበሪያው ውስጥ መወያየት ይችላሉ።`
      : `${mentorName} has accepted your request. You can start chatting in the app now.`,
    footer: am ? 'አዲስ ጉዞ ይጀምራል 🌱' : 'A new journey begins 🌱',
  });

  await safeSend(userId, text, {
    ...HTML,
    reply_markup: goldKeyboard(am ? 'አሁን ያውሩ' : 'Chat Now', APP_URL)
  });
}

async function notifyMentorshipRejected(userId, mentorName) {
  const lang = await getUserLang(userId);
  const am = lang === 'am';
  const text = card({
    icon: '💌',
    title: am ? 'የምክር ጥያቄ ምላሽ' : 'Mentorship Request Update',
    body: am
      ? `ከአማካሪ ${mentorName} ጋር የነበረዎት ጥያቄ በዚህ ወቅት ተቀባይነት አላገኘም። ተስፋ አይቁረጡ፤ ሌላ አማካሪ ይምረጡ።`
      : `${mentorName} wasn't able to take your request at this time. Don't be discouraged. Another mentor is ready to walk with you.`,
  });

  await safeSend(userId, text, {
    ...HTML,
    reply_markup: goldKeyboard(am ? 'አማካሪዎችን ይፈልጉ' : 'Find a Mentor', `${APP_URL}?start=mentors`)
  });
}

// Text + "Open Chat" button for a chat notification. Shared by the first send
// and by later edits so an edited notification looks identical (plus a tag).
function buildMessageNotification(lang, senderName, content, fromId, { edited = false } = {}) {
  const am = lang === 'am';
  let reply_markup;
  if (fromId) {
    reply_markup = goldKeyboard(am ? 'ቻት ክፈት' : 'Open Chat', `${APP_URL}?start=chat_${fromId}`);
  }
  const tag = edited ? (am ? ' · ተስተካክሏል' : ' · edited') : '';
  const head = am ? `አዲስ መልእክት ከ ${senderName}` : `New message from ${senderName}`;
  // Quote the message body but keep it under Telegram's 4096-char limit.
  const text = card({
    icon: '💬',
    title: `${head}${tag}`,
    quote: String(content ?? '').slice(0, 3500),
  });
  return { text, reply_markup };
}

async function notifyMessage(recipientId, senderName, messageContent, fromId = null, messageId = null) {
  const lang = await getUserLang(recipientId);
  const { text, reply_markup } = buildMessageNotification(lang, senderName, messageContent, fromId);

  // Sent as HTML with every user-supplied string escaped by card(). The
  // anonymous handles ("Warrior_9XkL2") and raw chat text used to break
  // Markdown ("can't parse entities") and safeSend swallowed the error, so
  // offline recipients silently got no notification.
  const sent = await safeSend(recipientId, text, { ...HTML, reply_markup });

  // Remember the Telegram message so app-side edits/deletes can follow it.
  if (sent && messageId) {
    const { error } = await supabase.from('message_tg_notifications').upsert({
      message_id: messageId,
      chat_id: sent.chat.id,
      tg_message_id: sent.message_id,
      from_id: fromId,
      to_id: recipientId,
    });
    if (error) console.warn('[Bot] Could not store notification mapping:', error.message);
  }
  return sent;
}

// Offline notification for an attachment sent from the Mini App: the recipient's
// Telegram gets the file itself (re-served from its file_id, so nothing is
// uploaded again) captioned like a text notification, with the same "Open Chat"
// button. `tgType` is how Telegram stored the file (voice/audio/video/photo/
// document) and decides which send method accepts the file_id.
async function notifyFileMessage(recipientId, senderName, fileType, tgType, fileId, caption, fromId = null, messageId = null) {
  const lang = await getUserLang(recipientId);
  const icons = { voice: '🎙️', audio: '🎵', video: '🎬', photo: '🖼️', document: '📎' };
  const { reply_markup } = buildMessageNotification(lang, senderName, '', fromId);
  // Telegram caps media captions at 1024 characters (counted after parsing),
  // so trim the quoted text, never the finished HTML (that could cut a tag).
  const text = card({
    icon: icons[fileType] || '📎',
    title: lang === 'am' ? `አዲስ መልእክት ከ ${senderName}` : `New message from ${senderName}`,
    quote: caption ? String(caption).slice(0, 700) : '',
  });
  const opts = { caption: text, parse_mode: 'HTML', reply_markup };

  let sent;
  try {
    switch (tgType) {
      case 'voice': sent = await bot.sendVoice(recipientId, fileId, opts); break;
      case 'audio': sent = await bot.sendAudio(recipientId, fileId, opts); break;
      case 'video': sent = await bot.sendVideo(recipientId, fileId, opts); break;
      case 'photo': sent = await bot.sendPhoto(recipientId, fileId, opts); break;
      default: sent = await bot.sendDocument(recipientId, fileId, opts);
    }
  } catch (err) {
    // E.g. the recipient restricts voice messages from non-contacts. They must
    // still learn that something arrived, so fall back to a plain notification.
    console.warn(`[Bot] Could not forward ${tgType} to ${recipientId}:`, err.message);
    return notifyMessage(recipientId, senderName, caption ? `${icons[fileType] || '📎'} ${caption}` : (icons[fileType] || '📎'), fromId, messageId);
  }

  if (sent && messageId) {
    const { error } = await supabase.from('message_tg_notifications').upsert({
      message_id: messageId,
      chat_id: sent.chat.id,
      tg_message_id: sent.message_id,
      from_id: fromId,
      to_id: recipientId,
    });
    if (error) console.warn('[Bot] Could not store notification mapping:', error.message);
  }
  return sent;
}

// The user edited a message in the app → edit the Telegram notification too.
async function syncNotificationEdit(messageId, senderName, newContent, fromId) {
  try {
    const { data: n } = await supabase
      .from('message_tg_notifications')
      .select('chat_id, tg_message_id, src_chat_id')
      .eq('message_id', messageId)
      .maybeSingle();
    if (!n || !n.chat_id || !n.tg_message_id) return; // recipient was online, so no Telegram copy exists
    const lang = await getUserLang(n.chat_id);

    if (n.src_chat_id) {
      // Copy was produced by forwardMessage() (the sender typed in the bot
      // chat): same "Message from your mentor [nick]" layout, and it carries
      // no inline keyboard (its reply keyboard can't be set via an edit).
      const { data: sender } = await supabase.from('users').select('anonymous_id, role').eq('telegram_id', fromId).maybeSingle();
      const roleLabel = sender?.role === 'mentor' ? tSync(lang, 'role_mentor') : tSync(lang, 'role_mentee');
      const tag = lang === 'am' ? '(ተስተካክሏል)' : '(edited)';
      const body = tSync(lang, 'msg_from_partner', { role: roleLabel, nick: mdEscape(sender?.anonymous_id), text: mdEscape(newContent) });
      await bot.editMessageText(`${body}\n\n${tag}`, { chat_id: n.chat_id, message_id: n.tg_message_id, parse_mode: 'Markdown' });
      return;
    }

    const { text, reply_markup } = buildMessageNotification(lang, senderName, newContent, fromId, { edited: true });
    // Omitting reply_markup would strip the "Open Chat" button, so resend it.
    await bot.editMessageText(text, { chat_id: n.chat_id, message_id: n.tg_message_id, parse_mode: 'HTML', reply_markup });
  } catch (e) {
    if (!/message is not modified/i.test(e.message || '')) {
      console.warn('[Bot] Edit sync failed:', e.message);
    }
  }
}

// Messages deleted in the app (one, or a whole cleared conversation) → delete
// the Telegram notifications too.
async function syncNotificationDelete(messageIds) {
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  if (!ids.length) return;
  try {
    const { data: rows } = await supabase
      .from('message_tg_notifications')
      .select('message_id, chat_id, tg_message_id')
      .in('message_id', ids);
    for (const r of rows || []) {
      if (!r.chat_id || !r.tg_message_id) continue;
      try {
        await bot.deleteMessage(r.chat_id, r.tg_message_id);
      } catch {
        // Telegram may refuse to delete older messages; blank it out instead
        // so the deleted text at least isn't left readable.
        try {
          const lang = await getUserLang(r.chat_id);
          await bot.editMessageText(lang === 'am' ? '🗑 መልእክቱ ተሰርዟል' : '🗑 This message was deleted.', {
            chat_id: r.chat_id, message_id: r.tg_message_id, reply_markup: { inline_keyboard: [] }
          });
        } catch { /* already gone */ }
      }
      await new Promise(res => setTimeout(res, 100)); // stay under Telegram rate limits
    }
    await supabase.from('message_tg_notifications').delete().in('message_id', ids);
  } catch (e) {
    console.warn('[Bot] Delete sync failed:', e.message);
  }
}

// ─── Goal Tracking Notifications ───────────────────────────────────────────
// Short, human helper for resolving a Telegram chat id
async function resolveChatId(telegramId) {
  const { data } = await supabase.from('users').select('chat_id').eq('telegram_id', telegramId).single();
  return data?.chat_id || telegramId;
}

// A short, human date like "Aug 25"
function formatGoalDate(dateStr) {
  try {
    return new Date(`${String(dateStr).substring(0, 10)}T00:00:00Z`)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'Africa/Addis_Ababa' });
  } catch {
    return dateStr;
  }
}

// Whole days between a goal's due_date and "today" in Ethiopia time.
function daysUntilDueEthiopia(dueDateStr) {
  const todayStr = getEthiopiaNow().toISOString().split('T')[0];
  const today = new Date(`${todayStr}T00:00:00Z`);
  const due = new Date(`${String(dueDateStr).substring(0, 10)}T00:00:00Z`);
  return Math.round((due - today) / 86400000);
}

// A. New Goal Notification
async function notifyNewGoal(menteeId, goal, mentorName) {
  const lang = await getUserLang(menteeId);
  const am = lang === 'am';
  const chatId = await resolveChatId(menteeId);
  const name = mentorName || (am ? 'አማካሪዎ' : 'Your mentor');

  const text = card({
    icon: '🎯',
    title: am ? 'አዲስ ግብ ተሰጥቶዎታል' : 'New Goal Assigned',
    body: am ? `${name} አዲስ ግብ አስቀምጦልዎታል። አብረው ይጓዙ!` : `${name} has set a new goal for you. Let's grow together!`,
    quote: goal.title,
    fields: [['📅', am ? 'ቀነ-ገደብ' : 'Due', goal.due_date ? formatGoalDate(goal.due_date) : '']],
    footer: am ? 'ትንንሽ እርምጃዎች ታላቅ ለውጥ ያመጣሉ 🌱' : 'Small steps lead to big change 🌱',
  });

  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(am ? 'ግቤን ክፈት' : 'Open My Goal', `${APP_URL}?start=goal_${goal.id}`)
  });
}

// B. Due-date reminder
async function notifyGoalDueReminder(menteeId, goal) {
  const lang = await getUserLang(menteeId);
  const am = lang === 'am';
  const chatId = await resolveChatId(menteeId);
  const daysLeft = daysUntilDueEthiopia(goal.due_date);

  let icon, title, body;
  if (daysLeft <= 0) {
    icon = '🔥';
    title = am ? 'የዛሬ ግብ ማስታወሻ' : 'Goal Due Today';
    body = am ? 'የዚህ ግብ ቀነ-ገደብ ዛሬ ነው። መተግበሪያውን ከፍተው ማጠናቀቅዎን ያረጋግጡ።' : 'This goal is due today. Finish it and mark it as done.';
  } else if (daysLeft === 1) {
    icon = '⏳';
    title = am ? 'ግቡ ነገ ይጠናቀቃል' : 'Goal Due Tomorrow';
    body = am ? 'ለመጨረስ አንድ ቀን ብቻ ቀርቷል።' : 'Just one day left to finish.';
  } else {
    icon = '🗓️';
    title = am ? 'የግብ ማስታወሻ' : 'Goal Reminder';
    body = am ? `ለመጨረስ ${daysLeft} ቀናት ቀርተዋል።` : `You have ${daysLeft} days left to finish.`;
  }

  const text = card({ icon, title, body, quote: goal.title, footer: am ? 'እርስዎ ይችላሉ 💪' : 'You can do it 💪' });

  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: { inline_keyboard: [
      [goldCallback(tSync(lang, 'btn_mark_goal_done'), `goal_done_${goal.id}`)],
      [goldButton(tSync(lang, 'btn_open_app'), `${APP_URL}?start=goal_${goal.id}`)],
    ] }
  });
}

// Sent once when a goal's due date passes with it still open
async function notifyGoalMissed(menteeId, goal) {
  const lang = await getUserLang(menteeId);
  const am = lang === 'am';
  const chatId = await resolveChatId(menteeId);
  const text = card({
    icon: '🕊️',
    title: am ? 'ቀነ-ገደቡ አልፏል' : 'Goal Past Due',
    body: am
      ? 'ችግር የለም፤ ሁሉም ሰው ያልፍበታል። አሁንም መሥራት ከፈለጉ፣ አማካሪዎን አዲስ ቀነ-ገደብ እንዲሰጥዎ ይጠይቁ።'
      : "That's okay, it happens to everyone. If you'd still like to work on it, ask your mentor to set a new due date.",
    quote: goal.title,
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(tSync(lang, 'btn_open_app'), `${APP_URL}?start=goal_${goal.id}`)
  });
}


// ─── Goals v2 notifications ──────────────────────────────────────────────────
async function menteeHandle(id) {
  const { data } = await supabase.from('users').select('anonymous_id').eq('telegram_id', id).maybeSingle();
  return data?.anonymous_id || 'Your mentee';
}

// Mentor: the mentee finished their day (all of that day's tasks) or goal.
async function notifyTaskDone(mentorId, menteeId, goal, task, stats) {
  const lang = await getUserLang(mentorId);
  const am = lang === 'am';
  const chatId = await resolveChatId(mentorId);
  const handle = await menteeHandle(menteeId);
  const sameDay = (goal.tasks || []).filter(t => t.due_date && String(t.due_date).substring(0, 10) === String(task.due_date).substring(0, 10));
  const notes = sameDay.map(t => t.note).filter(Boolean);
  let what;
  if (goal.type === 'challenge') {
    const n = daysBetween(goal.start_date, task.due_date) + 1;
    const total = daysBetween(goal.start_date, goal.end_date) + 1;
    what = am ? `ቀን ${n} ከ${total}ን አጠናቋል` : `completed Day ${n} of ${total}`;
  } else {
    what = am ? 'ግቡን አጠናቋል' : 'completed the goal';
  }
  const text = card({
    icon: '✅',
    title: am ? 'ተመካሪዎ እድገት አሳይቷል' : 'Mentee Progress',
    body: `${handle} ${what}`,
    quote: goal.title,
    fields: [
      ['🔥', am ? 'ተከታታይ ቀናት' : 'Streak', goal.type === 'challenge' && stats?.streak ? stats.streak : ''],
      ['📝', am ? 'ማስታወሻ' : 'Note', notes.join(' / ')],
    ],
    footer: am ? 'አንድ የማበረታቻ ቃል ብዙ ይጨምራል 💛' : 'A word of encouragement goes a long way 💛',
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(tSync(lang, 'btn_open_app'), APP_URL)
  });
}

// Mentee: one soft message listing the days that just closed as missed.
async function notifyGoalMissedDays(menteeId, goal, dates) {
  if (goal.type !== 'challenge') return notifyGoalMissed(menteeId, goal);
  const lang = await getUserLang(menteeId);
  const am = lang === 'am';
  const chatId = await resolveChatId(menteeId);
  const days = dates.map(formatGoalDate).join(', ');
  const text = card({
    icon: '🌅',
    title: am ? 'ያመለጠ ቀን' : 'A Day Slipped By',
    body: am
      ? 'አይዞዎት! የጨረሷቸው ቀናት አሁንም ዋጋ አላቸው። ዛሬ ጉዞዎን እንደገና ይቀጥሉ።'
      : "That's okay. The days you completed still count. Pick it back up today.",
    quote: goal.title,
    fields: [['📅', am ? 'ያልተጠናቀቀ' : 'Missed', days]],
    footer: am ? 'ዛሬ አዲስ ጅምር ነው 🌱' : 'Today is a fresh start 🌱',
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(am ? 'ዛሬ ይቀጥሉ' : 'Continue Today', `${APP_URL}?start=goal_${goal.id}`)
  });
}

// Mentor: 2 or 3 missed days in a row.
async function notifyMentorMissedRun(mentorId, goal, run) {
  const lang = await getUserLang(mentorId);
  const am = lang === 'am';
  const chatId = await resolveChatId(mentorId);
  const handle = await menteeHandle(goal.mentee_id);
  const text = card({
    icon: '💛',
    title: am ? 'ተመካሪዎ ማበረታቻ ሊያስፈልገው ይችላል' : 'Time for a Gentle Check-in',
    body: am
      ? `${handle} በዚህ ግብ ${run} ተከታታይ ቀናት አምልጠዋቸዋል። አጭር የማበረታቻ መልእክት ቢልኩላቸው ሊረዳቸው ይችላል።`
      : `${handle} has missed ${run} days in a row. A short, kind message can help them get back on track.`,
    quote: goal.title,
  });
  await safeSend(chatId, text, {
    ...HTML,
    reply_markup: goldKeyboard(am ? 'መልእክት ይላኩ' : 'Send a Message', `${APP_URL}?start=chat_${goal.mentee_id}`)
  });
}

// Mentee: daily reminder with one "Mark done" button per task (max 3).
async function notifyDailyReminder(menteeId, goal, tasks) {
  const lang = await getUserLang(menteeId);
  const am = lang === 'am';
  const chatId = await resolveChatId(menteeId);
  const isChallenge = goal.type === 'challenge';
  const text = card({
    icon: isChallenge ? '🔥' : '🎯',
    title: isChallenge ? (am ? 'የዛሬው የዕለት ተግባር' : "Today's Task") : (am ? 'የመንፈሳዊ ግብ ማስታወሻ' : 'Goal Reminder'),
    body: am ? 'ዛሬ ሊያጠናቅቋቸው የሚገቡ ተግባራት፦' : 'Here is what is waiting for you today:',
    quote: `${goal.title}\n${tasks.map(t => `• ${t.title}`).join('\n')}`,
    footer: am ? 'ዛሬ አንድ እርምጃ ወደፊት 🚶' : 'One step forward today 🚶',
  });
  const buttons = tasks.slice(0, 3).map(t => [goldCallback(
    `${tSync(lang, 'btn_mark_goal_done')}: ${t.title.slice(0, 24)}`,
    `goal_done_${t.id}`
  )]);
  buttons.push([goldButton(tSync(lang, 'btn_open_app'), `${APP_URL}?start=goal_${goal.id}`)]);
  await safeSend(chatId, text, { ...HTML, reply_markup: { inline_keyboard: buttons } });
}

// ─── Message Handler ──────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = getState(chatId);
  const lang = await getUserLang(chatId);

  // ─── Voice / File Attachment Handling ─────────────────────────────────────
  // Telegram delivers attachments as msg.voice / msg.audio / msg.document /
  // msg.photo / msg.video instead of msg.text, so this must be handled
  // before the `if (!text) return;` guard below, or attachments would be
  // silently dropped.
  const fileType = detectFileType(msg);
  if (fileType) {
    await touchActivity(chatId);
    await handleFileMessage(chatId, msg, fileType, state);
    return;
  }

  if (!text) return;

  await touchActivity(chatId);

  if (text.startsWith('/')) {
    const command = text.split(' ')[0].toLowerCase();
    const isFlowCommand = command === '/skip' && state &&
      ['awaiting_mentor_q3', 'mentor_req_msg'].includes(state.step);

    if (!isFlowCommand) {
      if (command === '/start') {
        const args = text.split(' ');
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();

        if (args.length > 1 && args[1].startsWith('chat_')) {
          const partnerId = args[1].replace('chat_', '');
          if (!user) {
            const lang = await getUserLang(chatId);
            return sendRegisterPrompt(chatId, await getUserLang(chatId), 'welcome');
          } else {
            const lang = await getUserLang(chatId);
            return safeSend(chatId, card({
              icon: '💬',
              title: lang === 'am' ? 'መልእክት ደርሶዎታል' : 'You Have a Message',
              body: lang === 'am' ? 'ለማንበብ ውይይትዎን ይክፈቱ።' : 'Open your chat to read it.',
            }), {
              ...HTML,
              reply_markup: goldKeyboard(lang === 'am' ? 'ቻት ክፈት' : 'Open Chat', `${APP_URL}?start=chat_${partnerId}`)
            });
          }
        }

        if (args.length > 1 && args[1].startsWith('session_')) {
          const sessionId = args[1].replace('session_', '');
          if (!user) {
            // New user trying to join a session - prompt registration via Mini App
            const lang = await getUserLang(chatId);
            return sendRegisterPrompt(chatId, await getUserLang(chatId), 'welcome');
          } else {
            // Registered user joining a session - send join button
            const lang = await getUserLang(chatId);
            return safeSend(chatId, card({
              icon: '📅',
              title: lang === 'am' ? 'ወደ ስብሰባ ተጋብዘዋል' : "You're Invited to a Session",
              body: lang === 'am' ? 'ለመቀላቀል ከታች ያለውን ቁልፍ ይጫኑ።' : 'Tap the button below to join.',
            }), {
              ...HTML,
              reply_markup: goldKeyboard(tSync(lang, 'btn_join_session'), `${APP_URL}?start=session_${sessionId}`)
            });
          }
        }

        if (!user) {
          const lang = await getUserLang(chatId);
          return sendRegisterPrompt(chatId, await getUserLang(chatId), 'welcome');
        }
        return showMainMenu(chatId, await t(chatId, 'welcome_back', { nick: mdEscape(user.anonymous_id) }));
      }
      if (command === '/menu') return showMainMenu(chatId);
      if (command === '/apply') {
        // Ensure the user is registered via Mini App
        const { data: userRecord } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();
        if (!userRecord) {
          const lang = await getUserLang(chatId);
          return sendRegisterPrompt(chatId, await getUserLang(chatId), 'apply');
        }

        // User exists, check role
        const { data: userRole } = await supabase.from('users').select('role').eq('telegram_id', chatId).single();
        if (userRole?.role === 'mentor' || userRole?.role === 'admin')
          return safeSend(chatId, await t(chatId, 'already_mentor'));
        const { data: ex } = await supabase.from('mentor_applications').select('id')
          .eq('telegram_id', chatId).eq('status', 'pending').single();
        if (ex) return safeSend(chatId, await t(chatId, 'application_pending'));
        if (await blockApplyIfActiveMentee(chatId, await getUserLang(chatId))) return;
        setState(chatId, 'awaiting_mentor_q1');
        return safeSend(chatId, await t(chatId, 'apply_q1'));
      }
      if (command === '/settopics') {
        const lang = await getUserLang(chatId);
        const kb = await getTopicPickerKeyboard([], 'set_topics_', lang);
        await safeSend(chatId, await t(chatId, 'select_your_topics'), { reply_markup: kb });
        setState(chatId, 'edit_topics', null, { selectedTopics: [] });
        return;
      }
      if (command === '/end') {
        const partnersInfo = await getActiveChatPartners(chatId);
        if (!partnersInfo) return safeSend(chatId, await t(chatId, 'no_active_mentorship'));
        if (partnersInfo.partners.length === 1) {
          await endMentorship(chatId, partnersInfo.partners[0], partnersInfo.role);
        }
        return;
      }
      if (command === '/repair_assignments') {
        const { data: user } = await supabase.from('users').select('role').eq('telegram_id', chatId).single();
        if (user?.role !== 'admin') return;

        const { data: assignments } = await supabase.from('mentorship_assignments').select('*').eq('is_active', true);
        let repaired = 0;
        for (const ass of assignments || []) {
          const [{ data: m }, { data: u }] = await Promise.all([
            supabase.from('users').select('role').eq('telegram_id', ass.mentor_id).single(),
            supabase.from('users').select('role').eq('telegram_id', ass.user_id).single()
          ]);

          if (m?.role === 'user' && u?.role === 'mentor') {
            await supabase.from('mentorship_assignments').update({ mentor_id: ass.user_id, user_id: ass.mentor_id }).eq('id', ass.id);
            repaired++;
          }
        }
        return safeSend(chatId, `✅ Repair complete. Fixed ${repaired} swapped assignments.`);
      }
      if (command === '/reply') {
        const args = text.split(' ');
        if (args.length < 2) return safeSend(chatId, await t(chatId, 'reply_usage'));
        const partnersInfo = await getActiveChatPartners(chatId);
        if (!partnersInfo) return safeSend(chatId, await t(chatId, 'no_active_partners'));
        let targetId = null;
        const input = args[1];
        const content = args.slice(2).join(' ');
        if (input.startsWith('@')) {
          const nick = input.replace('@', '').trim();
          const { data: u } = await supabase.from('users').select('telegram_id').ilike('anonymous_id', nick).single();
          if (u && partnersInfo.partners.includes(u.telegram_id)) targetId = u.telegram_id;
        } else {
          const idx = parseInt(input) - 1;
          if (!isNaN(idx) && partnersInfo.partners[idx]) targetId = partnersInfo.partners[idx];
        }
        if (!targetId) return safeSend(chatId, await t(chatId, 'partner_not_found'));
        if (!content) {
          setState(chatId, 'chat_active', targetId);
          const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', targetId).single();
          return safeSend(chatId, await t(chatId, 'focus_set', { nick: mdEscape(u.anonymous_id) }));
        }
        await forwardMessage(chatId, targetId, content);
        return safeSend(chatId, await t(chatId, 'msg_sent'));
      }
      return;
    }
  }

  // ─── Persistent Menu Routing ────────────────────────────────────────────────
  const textMatches = (key) => text === tSync(lang, key) || text === tSync('en', key) || text === tSync('am', key);

  if (textMatches('btn_find_mentor')) {
    const { data: ut } = await supabase.from('user_topics').select('topic_id, topics(name, name_am)').eq('telegram_id', chatId);
    if (!ut?.length) return safeSend(chatId, tSync(lang, 'no_topics_set'));
    const buttons = ut.map(t => [{ text: topicLabel(t.topics, lang), callback_data: `search_topic_${t.topic_id}` }]);
    return safeSend(chatId, tSync(lang, 'choose_topic_search'), { reply_markup: { inline_keyboard: buttons } });
  }
  if (textMatches('btn_my_chat')) {
    const partnersInfo = await getActiveChatPartners(chatId);
    if (!partnersInfo) {
      return safeSend(chatId, tSync(lang, 'no_active_mentor'), {
        reply_markup: { inline_keyboard: [[{ text: tSync(lang, 'btn_find_mentor'), callback_data: 'menu_mentors' }]] }
      });
    }
    if (partnersInfo.partners.length === 1) {
      return safeSend(chatId, tSync(lang, 'chat_instructions'));
    } else {
      const { data: mentees } = await supabase.from('users').select('telegram_id, anonymous_id').in('telegram_id', partnersInfo.partners);
      const buttons = (mentees || []).map(m => [{
        text: lang === 'am' ? `💬 ከ @${m.anonymous_id} ጋር አውራ` : `💬 Chat with @${m.anonymous_id}`,
        callback_data: `focus_chat_${m.telegram_id}`
      }]);
      return safeSend(chatId, lang === 'am' ? 'ለመወያየት አንድ ተመካሪ ይምረጡ፡' : 'Select a mentee to chat with:', {
        reply_markup: { inline_keyboard: buttons }
      });
    }
  }
  if (textMatches('btn_streak')) return handleStreakFlow(chatId);
  if (textMatches('btn_journal')) {
    return safeSend(chatId, `✏️ *${tSync(lang, 'journal_title')}*`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'btn_new_entry'), callback_data: 'journal_new' }],
          [{ text: tSync(lang, 'btn_view_entries'), callback_data: 'journal_view_0' }]
        ]
      }
    });
  }
  if (textMatches('btn_verse')) return handleDailyVerse(chatId);
  if (textMatches('btn_settings')) return showSettings(chatId);
  if (textMatches('btn_my_mentees')) {
    const { data: mentees, error } = await supabase.from('mentorship_assignments')
      .select('user_id, topics(name, name_am)').eq('mentor_id', chatId).eq('is_active', true);

    if (error) { console.error('[My Mentees] Error:', error); return safeSend(chatId, 'Error loading mentees.'); }

    if (!mentees?.length) {
      // Check swapped (auto-repair attempt)
      const { data: swapped } = await supabase.from('mentorship_assignments').select('id, mentor_id').eq('user_id', chatId).eq('is_active', true);
      if (swapped?.length) {
        await supabase.from('mentorship_assignments').update({ mentor_id: chatId, user_id: swapped[0].mentor_id }).eq('id', swapped[0].id);
        return safeSend(chatId, '⚠️ Mentorship list repaired. Please click again.');
      }
      return safeSend(chatId, tSync(lang, 'no_mentees'));
    }

    return sendMenteeList(chatId, lang, mentees);
  }
  if (textMatches('btn_schedule')) {
    setState(chatId, 'sched_type', null, { type: 'group' });
    return safeSend(chatId, tSync(lang, 'select_session_type'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'session_private'), callback_data: 'sched_type_private' }],
          [{ text: tSync(lang, 'session_group'), callback_data: 'sched_type_group' }]
        ]
      }
    });
  }
  if (textMatches('btn_apply_mentor')) {
    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', chatId).single();
    if (user?.role === 'mentor' || user?.role === 'admin') return safeSend(chatId, tSync(lang, 'already_mentor'));
    const { data: ex } = await supabase.from('mentor_applications').select('id').eq('telegram_id', chatId).eq('status', 'pending').single();
    if (ex) return safeSend(chatId, tSync(lang, 'application_pending'));
    if (await blockApplyIfActiveMentee(chatId, lang)) return;
    setState(chatId, 'awaiting_mentor_sex');
    return safeSend(chatId, tSync(lang, 'apply_q1'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'sex_male'), callback_data: 'mentor_sex_M' }, { text: tSync(lang, 'sex_female'), callback_data: 'mentor_sex_F' }],
          [{ text: tSync(lang, 'sex_prefer_not'), callback_data: 'mentor_sex_prefer_not' }]
        ]
      }
    });
  }

  // Flow Steps
  if (state) {
    if (state.step === 'awaiting_mentor_sex') {
      return safeSend(chatId, tSync(lang, 'please_use_buttons'));
    }
    if (state.step === 'reg_nickname') {
      const nick = text.trim();
      if (nick.length < 3 || nick.length > 20 || !/^[a-zA-Z0-9_]+$/.test(nick))
        return safeSend(chatId, await t(chatId, 'invalid_nickname'));
      const { data: ex } = await supabase.from('users').select('telegram_id').eq('anonymous_id', nick).single();
      if (ex) return safeSend(chatId, await t(chatId, 'nickname_taken'));
      state.tempData.nickname = nick;
      const lang = state.tempData.language || 'en';
      const kb = await getTopicPickerKeyboard([], 'reg_topic_', lang);
      await safeSend(chatId, tSync(lang, 'select_struggle_topics', { nick }), { reply_markup: kb });
      setState(chatId, 'reg_topics', null, state.tempData);
      return;
    }

    if (state.step === 'awaiting_mentor_edu') {
      state.tempData.educational_background = text.trim();
      return showTextInputWithCancel(chatId, await t(chatId, 'apply_q3'), 'awaiting_mentor_about', state.tempData);
    }
    if (state.step === 'awaiting_mentor_about') {
      const about = text.trim();

      // Validation
      if (!state.tempData.sex || !state.tempData.educational_background || !about) {
        console.error('[Mentor Application] Missing fields:', state.tempData);
        await safeSend(chatId, '❌ Missing information. Please start over with /apply.');
        clearState(chatId);
        return showMainMenu(chatId);
      }

      // They may have been matched with a mentor while answering the questions.
      if (await blockApplyIfActiveMentee(chatId, await getUserLang(chatId))) {
        clearState(chatId);
        return;
      }

      const { error } = await supabase.from('mentor_applications').insert({
        telegram_id: chatId,
        sex: state.tempData.sex,
        educational_background: state.tempData.educational_background,
        about_me: about,
        answer_q1: state.tempData.sex,
        answer_q2: state.tempData.educational_background,
        answer_q3: about,
        status: 'pending',
        submitted_at: new Date().toISOString()
      });

      if (error) {
        console.error('[Mentor Application] Insert error:', error);
        await safeSend(chatId, await t(chatId, 'application_error'));
      } else {
        await safeSend(chatId, await t(chatId, 'application_submitted'));
        await notifyAdminNewMentorApplication(chatId, state.tempData.sex, state.tempData.educational_background, about);
      }
      clearState(chatId); return showMainMenu(chatId);
    }

    if (state.step === 'admin_reject_note') {
      const targetId = state.tempData.targetId;
      await supabase.from('mentor_applications').update({
        status: 'rejected', admin_note: text.trim(), reviewed_at: new Date().toISOString()
      }).eq('telegram_id', targetId).eq('status', 'pending');
      await supabase.from('users').update({ role: 'user' }).eq('telegram_id', targetId);
      await notifyMentorRejected(targetId);
      clearState(chatId); return safeSend(chatId, '✅ Application rejected with note.');
    }

    if (state.step === 'sched_custom_time') {
      await createVideoSession(chatId, state.tempData.date, text.trim());
      return;
    }

    if (state.step === 'journal_new') {
      await supabase.from('journal_entries').insert({ telegram_id: chatId, content: text.trim() });
      await safeSend(chatId, await t(chatId, 'journal_saved'));
      clearState(chatId); return showMainMenu(chatId);
    }

    if (state.step === 'mentor_req_msg') {
      const { mentorId, topicId } = state.tempData;
      const msgStr = text === '/skip' ? '' : text.trim();

      // ── 1. Validate topic match ──────────────────────────────
      const topicIdNum = parseInt(topicId, 10); // ensure number

      // Fetch user's topics and mentor's topics
      const [userTopics, mentorTopics] = await Promise.all([
        supabase.from('user_topics').select('topic_id').eq('telegram_id', chatId),
        supabase.from('mentor_topics').select('topic_id').eq('telegram_id', mentorId)
      ]);

      const userTopicIds = (userTopics.data || []).map(t => t.topic_id);
      const mentorTopicIds = (mentorTopics.data || []).map(t => t.topic_id);

      // Check if the selected topic is in both lists
      const commonTopicIds = userTopicIds.filter(id => mentorTopicIds.includes(id));

      if (!commonTopicIds.includes(topicIdNum)) {
        // If not, check if there is any other common topic to suggest
        if (commonTopicIds.length === 0) {
          await safeSend(chatId, '❌ You and the mentor have no topics in common. Please update your topics in Settings.');
        } else {
          // Fetch topic names for the common IDs to give a helpful message
          const { data: commonTopics } = await supabase
            .from('topics')
            .select('name, name_am')
            .in('id', commonTopicIds);
          const topicLang = await getUserLang(chatId);
          const topicNames = (commonTopics || []).map(t => topicLabel(t, topicLang)).join(', ');
          await safeSend(chatId, `❌ You do not share the selected topic with the mentor. You share these topics: ${topicNames}. Please select a matching topic.`);
        }
        clearState(chatId);
        return showMainMenu(chatId);
      }

      // ── 2. Check user does not have an active mentor ──────────
      const { data: activeAssign } = await supabase
        .from('mentorship_assignments')
        .select('id')
        .eq('user_id', chatId)
        .eq('is_active', true)
        .single();
      if (activeAssign) {
        await safeSend(chatId, '❌ You already have an active mentor. End your current mentorship first.');
        clearState(chatId);
        return showMainMenu(chatId);
      }

      // ── 3. Check mentor capacity & availability ──────────────
      // max_mentees lives in user_settings (what the mentor edits and what
      // the mentor list displays), not on the users table.
      const { data: mentor } = await supabase
        .from('users')
        .select('accepting_requests, user_settings(max_mentees)')
        .eq('telegram_id', mentorId)
        .single();

      if (mentor && mentor.accepting_requests === false) {
        await safeSend(chatId, 'This mentor is not accepting new requests at this time.');
        clearState(chatId);
        return showMainMenu(chatId);
      }

      const { count: currentMentees } = await supabase
        .from('mentorship_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('mentor_id', mentorId)
        .eq('is_active', true);
      if (currentMentees >= (mentor?.user_settings?.max_mentees || DEFAULT_MAX_MENTEES)) {
        await safeSend(chatId, '❌ This mentor has reached their capacity. Please try another.');
        clearState(chatId);
        return showMainMenu(chatId);
      }

      // ── 4. Check for existing pending request ────────────────
      const { data: pending } = await supabase
        .from('mentorship_requests')
        .select('id')
        .eq('user_id', chatId)
        .eq('mentor_id', mentorId)
        .eq('status', 'pending')
        .single();
      if (pending) {
        await safeSend(chatId, '⏳ You already have a pending request with this mentor.');
        clearState(chatId);
        return showMainMenu(chatId);
      }

      // ── All checks passed – insert the request ───────────────
      const { error } = await supabase.from('mentorship_requests').insert({
        user_id: chatId,
        mentor_id: mentorId,
        topic_id: topicId,
        message: msgStr
      });

      if (error) {
        await safeSend(chatId, await t(chatId, 'request_failed'));
      } else {
        // Notify the mentor (existing logic)
        const [{ data: u }, { data: topic }] = await Promise.all([
          supabase.from('users').select('anonymous_id, sex, age_range').eq('telegram_id', chatId).single(),
          supabase.from('topics').select('name, name_am').eq('id', topicId).single()
        ]);
        const mentorLang = await getUserLang(mentorId);
        const menteeSex = u.sex === 'M' ? 'Male' : u.sex === 'F' ? 'Female' : 'Not specified';
        const menteeAge = u.age_range || 'Not specified';
        const requestText = mentorLang === 'am'
          ? `🙏 አዲስ የምክር ጥያቄ!\n\nከ: *${mdEscape(u.anonymous_id)}*\nጾታ: ${menteeSex}\nዕድሜ: ${menteeAge}\nርዕስ: *${mdEscape(topicLabel(topic, 'am'))}*\nመልዕክት: ${mdEscape(msgStr || '')}\n\nይቀበላሉ?`
          : `🙏 *New Mentorship Request!*\n\nFrom: *${mdEscape(u.anonymous_id)}*\nSex: ${menteeSex}\nAge: ${menteeAge}\nTopic: *${mdEscape(topicLabel(topic, 'en'))}*\nMessage: ${mdEscape(msgStr || 'None')}\n\nDo you accept?`;

        await safeSend(mentorId, requestText, {
          reply_markup: {
            inline_keyboard: [[
              { text: tSync(mentorLang, 'btn_accept'), callback_data: `mentor_accept_${chatId}_${topicId}` },
              { text: tSync(mentorLang, 'btn_reject'), callback_data: `mentor_reject_${chatId}` }
            ]]
          }
        });
        await safeSend(chatId, await t(chatId, 'request_sent'));
      }

      clearState(chatId);
      return showMainMenu(chatId);
    }

    if (state.step === 'set_verse_time') {
      const match = text.trim().match(/^(0?[1-9]|1[0-2]):([0-5][0-9])\s?(AM|PM)$/i);
      let hour;
      if (match) {
        hour = parseInt(match[1]);
        const ampm = match[3].toUpperCase();
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
      } else {
        hour = parseInt(text);
        if (isNaN(hour) || hour < 0 || hour > 23) return safeSend(chatId, await t(chatId, 'invalid_hour'));
      }

      await supabase.from('user_settings').update({ verse_time: hour }).eq('telegram_id', chatId);
      await safeSend(chatId, await t(chatId, 'verse_time_set', { hour: format12h(hour) }));
      clearState(chatId); return showMainMenu(chatId);
    }
  }

  // 🛡️ CHAT SHIELD: Only allow forwarding if NOT in a flow state
  if (!state || state.step === 'chat_active') {
    const targetId = await resolveChatTarget(chatId, state, { type: 'text', content: text.trim(), srcMessageId: msg.message_id });
    if (targetId) await forwardMessage(chatId, targetId, text.trim(), msg.message_id);
  }
});

// ─── Edited messages (user edited their message inside the bot chat) ─────────
// Telegram sends the bot an `edited_message` update for edits. It sends NOTHING
// when a user deletes a message in a private chat, so deletes can't be synced.
bot.on('edited_message', async (edited) => {
  try {
    if (!edited.text || edited.chat.type !== 'private') return;
    const chatId = edited.chat.id;
    const { data: map } = await supabase
      .from('message_tg_notifications')
      .select('message_id')
      .eq('src_chat_id', chatId)
      .eq('src_tg_message_id', edited.message_id)
      .maybeSingle();
    if (!map) return; // not a chat message we forwarded (a command, an answer to a flow prompt, ...)

    const { data: row } = await supabase
      .from('messages')
      .select('id, from_id, to_id, created_at, is_deleted')
      .eq('id', map.message_id)
      .single();
    if (!row || row.is_deleted || String(row.from_id) !== String(chatId)) return;
    // Same 2-day edit window the app enforces.
    if (Date.now() - new Date(row.created_at).getTime() > 2 * 24 * 60 * 60 * 1000) return;

    const content = edited.text.trim();
    if (!content) return;

    const { data: updated, error } = await supabase
      .from('messages')
      .update({ content, edited_at: new Date().toISOString() })
      .eq('id', row.id)
      .select()
      .single();
    if (error) throw error;

    // Live-update the mini app for both people, then the other person's Telegram copy.
    const io = global._io || global.io;
    if (io) io.to([`user:${row.to_id}`, `user:${row.from_id}`]).emit('message_edited', updated);
    await syncNotificationEdit(row.id, null, content, row.from_id);
  } catch (e) {
    console.warn('[Bot] edited_message handling failed:', e.message);
  }
});

// ─── Callback Handler ─────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = getState(chatId);
  const lang = await getUserLang(chatId);

  await touchActivity(chatId);

  // Noop
  if (data === 'noop') { return bot.answerCallbackQuery(query.id); }

  if (data === 'cancel_operation') {
    clearState(chatId);
    await safeSend(chatId, tSync(lang, 'operation_cancelled'));
    await showMainMenu(chatId);
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'cancel_application') {
    clearState(chatId);
    await safeSend(chatId, tSync(lang, 'application_cancelled'));
    await showMainMenu(chatId);
    return bot.answerCallbackQuery(query.id);
  }

  // Mentor tapped a mentee button from resolveChatTarget's "you have
  // multiple mentees" prompt. The target's real telegram_id lives in
  // callback_data, so there's no nickname text to parse or mismatch.
  if (data.startsWith('select_target_')) {
    const targetId = data.replace('select_target_', '');
    const pending = state?.tempData?.pending;

    // Re-verify this is still an active mentee — guards against a stale
    // button if the assignment ended between prompt and tap.
    const partnersInfo = await getActiveChatPartners(chatId);
    if (!partnersInfo || !partnersInfo.partners.map(String).includes(String(targetId))) {
      clearState(chatId);
      return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'partner_not_found'), show_alert: true });
    }

    if (!pending) {
      clearState(chatId);
      return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'pending_expired'), show_alert: true });
    }

    if (pending.type === 'file') {
      await forwardFileMessage(chatId, targetId, pending.fileType, pending.meta, pending.caption);
    } else {
      await forwardMessage(chatId, targetId, pending.content, pending.srcMessageId || null);
    }

    setState(chatId, 'chat_active', targetId);
    const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', targetId).single();
    await bot.answerCallbackQuery(query.id, { text: tSync(lang, 'target_selected', { nick: u?.anonymous_id || '' }) });
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch { }
    return;
  }

  // "Mark as done" button on a goal reminder. The button carries the task id
  // (messages sent before goals v2 carry the goal id; the service accepts
  // both). Same rules as the mini app: only the mentee, only on the day.
  if (data.startsWith('goal_done_')) {
    const r = await setGoalTaskDone(supabase, { taskId: data.replace('goal_done_', ''), actorId: chatId, done: true });
    if (r.error) {
      await bot.answerCallbackQuery(query.id, { text: r.error.message, show_alert: true });
      if (r.error.status === 409) {
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch { }
      }
      return;
    }
    await bot.answerCallbackQuery(query.id, { text: tSync(lang, 'goal_marked_done_confirm') });
    try {
      // Drop only the tapped button; show the "done" label when none are left.
      const left = (query.message.reply_markup?.inline_keyboard || []).filter(row => !row.some(b => b.callback_data === data));
      const hasMore = left.some(row => row.some(b => b.callback_data?.startsWith('goal_done_')));
      await bot.editMessageReplyMarkup(
        { inline_keyboard: hasMore ? left : [[{ text: tSync(lang, 'goal_marked_done_label'), callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch { /* message may already be gone/edited -- not fatal */ }
    return;
  }

  // Registration
  if (data.startsWith('reg_sex_')) {
    setState(chatId, 'reg_age', null, { sex: data.replace('reg_sex_', '') });
    await bot.editMessageText(tSync(lang, 'reg_age_prompt'), {
      chat_id: chatId, message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: '13-17', callback_data: 'reg_age_13-17' }, { text: '18-24', callback_data: 'reg_age_18-24' }],
          [{ text: '25-34', callback_data: 'reg_age_25-34' }, { text: '35-44', callback_data: 'reg_age_35-44' }],
          [{ text: '45-54', callback_data: 'reg_age_45-54' }, { text: '55+', callback_data: 'reg_age_55+' }]
        ]
      }
    });
  } else if (data.startsWith('reg_age_')) {
    setState(chatId, 'reg_edu', null, { ...state?.tempData, age_range: data.replace('reg_age_', '') });
    await bot.editMessageText(tSync(lang, 'reg_edu_prompt'), {
      chat_id: chatId, message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'edu_primary'), callback_data: 'reg_edu_primary' }, { text: tSync(lang, 'edu_secondary'), callback_data: 'reg_edu_secondary' }],
          [{ text: tSync(lang, 'edu_undergrad'), callback_data: 'reg_edu_undergraduate' }, { text: tSync(lang, 'edu_grad'), callback_data: 'reg_edu_graduate' }],
          [{ text: tSync(lang, 'edu_postgrad'), callback_data: 'reg_edu_postgraduate' }, { text: tSync(lang, 'edu_none'), callback_data: 'reg_edu_none' }]
        ]
      }
    });
  } else if (data.startsWith('reg_edu_')) {
    setState(chatId, 'reg_nickname', null, { ...state?.tempData, education_level: data.replace('reg_edu_', '') });
    await bot.editMessageText(tSync(lang, 'reg_nickname_prompt'), { chat_id: chatId, message_id: query.message.message_id });
  }

  // Topic Selection (multi-select — registration, set_topics, apply)
  else if (data.startsWith('reg_topic_') || data.startsWith('apply_topic_') || data.startsWith('set_topics_')) {
    const prefix = data.startsWith('reg_topic_') ? 'reg_topic_' : data.startsWith('apply_topic_') ? 'apply_topic_' : 'set_topics_';
    const action = data.replace(prefix, '');
    if (!state) return safeSend(chatId, tSync(lang, 'session_expired'));

    if (action === 'done') {
      const topics = state.tempData.selectedTopics || [];
      if (prefix === 'reg_topic_') {
        state.tempData.selectedTopics = topics;
        setState(chatId, 'reg_language', null, state.tempData);
        await bot.editMessageText(tSync(lang, 'reg_lang_prompt'), {
          chat_id: chatId, message_id: query.message.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: 'English', callback_data: 'reg_lang_en' },
              { text: 'አማርኛ', callback_data: 'reg_lang_am' }
            ]]
          }
        });
      } else {
        await supabase.from('user_topics').delete().eq('telegram_id', chatId);
        for (const tid of topics) await supabase.from('user_topics').insert({ telegram_id: chatId, topic_id: tid });
        clearState(chatId);
        await safeSend(chatId, tSync(lang, 'topics_updated'));
        await showMainMenu(chatId);
      }
    } else {
      const tid = parseInt(action);
      const current = state.tempData.selectedTopics || [];
      const updated = current.includes(tid) ? current.filter(x => x !== tid) : [...current, tid];
      const nextStep = prefix === 'reg_topic_' ? 'reg_topics' : 'edit_topics';
      setState(chatId, nextStep, null, { ...state.tempData, selectedTopics: updated });
      await bot.editMessageReplyMarkup(
        await getTopicPickerKeyboard(updated, prefix, lang),
        { chat_id: chatId, message_id: query.message.message_id }
      );
    }
  }

  // Language Selection (registration)
  else if (data.startsWith('reg_lang_')) {
    const selectedLang = data.replace('reg_lang_', '');
    if (!state) return;
    await supabase.from('users').insert({
      telegram_id: chatId, chat_id: chatId, anonymous_id: state.tempData.nickname,
      sex: state.tempData.sex, age_range: state.tempData.age_range,
      education_level: state.tempData.education_level, role: 'user'
    });
    await supabase.from('user_settings').insert({ telegram_id: chatId, language: selectedLang, display_name: state.tempData.nickname });
    setLangCache(chatId, selectedLang);
    const topics = state.tempData.selectedTopics || [];
    for (const tid of topics) await supabase.from('user_topics').insert({ telegram_id: chatId, topic_id: tid });
    const startParam = state.tempData.startParam;
    clearState(chatId);
    await showMainMenu(chatId, tSync(selectedLang, 'registration_complete', { lang: selectedLang === 'en' ? 'English' : 'አማርኛ' }));

    if (startParam && startParam.startsWith('session_')) {
      const sessionId = startParam.replace('session_', '');
      await bot.sendMessage(chatId, card({
        icon: '📅',
        title: selectedLang === 'am' ? 'ወደ ስብሰባ ተጋብዘዋል' : "You're Invited to a Session",
        body: selectedLang === 'am' ? 'ለመቀላቀል ከታች ያለውን ቁልፍ ይጫኑ።' : 'Tap the button below to join.',
      }), {
        ...HTML,
        reply_markup: goldKeyboard(tSync(selectedLang, 'btn_join_session'), `${APP_URL}?start=session_${sessionId}`)
      });
    }
  }

  // Mentor Search & Sort
  else if (data === 'menu_mentors') {
    const { data: ut } = await supabase.from('user_topics').select('topic_id, topics(name, name_am)').eq('telegram_id', chatId);
    if (!ut?.length) return safeSend(chatId, tSync(lang, 'no_topics_set'));
    const buttons = ut.map(t => [{ text: topicLabel(t.topics, lang), callback_data: `search_topic_${t.topic_id}` }]);
    await safeSend(chatId, tSync(lang, 'choose_topic_search'), { reply_markup: { inline_keyboard: buttons } });
  } else if (data.startsWith('search_topic_')) {
    await listMentors(chatId, 0, data.replace('search_topic_', ''), 'rating');
  } else if (data.startsWith('mentors_page_')) {
    const parts = data.split('_'); // mentors_page_{page}_{topicId}_{sort}
    await listMentors(chatId, parseInt(parts[2]), parts[3], parts[4] || 'rating');
  } else if (data.startsWith('mentor_sort_')) {
    const parts = data.split('_'); // mentor_sort_{sort}_{topicId}_{page}
    await listMentors(chatId, parseInt(parts[4]) || 0, parts[3], parts[2]);
  }

  // Waiting List
  else if (data.startsWith('waitlist_join_')) {
    await joinWaitingList(chatId, data.replace('waitlist_join_', ''));
  }

  // Mentor Requests
  else if (data.startsWith('mentor_req_')) {
    const parts = data.split('_'); // mentor_req_{mentorId}_{topicId}
    const mentorId = parts[2];
    const topicId = parseInt(parts[3], 10); // ✅ Ensure integer

    // Fetch mentee details
    const { data: menteeData } = await supabase
      .from('users')
      .select('anonymous_id, sex, age_range')
      .eq('telegram_id', chatId)
      .single();

    setState(chatId, 'mentor_req_msg', null, {
      mentorId: mentorId,
      topicId: topicId,
      menteeName: menteeData?.anonymous_id,
      menteeSex: menteeData?.sex,
      menteeAge: menteeData?.age_range
    });

    await safeSend(chatId, tSync(lang, 'mentor_req_msg_prompt'));

    // Prevent opposite‑sex requests
    const [{ data: mentee }, { data: mentor }] = await Promise.all([
      supabase.from('users').select('sex').eq('telegram_id', chatId).single(),
      supabase.from('users').select('sex').eq('telegram_id', mentorId).single()
    ]);

    if (mentee?.sex !== 'prefer_not' && mentor?.sex !== 'prefer_not' && mentee?.sex !== mentor?.sex) {
      await safeSend(chatId, "❌ You can only request mentorship from a mentor of the same sex.");
      return bot.answerCallbackQuery(query.id);
    }
  } else if (data.startsWith('mentor_accept_')) {
    const parts = data.split('_'); // mentor_accept_{uid}_{tid}
    await acceptMentorship(chatId, parts[2], parts[3]);
  } else if (data.startsWith('mentor_reject_')) {
    await rejectMentorship(chatId, data.split('_')[2]);
  }

  // Rating
  else if (data.startsWith('rate_')) {
    const parts = data.split('_'); // rate_{mentorId}_{stars}
    await submitRating(chatId, parts[1], parseInt(parts[2]));
  }

  // Admin Actions
  else if (data.startsWith('admin_approve_')) {
    const targetId = data.replace('admin_approve_', '');
    await supabase.from('mentor_applications').update({
      status: 'approved', reviewed_at: new Date().toISOString()
    }).eq('telegram_id', targetId).eq('status', 'pending');
    await supabase.from('users').update({ role: 'mentor' }).eq('telegram_id', targetId);
    await notifyMentorApproved(targetId);
    await bot.editMessageText('✅ Approved!', { chat_id: chatId, message_id: query.message.message_id });
  } else if (data.startsWith('admin_reject_')) {
    const targetId = data.replace('admin_reject_', '');
    setState(chatId, 'admin_reject_note', null, { targetId });
    await showCancelKeyboard(chatId, 'Enter rejection note (or send "none"):');
  }

  // Navigation
  else if (data === 'menu_chat') await safeSend(chatId, tSync(lang, 'chat_instructions'));
  else if (data === 'menu_streak') await handleStreakFlow(chatId);
  else if (data === 'streak_mark') await markStreakAsRead(chatId);
  else if (data === 'menu_journal') {
    await safeSend(chatId, `✏️ *${tSync(lang, 'journal_title')}*`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'btn_new_entry'), callback_data: 'journal_new' }],
          [{ text: tSync(lang, 'btn_view_entries'), callback_data: 'journal_view_0' }]
        ]
      }
    });
  }
  else if (data === 'journal_new') { setState(chatId, 'journal_new'); await showCancelKeyboard(chatId, tSync(lang, 'journal_write_prompt')); }
  else if (data.startsWith('journal_view_')) await viewJournalEntries(chatId, parseInt(data.replace('journal_view_', '')));
  else if (data.startsWith('journal_read_')) await readJournalEntry(chatId, data.replace('journal_read_', ''));
  else if (data === 'menu_verse') await handleDailyVerse(chatId);
  else if (data === 'menu_settings') await showSettings(chatId);
  else if (data === 'menu_mentor_topics') {
    const kb = await getMentorTopicKeyboard(chatId, lang);
    await safeSend(chatId, tSync(lang, 'set_expertise_prompt'), { reply_markup: kb });
  }
  else if (data.startsWith('toggle_topic_')) {
    const topicId = parseInt(data.replace('toggle_topic_', ''));
    const { data: existing } = await supabase.from('mentor_topics').select('*').eq('telegram_id', chatId).eq('topic_id', topicId).single();
    if (existing) await supabase.from('mentor_topics').delete().eq('telegram_id', chatId).eq('topic_id', topicId);
    else await supabase.from('mentor_topics').insert({ telegram_id: chatId, topic_id: topicId });
    const kb = await getMentorTopicKeyboard(chatId, lang);
    await bot.editMessageReplyMarkup(kb, { chat_id: chatId, message_id: query.message.message_id });
    return bot.answerCallbackQuery(query.id);
  }
  else if (data.startsWith('mentor_sex_')) {
    const sex = data.replace('mentor_sex_', '');
    if (!state) return;
    state.tempData.sex = sex;
    await showTextInputWithCancel(chatId, tSync(lang, 'apply_q2'), 'awaiting_mentor_edu', state.tempData);
    return bot.answerCallbackQuery(query.id);
  }
  else if (data === 'topic_done') {
    await safeSend(chatId, tSync(lang, 'expertise_updated'));
    await showMainMenu(chatId);
  } else if (data === 'topic_cancel') {
    await showMainMenu(chatId);
  }

  // Settings Topics
  else if (data === 'settings_topics') {
    const { data: userTopics } = await supabase.from('user_topics').select('topic_id').eq('telegram_id', chatId);
    const selectedIds = (userTopics || []).map(ut => ut.topic_id);
    setState(chatId, 'edit_user_topics', null, { selectedTopics: selectedIds });
    const kb = await getTopicPickerKeyboard(selectedIds, 'settings_topic_', lang);
    await safeSend(chatId, tSync(lang, 'select_your_topics'), { reply_markup: kb });
  }
  else if (data.startsWith('settings_topic_')) {
    const action = data.replace('settings_topic_', '');
    if (!state) return safeSend(chatId, tSync(lang, 'session_expired'));
    if (action === 'done') {
      const topics = state.tempData.selectedTopics || [];
      await supabase.from('user_topics').delete().eq('telegram_id', chatId);
      for (const tid of topics) await supabase.from('user_topics').insert({ telegram_id: chatId, topic_id: tid });
      await safeSend(chatId, tSync(lang, 'topics_updated'));
      clearState(chatId); await showMainMenu(chatId);
    } else {
      const tid = parseInt(action);
      const current = state.tempData.selectedTopics || [];
      const updated = current.includes(tid) ? current.filter(x => x !== tid) : [...current, tid];
      setState(chatId, 'edit_user_topics', null, { ...state.tempData, selectedTopics: updated });
      await bot.editMessageReplyMarkup(
        await getTopicPickerKeyboard(updated, 'settings_topic_', lang),
        { chat_id: chatId, message_id: query.message.message_id }
      );
    }
  }

  else if (data.startsWith('settings_toggle_')) await toggleSetting(chatId, data.replace('settings_toggle_', ''));
  else if (data === 'settings_time') { setState(chatId, 'set_verse_time'); await showCancelKeyboard(chatId, tSync(lang, 'enter_verse_hour')); }
  else if (data === 'settings_lang') {
    await bot.editMessageText(tSync(lang, 'choose_language'), {
      chat_id: chatId, message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: 'English', callback_data: 'set_lang_en' },
          { text: 'አማርኛ', callback_data: 'set_lang_am' }
        ]]
      }
    });
  }
  else if (data.startsWith('set_lang_')) {
    const newLang = data.replace('set_lang_', '');
    await supabase.from('user_settings').update({ language: newLang }).eq('telegram_id', chatId);
    setLangCache(chatId, newLang);
    try {
      await bot.answerCallbackQuery(query.id);
    } catch { }
    await showPersistentMenu(chatId, tSync(newLang, 'language_updated'));
  }

  // Schedule
  else if (data === 'menu_schedule') {
    setState(chatId, 'sched_type', null, { type: 'group' });
    await safeSend(chatId, tSync(lang, 'select_session_type'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'session_private'), callback_data: 'sched_type_private' }],
          [{ text: tSync(lang, 'session_group'), callback_data: 'sched_type_group' }]
        ]
      }
    });
  }
  else if (data.startsWith('sched_type_')) {
    const type = data.replace('sched_type_', '');
    if (!state) return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'session_expired'), show_alert: true });
    state.tempData.type = type;
    if (type === 'private') {
      const { data: assignments, error } = await supabase.from('mentorship_assignments')
        .select('user_id').eq('mentor_id', chatId).eq('is_active', true);

      // Auto-repair swapped assignments (same logic as btn_my_mentees)
      if (error || !assignments?.length) {
        const { data: swapped } = await supabase.from('mentorship_assignments')
          .select('id, mentor_id').eq('user_id', chatId).eq('is_active', true);
        if (swapped?.length) {
          await supabase.from('mentorship_assignments')
            .update({ mentor_id: chatId, user_id: swapped[0].mentor_id }).eq('id', swapped[0].id);
          return bot.answerCallbackQuery(query.id, { text: '⚠️ We fixed it. Please tap Schedule again.', show_alert: true });
        }
        return safeSend(chatId, tSync(lang, 'no_mentees'));
      }

      const menteeIds = assignments.map(a => a.user_id);
      const { data: mentees } = await supabase.from('users').select('telegram_id, anonymous_id').in('telegram_id', menteeIds);

      if (!mentees?.length) return safeSend(chatId, tSync(lang, 'no_mentees'));

      const buttons = mentees.map(m => [{ text: m.anonymous_id, callback_data: `sched_mentee_${m.telegram_id}` }]);
      await safeSend(chatId, tSync(lang, 'select_mentee'), { reply_markup: { inline_keyboard: buttons } });
    } else {
      const kb = {
        inline_keyboard: [
          [{ text: tSync(lang, 'btn_today'), callback_data: 'sched_date_today' }],
          [{ text: tSync(lang, 'btn_tomorrow'), callback_data: 'sched_date_tomorrow' }],
          [{ text: tSync(lang, 'btn_pick_day'), callback_data: 'sched_date_calendar' }],
          [{ text: tSync(lang, 'btn_back'), callback_data: 'menu_schedule' }]
        ]
      };
      await safeSend(chatId, tSync(lang, 'enter_date'), { reply_markup: kb });
    }
  }
  else if (data.startsWith('sched_mentee_')) {
    if (!state) return;
    state.tempData.mentee_id = data.replace('sched_mentee_', '');
    const kb = {
      inline_keyboard: [
        [{ text: tSync(lang, 'btn_today'), callback_data: 'sched_date_today' }],
        [{ text: tSync(lang, 'btn_tomorrow'), callback_data: 'sched_date_tomorrow' }],
        [{ text: tSync(lang, 'btn_pick_day'), callback_data: 'sched_date_calendar' }],
        [{ text: tSync(lang, 'btn_back'), callback_data: 'menu_schedule' }]
      ]
    };
    await safeSend(chatId, tSync(lang, 'enter_date'), { reply_markup: kb });
  }
  else if (data === 'sched_date_today') {
    const today = getEthiopiaNow().toISOString().split('T')[0];
    if (!state) return;
    state.tempData.date = today;
    await safeSend(chatId, tSync(lang, 'enter_time'), { reply_markup: getTimeSlotsKeyboard(lang) });
  }
  else if (data === 'sched_date_tomorrow') {
    const tomorrow = new Date(getEthiopiaNow().getTime() + 86400000).toISOString().split('T')[0];
    if (!state) return;
    state.tempData.date = tomorrow;
    await safeSend(chatId, tSync(lang, 'enter_time'), { reply_markup: getTimeSlotsKeyboard(lang) });
  }
  else if (data === 'sched_date_calendar') {
    if (!state) return bot.answerCallbackQuery(query.id);
    const now = getEthiopiaNow();
    await safeSend(chatId, tSync(lang, 'enter_date'), { reply_markup: getCalendarKeyboard(now.getFullYear(), now.getMonth(), lang) });
  }
  else if (data.startsWith('cal_nav_')) {
    const parts = data.split('_'); // cal_nav_year_month
    await bot.editMessageReplyMarkup(getCalendarKeyboard(parseInt(parts[2]), parseInt(parts[3]), lang), { chat_id: chatId, message_id: query.message.message_id });
  }
  else if (data.startsWith('cal_select_')) {
    const date = data.replace('cal_select_', '');
    if (!state) return;
    state.tempData.date = date;
    await safeSend(chatId, tSync(lang, 'enter_time'), { reply_markup: getTimeSlotsKeyboard(lang) });
  }
  else if (data.startsWith('time_select_')) {
    const time = data.replace('time_select_', '');
    if (!state) return;
    await createVideoSession(chatId, state.tempData.date, time);
  }
  else if (data === 'time_custom') {
    if (!state) return;
    setState(chatId, 'sched_custom_time', null, state.tempData);
    await showCancelKeyboard(chatId, tSync(lang, 'enter_custom_time'));
  }

  // Mentees
  else if (data === 'menu_mentees') {
    const { data: mentees, error } = await supabase.from('mentorship_assignments')
      .select('user_id, topics(name, name_am)').eq('mentor_id', chatId).eq('is_active', true);

    if (error) { console.error('[My Mentees] Error:', error); return bot.answerCallbackQuery(query.id, { text: 'Error loading mentees.' }); }

    if (!mentees?.length) {
      const { data: swapped } = await supabase.from('mentorship_assignments').select('id, mentor_id').eq('user_id', chatId).eq('is_active', true);
      if (swapped?.length) {
        await supabase.from('mentorship_assignments').update({ mentor_id: chatId, user_id: swapped[0].mentor_id }).eq('id', swapped[0].id);
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Repaired. Please try again.', show_alert: true });
      }
      return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'no_mentees'), show_alert: true });
    }

    await sendMenteeList(chatId, lang, mentees);
    return bot.answerCallbackQuery(query.id);
  }
  else if (data.startsWith('end_mentorship_')) {
    const userId = data.replace('end_mentorship_', '');
    await endMentorship(chatId, userId, 'mentor');
  }
  else if (data.startsWith('focus_chat_')) {
    const userId = data.replace('focus_chat_', '');
    setState(chatId, 'chat_active', userId);
    const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', userId).single();
    await safeSend(chatId, tSync(lang, 'focus_set', { nick: mdEscape(u?.anonymous_id || userId) }));
  }

  else if (data === 'menu_apply') {
    const { data: user } = await supabase.from('users').select('role').eq('telegram_id', chatId).single();
    if (user?.role === 'mentor' || user?.role === 'admin')
      return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'already_mentor'), show_alert: true });
    const { data: ex } = await supabase.from('mentor_applications').select('id').eq('telegram_id', chatId).eq('status', 'pending').single();
    if (ex) return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'application_pending'), show_alert: true });
    if (await blockApplyIfActiveMentee(chatId, lang)) {
      return bot.answerCallbackQuery(query.id).catch(() => { });
    }
    setState(chatId, 'awaiting_mentor_sex');
    await safeSend(chatId, tSync(lang, 'apply_q1'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: tSync(lang, 'sex_male'), callback_data: 'mentor_sex_M' }, { text: tSync(lang, 'sex_female'), callback_data: 'mentor_sex_F' }],
          [{ text: tSync(lang, 'sex_prefer_not'), callback_data: 'mentor_sex_prefer_not' }]
        ]
      }
    });
  }

  else if (data === 'menu_help') {
    await safeSend(chatId, tSync(lang, 'help_text'));
  }

  await bot.answerCallbackQuery(query.id).catch(() => { });
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

setInterval(async () => {
  const now = getEthiopiaNow();
  if (now.getMinutes() !== 0) return;

  const currentHour = now.getHours();
  const { data: opted } = await supabase.from('user_settings')
    .select('telegram_id, language').eq('notify_daily_verse', true).eq('verse_time', currentHour);
  const { data: vs } = await supabase.from('daily_verses').select('*').eq('is_active', true).order('id', { ascending: true });
  const v = vs?.[Math.floor(Date.now() / 86400000) % (vs?.length || 1)];

  if (v && opted?.length) {
    for (const u of opted) {
      const lang = u.language || 'en';
      let text = card({
        icon: '📖',
        title: tSync(lang, 'verse_title'),
        quote: v.text,
        fields: [['📜', lang === 'am' ? 'ጥቅስ' : 'Reference', v.reference]],
      });
      if (lang === 'am') {
        const amVerse = await getAmharicVerse(v.text);
        if (amVerse) text += `\n\n<b>${esc(tSync('am', 'amharic_translation'))}:</b>\n<blockquote>${esc(amVerse)}</blockquote>`;
      }
      text += `\n\n<i>${lang === 'am' ? 'ዛሬ ቃሉ ብርሃን ይሁንልዎ ✨' : 'May the Word light your day ✨'}</i>`;
      await safeSend(u.telegram_id, text, { ...HTML, reply_markup: goldKeyboard(tSync(lang, 'btn_open_app'), APP_URL) });
    }
  }
}, 60 * 1000);

// Background job to reset streaks at midnight Ethiopia time.
// Only hard-resets streaks that missed TWO OR MORE full days — a single missed
// day is left alone so a banked Streak Saver can still auto-cover it the next
// time the user opens the app and hits /api/streaks/mark (see routes/streaks.js).
setInterval(async () => {
  const now = getEthiopiaNow();
  if (now.getHours() !== 0 || now.getMinutes() !== 0) return;

  const twoDaysAgo = new Date(now);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

  const { error } = await supabase.from('bible_streaks')
    .update({ current_streak: 0 })
    .lt('last_read_date', twoDaysAgoStr);

  if (!error) console.log('[Scheduler] Daily streak reset check completed.');
}, 60 * 1000);

// Evening Streak Saver reminder — nudges anyone with an active streak who
// hasn't read yet today, so a busy evening doesn't cost them their streak.
// Fires once, at 20:00 Ethiopia time.
setInterval(async () => {
  const now = getEthiopiaNow();
  if (now.getHours() !== 20 || now.getMinutes() !== 0) return;

  const todayStr = now.toISOString().split('T')[0];

  const { data: streaks, error } = await supabase.from('bible_streaks')
    .select('telegram_id, current_streak, freezes_available, last_read_date')
    .gt('current_streak', 0)
    .neq('last_read_date', todayStr);

  if (error) { console.error('[Scheduler] Streak reminder query failed:', error.message); return; }
  if (!streaks?.length) return;

  const ids = streaks.map(s => s.telegram_id);
  const [{ data: settingsRows }, { data: userRows }] = await Promise.all([
    supabase.from('user_settings').select('telegram_id, notify_streak_reminder, language').in('telegram_id', ids),
    supabase.from('users').select('telegram_id, chat_id').in('telegram_id', ids),
  ]);

  const settingsMap = new Map((settingsRows || []).map(r => [String(r.telegram_id), r]));
  const chatIdMap = new Map((userRows || []).map(r => [String(r.telegram_id), r.chat_id]));

  let sent = 0;
  for (const s of streaks) {
    const settings = settingsMap.get(String(s.telegram_id));
    if (settings && settings.notify_streak_reminder === false) continue; // opted out

    const lang = settings?.language || 'en';
    const chatId = chatIdMap.get(String(s.telegram_id)) || s.telegram_id;
    const key = (s.freezes_available || 0) > 0 ? 'streak_reminder_with_freeze' : 'streak_reminder';
    const ok = await safeSend(chatId, card({
      icon: '🔥',
      title: lang === 'am' ? `የ${s.current_streak} ቀናት ጉዞዎን ይጠብቁ` : `Protect Your ${s.current_streak}-Day Streak`,
      body: tSync(lang, key, { streak: s.current_streak }),
      footer: lang === 'am' ? 'ጥቂት ደቂቃዎች ብቻ ይበቃሉ 📖' : 'Just a few minutes is enough 📖',
    }), { ...HTML, reply_markup: goldKeyboard(tSync(lang, 'btn_open_app'), APP_URL) });
    if (ok) sent++;
  }
  if (sent) console.log(`[Scheduler] Sent ${sent} streak reminder(s).`);
}, 60 * 1000);

// Tiered reminder ladder for mentees who ARE matched with a mentor but
// have gone quiet (checked against users.last_active, which both the bot
// and the mini app's /api/auth/login keep up to date).
//
// Unlike a flat "remind every day past N days" job, this escalates through
// three tiers as the inactive stretch grows (3 / 7 / 14 days), and a
// mentee is only re-pinged once every 2 days (Duolingo-style — no daily
// nagging) OR immediately if they've just crossed into a new, higher tier,
// whichever comes first. last_reminder_tier/last_reminder_at on
// mentorship_assignments track this per assignment. Becoming active again
// clears both, so the next stretch of silence restarts at tier 1 instead
// of picking up where it left off.
const MENTEE_INACTIVITY_TIERS = [
  { tier: 3, days: 14, key: 'mentee_inactive_reminder_tier3' },
  { tier: 2, days: 7, key: 'mentee_inactive_reminder_tier2' },
  { tier: 1, days: 3, key: 'mentee_inactive_reminder_tier1' },
];
const MENTEE_REMINDER_RESEND_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

setInterval(async () => {
  const now = getEthiopiaNow();
  if (now.getHours() !== 10 || now.getMinutes() !== 0) return;

  const { data: assignments, error: aErr } = await supabase
    .from('mentorship_assignments')
    .select('id, user_id, mentor_id, last_reminder_tier, last_reminder_at')
    .eq('is_active', true);
  if (aErr) { console.error('[Scheduler] Inactive-mentee query failed:', aErr.message); return; }
  if (!assignments?.length) return;

  const menteeIds = [...new Set(assignments.map(a => a.user_id))];
  const mentorIds = [...new Set(assignments.map(a => a.mentor_id))];

  const { data: mentees, error: uErr } = await supabase
    .from('users')
    .select('telegram_id, chat_id, anonymous_id, last_active')
    .in('telegram_id', menteeIds)
    .eq('is_banned', false);
  if (uErr) { console.error('[Scheduler] Inactive-mentee user fetch failed:', uErr.message); return; }
  if (!mentees?.length) return;

  const { data: settingsRows } = await supabase
    .from('user_settings')
    .select('telegram_id, display_name, language')
    .in('telegram_id', [...menteeIds, ...mentorIds]);
  const settingsMap = new Map((settingsRows || []).map(r => [String(r.telegram_id), r]));
  const menteeMap = new Map(mentees.map(u => [String(u.telegram_id), u]));

  let sent = 0;
  for (const a of assignments) {
    const u = menteeMap.get(String(a.user_id));
    if (!u) continue; // banned, or user fetch missed them

    const daysInactive = (now.getTime() - new Date(u.last_active).getTime()) / (24 * 60 * 60 * 1000);
    const target = MENTEE_INACTIVITY_TIERS.find(t => daysInactive >= t.days);
    const targetTier = target?.tier || 0;

    if (targetTier === 0) {
      // Active again — clear the ladder so the next quiet stretch starts at tier 1.
      if (a.last_reminder_tier > 0) {
        await supabase.from('mentorship_assignments')
          .update({ last_reminder_tier: 0, last_reminder_at: null })
          .eq('id', a.id);
      }
      continue;
    }

    const tierJustIncreased = targetTier > (a.last_reminder_tier || 0);
    const intervalElapsed = !a.last_reminder_at
      || (now.getTime() - new Date(a.last_reminder_at).getTime()) >= MENTEE_REMINDER_RESEND_MS;
    if (!tierJustIncreased && !intervalElapsed) continue;

    const menteeSettings = settingsMap.get(String(a.user_id));
    const mentorSettings = settingsMap.get(String(a.mentor_id));
    const lang = menteeSettings?.language || 'en';
    const name = menteeSettings?.display_name || u.anonymous_id;
    const mentorName = mentorSettings?.display_name || tSync(lang, 'mentee_reminder_default_mentor_name');
    const chatId = u.chat_id || u.telegram_id;

    const am = lang === 'am';
    const toneIcon = { 1: '👋', 2: '💛', 3: '🕊️' }[targetTier];
    const toneTitle = {
      1: am ? 'ናፍቆትዎ አለን' : 'We Miss You',
      2: am ? 'አማካሪዎ ይጠብቅዎታል' : 'Your Mentor Is Thinking of You',
      3: am ? 'አሁንም ከእኛ ጋር ነዎት?' : 'Are You Still With Us?',
    }[targetTier];
    const ok = await safeSend(chatId, card({
      icon: toneIcon,
      title: toneTitle,
      body: tSync(lang, target.key, { name, mentor: mentorName }),
    }), { ...HTML, reply_markup: goldKeyboard(am ? 'ወደ ውይይት ተመለስ' : 'Back to Chat', APP_URL) });
    if (ok) {
      sent++;
      await supabase.from('mentorship_assignments')
        .update({ last_reminder_tier: targetTier, last_reminder_at: now.toISOString() })
        .eq('id', a.id);
    }
  }
  if (sent) console.log(`[Scheduler] Sent ${sent} tiered inactive-mentee reminder(s).`);
}, 60 * 1000);

// Reminder for users who registered but are NOT matched with a mentor and
// have no pending request in flight (i.e. they never asked, or their last
// attempt didn't go anywhere and they haven't tried again). Same 5-day
// last_active gate and daily re-evaluation as the reminder above, so it
// stops as soon as the user sends a request or gets matched.
setInterval(async () => {
  const now = getEthiopiaNow();
  if (now.getHours() !== 15 || now.getMinutes() !== 0) return;

  const cutoff = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: assignments, error: aErr }, { data: pendingReqs, error: rErr }] = await Promise.all([
    supabase.from('mentorship_assignments').select('user_id').eq('is_active', true),
    supabase.from('mentorship_requests').select('user_id').eq('status', 'pending'),
  ]);
  if (aErr || rErr) {
    console.error('[Scheduler] Unmatched-user query failed:', (aErr || rErr)?.message);
    return;
  }

  const excludeIds = [...new Set([
    ...(assignments || []).map(a => a.user_id),
    ...(pendingReqs || []).map(r => r.user_id),
  ])];

  let query = supabase
    .from('users')
    .select('telegram_id, chat_id, anonymous_id, last_active')
    .eq('role', 'user')
    .eq('is_banned', false)
    .lte('last_active', cutoff);
  if (excludeIds.length) query = query.not('telegram_id', 'in', `(${excludeIds.join(',')})`);

  const { data: unmatched, error: uErr } = await query;
  if (uErr) { console.error('[Scheduler] Unmatched-user fetch failed:', uErr.message); return; }
  if (!unmatched?.length) return;

  const ids = unmatched.map(u => u.telegram_id);
  const { data: settingsRows } = await supabase
    .from('user_settings')
    .select('telegram_id, display_name, language')
    .in('telegram_id', ids);
  const settingsMap = new Map((settingsRows || []).map(r => [String(r.telegram_id), r]));

  let sent = 0;
  for (const u of unmatched) {
    const settings = settingsMap.get(String(u.telegram_id));
    const lang = settings?.language || 'en';
    const name = settings?.display_name || u.anonymous_id;
    const chatId = u.chat_id || u.telegram_id;
    const ok = await safeSend(chatId, card({
      icon: '🤝',
      title: lang === 'am' ? 'አማካሪ እየጠበቀዎት ነው' : 'A Mentor Is Ready for You',
      body: tSync(lang, 'unmatched_mentor_reminder', { name }),
      footer: lang === 'am' ? 'ብቻዎን መጓዝ የለብዎትም 💛' : "You don't have to walk alone 💛",
    }), { ...HTML, reply_markup: goldKeyboard(lang === 'am' ? 'አማካሪ ፈልግ' : 'Find a Mentor', `${APP_URL}?start=mentors`) });
    if (ok) sent++;
  }
  if (sent) console.log(`[Scheduler] Sent ${sent} unmatched-user reminder(s).`);
}, 60 * 1000);

// Live-session "starting soon" reminder — fires once per session, to the
// host and every invited participant, when the session is due to start
// within the next 10 minutes.
//
// Uses the `reminder_sent` flag rather than an exact time-window match:
// once a session's scheduled_at falls inside the 10-minute lookahead, it's
// picked up on the next tick, the reminder goes out, and the flag is set —
// so it can't be re-sent on a later tick no matter how the minute boundary
// lines up against the actual scheduled_at second.
let sessionReminderRunning = false;
setInterval(async () => {
  // Skip this tick if the previous one is still running (slow DB), otherwise
  // ticks pile up and make the overload worse.
  if (sessionReminderRunning) return;
  sessionReminderRunning = true;
  try {
  const nowIso = new Date().toISOString();
  const windowEndIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data: dueSessions, error } = await supabase
    .from('video_sessions')
    .select('id, title, host_id, scheduled_at, session_participants(telegram_id)')
    .eq('status', 'scheduled')
    .eq('reminder_sent', false)
    .gt('scheduled_at', nowIso)
    .lte('scheduled_at', windowEndIso);

  if (error) { console.error('[Scheduler] Session reminder query failed:', error.message); return; }
  if (!dueSessions?.length) return;

  let sent = 0;
  for (const s of dueSessions) {
    const recipientIds = new Set([s.host_id, ...(s.session_participants || []).map(p => p.telegram_id)]);
    for (const chatId of recipientIds) {
      await notifySessionReminder(chatId, { session_id: s.id, title: s.title });
      sent++;
    }
    await supabase.from('video_sessions').update({ reminder_sent: true }).eq('id', s.id);
  }
  console.log(`[Scheduler] Sent starting-soon reminder for ${dueSessions.length} session(s), ${sent} message(s).`);
  } catch (e) {
    console.error('[Scheduler] Session reminder tick failed:', e.message);
  } finally {
    sessionReminderRunning = false;
  }
}, 60 * 1000);

// Goal maintenance: catch-up, not clock-exact. Runs every 5 minutes and once
// shortly after boot; everything it does is idempotent and driven by dates, so
// a restart or a sleeping host never skips a night (the old 23:57-only jobs did).
//   1. goal_sweep_missed() flags every overdue pending task atomically. Each
//      newly-missed day is announced once, and the mentor is warned when 2-3
//      days in a row are missed.
//   2. Reminders: a task is claimed (last_reminder_sent_on = today) before it
//      is sent, so it is reminded at most once a day.
let goalMaintenanceRunning = false;
async function runGoalMaintenance() {
  if (goalMaintenanceRunning) return;
  goalMaintenanceRunning = true;
  try {
    const today = ethiopiaToday();
    await sweepMissedGoalTasks(today);
    await sendGoalReminders(today);
  } catch (e) {
    console.error('[Scheduler] Goal maintenance failed:', e.message);
  } finally {
    goalMaintenanceRunning = false;
  }
}

async function sweepMissedGoalTasks(today) {
  const { data: missed, error } = await supabase.rpc('goal_sweep_missed', { p_today: today });
  if (error) throw error;
  if (!missed?.length) return;
  const byGoal = new Map();
  for (const t of missed) {
    if (!byGoal.has(t.goal_id)) byGoal.set(t.goal_id, []);
    byGoal.get(t.goal_id).push(t);
  }
  for (const [goalId, tasks] of byGoal) {
    const full = await emitGoal(supabase, goalId);
    if (!full) continue;
    await notifyGoalMissedDays(full.mentee_id, full, [...new Set(tasks.map(t => String(t.due_date).substring(0, 10)))]);
    const run = trailingMissedDays(full.tasks, today);
    if (full.type === 'challenge' && (run === 2 || run === 3)) await notifyMentorMissedRun(full.mentor_id, full, run);
  }
  console.log(`[Scheduler] Flagged ${missed.length} goal task(s) as missed.`);
}

async function sendGoalReminders(today) {
  const nowHM = ethiopiaTimeHM();
  const notClaimed = `last_reminder_sent_on.is.null,last_reminder_sent_on.neq.${today}`;
  const { data: rows, error } = await supabase
    .from('goal_tasks')
    .select('id, goal_id, mentee_id, title, due_date, goals!inner(id, title, type, reminder_time, status)')
    .eq('status', 'pending')
    .eq('goals.status', 'active')
    .gte('due_date', today)
    .lte('due_date', addDays(today, 1))
    .or(notClaimed);
  if (error) throw error;

  const due = (rows || []).filter(r => {
    const at = r.goals.reminder_time ? String(r.goals.reminder_time).substring(0, 5) : '09:00';
    if (nowHM < at) return false;
    return r.goals.type === 'challenge' ? String(r.due_date).substring(0, 10) === today : true;
  });
  if (!due.length) return;

  const { data: claimed } = await supabase.from('goal_tasks')
    .update({ last_reminder_sent_on: today }).in('id', due.map(r => r.id)).or(notClaimed).select('id');
  const ok = new Set((claimed || []).map(r => r.id));

  const byGoal = new Map();
  for (const r of due.filter(r => ok.has(r.id))) {
    if (!byGoal.has(r.goal_id)) byGoal.set(r.goal_id, { goal: r.goals, menteeId: r.mentee_id, tasks: [] });
    byGoal.get(r.goal_id).tasks.push(r);
  }
  for (const { goal, menteeId, tasks } of byGoal.values()) await notifyDailyReminder(menteeId, goal, tasks);
  if (byGoal.size) console.log(`[Scheduler] Sent ${byGoal.size} goal reminder(s).`);
}

setInterval(runGoalMaintenance, 5 * 60 * 1000);
setTimeout(runGoalMaintenance, 30 * 1000);

// Mentor application review polling
let lastAppCheck = new Date().toISOString();
setInterval(async () => {
  const { data: apps } = await supabase.from('mentor_applications')
    .select('telegram_id, status, reviewed_at')
    .neq('status', 'pending')
    .gt('reviewed_at', lastAppCheck);
  if (apps?.length) {
    for (const app of apps) {
      if (app.status === 'approved') await notifyMentorApproved(app.telegram_id);
      else if (app.status === 'rejected') await notifyMentorRejected(app.telegram_id);
    }
    lastAppCheck = new Date().toISOString();
  }
}, 60 * 1000);

// State cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of userStates.entries()) {
    if (state.expires < now) userStates.delete(id);
  }
}, 60 * 60 * 1000);

module.exports = {
  bot,
  sendCard,
  notifyMentorApproved,
  notifyMentorRejected,
  broadcastToAll,
  notifySessionInvite,
  notifySessionReminder,
  notifySessionStarted,
  notifySessionWaiting,
  notifyMentorshipRequest,
  notifyAdminNewMentorApplication,
  notifyMentorshipAccepted,
  notifyMentorshipRejected,
  notifyMessage,
  notifyFileMessage,
  syncNotificationEdit,
  syncNotificationDelete,
  notifyNewGoal,
  notifyGoalDueReminder,
  notifyGoalMissed,
  notifyTaskDone,
  runGoalMaintenance,
  endMentorship,
  safeSend,
  getUserLang,
  rejectOtherPendingRequestsForUser
};