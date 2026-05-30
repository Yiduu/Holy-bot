'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// HOLY HELPER BOT — Complete Rewrite
// Modules: State, Localization, Formatting, Mentor Search, Chat, Streaks,
//          Journal, Verse, Settings, Scheduler, Rating, Waiting List
// ═══════════════════════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const APP_URL = process.env.MINI_APP_URL || 'https://your-app.com';
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
  try {
    return new Date(dateStr).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz, timeZoneName: 'short' });
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
  try { return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra }); }
  catch (err) { console.error(`[Bot] Failed to send to ${chatId}:`, err.message); }
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

async function showPersistentMenu(chatId, customText) {
  const [{ data: user }, lang] = await Promise.all([
    supabase.from('users').select('role, anonymous_id').eq('telegram_id', chatId).single(),
    getUserLang(chatId)
  ]);
  const role = user?.role || 'user';
  const menuText = customText || tSync(lang, 'menu_welcome', { nick: mdEscape(user?.anonymous_id || '') });

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

  await safeSend(chatId, menuText, {
    reply_markup: {
      keyboard: kb,
      resize_keyboard: true,
      one_time_keyboard: false
    }
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

async function getTopicPickerKeyboard(selectedIds = [], actionPrefix = 'reg_topic_', lang = 'en') {
  const { data: topics } = await supabase.from('topics').select('id, name').eq('is_active', true).order('name');
  if (!topics) return { inline_keyboard: [] };

  const buttons = topics.map(t => {
    const isSelected = selectedIds.includes(t.id);
    return [{ text: `${isSelected ? '✅' : '⬜'} ${t.name}`, callback_data: `${actionPrefix}${t.id}` }];
  });
  buttons.push([{ text: tSync(lang, 'btn_done'), callback_data: `${actionPrefix}done` }]);
  return { inline_keyboard: buttons };
}

async function getMentorTopicKeyboard(chatId, lang = 'en') {
  const { data: topics } = await supabase.from('topics').select('id, name').eq('is_active', true).order('name');
  const { data: mentorTopics } = await supabase.from('mentor_topics').select('topic_id').eq('telegram_id', chatId);
  const selectedIds = (mentorTopics || []).map(mt => mt.topic_id);
  if (!topics) return { inline_keyboard: [] };

  const buttons = topics.map(t => {
    const isSelected = selectedIds.includes(t.id);
    return [{ text: `${isSelected ? '✅' : '⬜'} ${t.name}`, callback_data: `toggle_topic_${t.id}` }];
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

    const { data: sess, error } = await supabase.from('video_sessions').insert({
      host_id: chatId,
      mentor_id: chatId,
      scheduled_at: scheduledAt.toISOString(),
      is_group: isGroup,
      title: isGroup ? 'Group Session' : '1-on-1 Session',
      mentee_id: menteeId,
      room_name: roomName,
      room_password: roomPassword,
      status: 'scheduled',
      max_participants: isGroup ? 10 : 2
    }).select().single();

    if (error) throw error;

    const link = `${APP_URL}?start=session_${sess.id}`;

    // Format confirmation details for the mentor
    const { data: mentorSettings } = await supabase.from('user_settings').select('timezone').eq('telegram_id', chatId).single();
    let hostTimezone = mentorSettings?.timezone || 'Africa/Addis_Ababa';
    if (!hostTimezone || hostTimezone === 'UTC') hostTimezone = 'Africa/Addis_Ababa';

    const dateStr = scheduledAt.toLocaleDateString('en-US', { timeZone: hostTimezone, dateStyle: 'medium' });
    const timeStr = scheduledAt.toLocaleTimeString('en-US', { timeZone: hostTimezone, timeStyle: 'short', timeZoneName: 'short' });
    const typeLabel = state.tempData.type === 'private' ? 'Private' : 'Group';

    const mentorMsg = `✅ Session scheduled!\n\nDate: ${dateStr}\nTime: ${timeStr}\nType: ${typeLabel}\n\nJoin link: ${link}`;

    await bot.sendMessage(chatId, mentorMsg);
    console.log(`[Scheduler] Success: Session ${sess.id} created for mentor ${chatId}`);

    if (sess.mentee_id) {
      await notifySessionInvite(sess.mentee_id, {
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

// ─── Registration Wizard ──────────────────────────────────────────────────────

async function startRegistration(chatId, startParam = null) {
  setState(chatId, 'reg_sex', null, { startParam });
  await safeSend(chatId, "Welcome! Let's get you set up. First, what is your sex?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Male', callback_data: 'reg_sex_M' }, { text: 'Female', callback_data: 'reg_sex_F' }],
        [{ text: 'Prefer not to say', callback_data: 'reg_sex_prefer_not' }]
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

  let query = supabase.from('users')
    .select('telegram_id, anonymous_id, public_alias, rating, rating_count, last_active, max_mentees, user_settings(bio, display_name)')
    .in('telegram_id', ids)
    .eq('is_banned', false);

  // Count active mentees per mentor to filter out full ones
  const { data: allMentors } = await query;
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

  let available = allMentors.filter(m => (menteeCount[m.telegram_id] || 0) < (m.max_mentees || DEFAULT_MAX_MENTEES));

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

  let text = `🔍 *${tSync(lang, 'mentor_list_title')}* (${tSync(lang, 'page_indicator', { cur: page + 1, total: totalPages })})\n\n`;
  const buttons = [];

  for (const m of paginated) {
    const badge = onlineBadge(m.last_active);
    const displayName = mdEscape(m.public_alias || m.user_settings?.display_name || m.anonymous_id);
    const bio = mdEscape(m.user_settings?.bio || tSync(lang, 'no_bio'));
    const stars = renderStars(m.rating, m.rating_count);
    const status = isOnline(m.last_active) ? tSync(lang, 'status_online') : tSync(lang, 'status_away');
    const slots = (m.max_mentees || DEFAULT_MAX_MENTEES) - (menteeCount[m.telegram_id] || 0);

    text += `${badge} *${displayName}*\n`;
    text += `${tSync(lang, 'label_status')}: ${status}\n`;
    text += `${tSync(lang, 'label_rating')}: ${stars}\n`;
    text += `${tSync(lang, 'label_slots')}: ${slots}\n`;
    text += `${tSync(lang, 'label_bio')}: ${bio.substring(0, 80)}${bio.length > 80 ? '…' : ''}\n\n`;

    buttons.push([{ text: `${tSync(lang, 'btn_request')} ${displayName}`, callback_data: `mentor_req_${m.telegram_id}_${numericTopicId}` }]);
  }

  // Sort buttons row
  const sortRow = SORT_OPTIONS.map(s => ({
    text: `${s === sort ? '✅ ' : ''}${tSync(lang, `sort_${s}`)}`,
    callback_data: `mentor_sort_${s}_${numericTopicId}_${page}`
  }));
  buttons.push(sortRow);

  // Pagination row
  const navRow = [];
  if (page > 0) navRow.push({ text: tSync(lang, 'btn_prev'), callback_data: `mentors_page_${page - 1}_${numericTopicId}_${sort}` });
  if (page < totalPages - 1) navRow.push({ text: tSync(lang, 'btn_next'), callback_data: `mentors_page_${page + 1}_${numericTopicId}_${sort}` });
  if (navRow.length) buttons.push(navRow);

  await safeSend(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

// ─── Waiting List ─────────────────────────────────────────────────────────────

async function joinWaitingList(chatId, topicId) {
  const lang = await getUserLang(chatId);
  await supabase.from('waiting_list').upsert(
    { user_id: chatId, topic_id: topicId, joined_at: new Date().toISOString(), notified: false },
    { onConflict: 'user_id,topic_id' }
  );
  await safeSend(chatId, tSync(lang, 'waitlist_joined'));
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
    await safeSend(w.user_id, tSync(lang, 'waitlist_mentor_available'));
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

async function forwardMessage(fromId, toId, text) {
  await supabase.from('messages').insert({ from_id: fromId, to_id: toId, content: text });
  const [{ data: sender }, { data: recipient }] = await Promise.all([
    supabase.from('users').select('anonymous_id, role').eq('telegram_id', fromId).single(),
    supabase.from('users').select('chat_id').eq('telegram_id', toId).single()
  ]);
  const lang = await getUserLang(toId);
  if (recipient?.chat_id) {
    const roleLabel = sender?.role === 'mentor' ? tSync(lang, 'role_mentor') : tSync(lang, 'role_mentee');
    const msgText = tSync(lang, 'msg_from_partner', { role: roleLabel, nick: mdEscape(sender?.anonymous_id), text: mdEscape(text) });

    const partnersInfo = await getActiveChatPartners(toId);
    const hasMultiple = partnersInfo && partnersInfo.partners.length > 1;

    const extra = {};
    if (hasMultiple) {
      extra.reply_markup = {
        inline_keyboard: [[{
          text: lang === 'am' ? `💬 ከ @${sender?.anonymous_id} ጋር አውራ` : `💬 Chat with @${sender?.anonymous_id}`,
          callback_data: `focus_chat_${fromId}`
        }]]
      };
    }

    await safeSend(recipient.chat_id, msgText, extra);
    setState(toId, 'chat_active', fromId);
  }
}

// ─── Rating System ────────────────────────────────────────────────────────────

async function promptRating(userId, mentorId) {
  const lang = await getUserLang(userId);
  const { data: mentor } = await supabase.from('users').select('anonymous_id, public_alias').eq('telegram_id', mentorId).single();
  const displayName = mentor?.public_alias || mentor?.anonymous_id;
  setState(userId, 'rating_pending', mentorId, { mentorId });
  await safeSend(userId, tSync(lang, 'rate_mentor_prompt', { name: mdEscape(displayName) }), {
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
  const newCount = oldCount + 1;
  const newRating = (oldRating * oldCount + stars) / newCount;

  await supabase.from('users').update({ rating: newRating, rating_count: newCount }).eq('telegram_id', mentorId);
  await supabase.from('mentor_ratings').insert({ mentor_id: mentorId, user_id: chatId, stars, created_at: new Date().toISOString() });

  clearState(chatId);
  await safeSend(chatId, tSync(lang, 'rating_submitted', { stars: '⭐'.repeat(stars) }));
  await showMainMenu(chatId);
}

// ─── End Mentorship ───────────────────────────────────────────────────────────

async function endMentorship(chatId, partnerId, initiatorRole) {
  const lang = await getUserLang(chatId);
  await supabase.from('mentorship_assignments')
    .update({ is_active: false, ended_at: new Date().toISOString() })
    .or(`and(mentor_id.eq.${chatId},user_id.eq.${partnerId}),and(mentor_id.eq.${partnerId},user_id.eq.${chatId})`);

  await safeSend(chatId, tSync(lang, 'mentorship_ended'));
  const partnerLang = await getUserLang(partnerId);
  await safeSend(partnerId, tSync(partnerLang, 'mentorship_ended'));

  // If initiator was mentor, ask mentee to rate
  if (initiatorRole === 'mentor') {
    await promptRating(partnerId, chatId);
  } else {
    await promptRating(chatId, partnerId);
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
  const { data: vs } = await supabase.from('daily_verses').select('*').eq('is_active', true);
  const v = vs?.[Math.floor(Date.now() / 86400000) % (vs.length || 1)];
  if (!v) return safeSend(chatId, tSync(lang, 'no_verse'));

  let text = `📖 *${tSync(lang, 'verse_title')}*\n*${mdEscape(v.reference)}*\n\n${mdEscape(v.text)}`;
  if (lang === 'am') {
    const amVerse = await getAmharicVerse(v.text);
    if (amVerse) text += `\n\n🇪🇹 *${tSync('am', 'amharic_translation')}:*\n_${mdEscape(amVerse)}_`;
  }
  await safeSend(chatId, text);
}

// ─── Streak ───────────────────────────────────────────────────────────────────

async function handleStreakFlow(chatId) {
  const lang = await getUserLang(chatId);
  let [{ data: s }, { data: vs }] = await Promise.all([
    supabase.from('bible_streaks').select('*').eq('telegram_id', chatId).single(),
    supabase.from('daily_verses').select('*').eq('is_active', true)
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
      [{ text: `🔔 ${tSync(lang, 'settings_verse_notif')}: ${s?.notify_daily_verse ? tSync(lang, 'on') : tSync(lang, 'off')}`, callback_data: 'settings_toggle_notify_daily_verse' }],
      [{ text: `🔔 ${tSync(lang, 'settings_msg_notif')}: ${s?.notify_messages ? tSync(lang, 'on') : tSync(lang, 'off')}`, callback_data: 'settings_toggle_notify_messages' }],
      [{ text: `⏰ ${tSync(lang, 'settings_verse_time')}: ${format12h(s?.verse_time ?? 0)}`, callback_data: 'settings_time' }],
      [{ text: `🌍 ${tSync(lang, 'settings_language')}: ${lang === 'en' ? 'EN' : 'አማ'}`, callback_data: 'settings_lang' }],
      [{ text: `📚 ${tSync(lang, 'settings_my_topics')}`, callback_data: 'settings_topics' }]
    ]
  };

  if (user?.role === 'mentor' || user?.role === 'admin') {
    kb.inline_keyboard.push([{ text: `🎓 ${tSync(lang, 'settings_expertise_topics')}`, callback_data: 'menu_mentor_topics' }]);
  }

  await safeSend(chatId, `⚙️ *${tSync(lang, 'settings_title')}*`, { reply_markup: kb });
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

  // Verify mentor capacity
  const { data: mentor } = await supabase.from('users').select('max_mentees').eq('telegram_id', mentorId).single();
  const { data: current } = await supabase.from('mentorship_assignments').select('id').eq('mentor_id', mentorId).eq('is_active', true);
  if ((current?.length || 0) >= (mentor?.max_mentees || DEFAULT_MAX_MENTEES)) {
    await safeSend(mentorId, tSync(mentorLang, 'mentor_at_capacity'));
    await safeSend(userId, tSync(userLang, 'mentor_rejected'));
    await notifyWaitingList(topicId);
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
  await safeSend(userId, tSync(userLang, 'mentorship_accepted'));
  await safeSend(mentorId, tSync(mentorLang, 'mentorship_accepted_mentor'));

  // Log success
  console.log(`[Accept] Assignment created: mentor=${mentorId}, user=${userId}, topic=${topicId}`);
}

async function rejectMentorship(mentorId, userId) {
  const mentorLang = await getUserLang(mentorId);
  const userLang = await getUserLang(userId);
  await supabase.from('mentorship_requests').update({ status: 'rejected' }).eq('mentor_id', mentorId).eq('user_id', userId);
  await safeSend(userId, tSync(userLang, 'mentor_rejected'));
  await safeSend(mentorId, tSync(mentorLang, 'reject_confirmed'));
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notifyMentorApproved(chatId) {
  const lang = await getUserLang(chatId);
  await safeSend(chatId, tSync(lang, 'mentor_approved'));
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
  let msg = tSync(lang, 'mentor_application_rejected');
  if (app?.admin_note) msg += `\n\n*${tSync(lang, 'admin_note')}:* ${app.admin_note}`;
  await safeSend(chatId, msg);
}

async function broadcastToAll(message, roleFilter) {
  let query = supabase.from('users').select('telegram_id, user_settings(language)').eq('is_banned', false);
  if (roleFilter) query = query.eq('role', roleFilter);
  const { data: users } = await query;
  if (users) {
    for (const u of users) {
      const lang = u.user_settings?.language || 'en';
      await safeSend(u.telegram_id, `📢 *${tSync(lang, 'broadcast')}*\n\n${message}`);
    }
  }
}

async function notifySessionInvite(chatId, sessionInfo) {
  const lang = await getUserLang(chatId);
  const { data: settings } = await supabase.from('user_settings').select('timezone').eq('telegram_id', chatId).single();
  let recipientTimezone = settings?.timezone || 'Africa/Addis_Ababa';
  if (!recipientTimezone || recipientTimezone === 'UTC') recipientTimezone = 'Africa/Addis_Ababa';
  
  const link = `${APP_URL}?start=session_${sessionInfo.session_id}`;
  const timeStr = formatUserDateTime(sessionInfo.scheduled_at, recipientTimezone);
  // Build plain-text invite to avoid Markdown issues with URLs and user-supplied titles
  const text = lang === 'am'
    ? `🙏 አዲስ ስብሰባ ታቅዷል!\n\nአስተናጋጅ: ${sessionInfo.host}\nርዕስ: ${sessionInfo.title}\nሰዓት: ${timeStr}\n\nለመቀላቀል: ${link}`
    : `🙏 New Session Scheduled!\n\nHost: ${sessionInfo.host}\nTitle: ${sessionInfo.title}\nTime: ${timeStr}\n\nJoin here: ${link}`;
  await bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{
        text: tSync(lang, 'btn_join_session'),
        web_app: { url: `${APP_URL}?start=session_${sessionInfo.session_id}` }
      }]]
    }
  });
}

async function notifyMentorshipRequest(mentorId, requesterName) {
  const lang = await getUserLang(mentorId);
  const text = lang === 'am'
    ? `🙏 አዲስ የምክር ጥያቄ!\n\nከ: *${mdEscape(requesterName)}*\n\nጥያቄውን ለመቀበል/ለመገምገም እባክዎን አፑን ይክፈቱ።`
    : `🙏 *New Mentorship Request!*\n\nFrom: *${mdEscape(requesterName)}*\n\nPlease open the app to view and respond to this request.`;

  await safeSend(mentorId, text, {
    reply_markup: {
      inline_keyboard: [[{
        text: lang === 'am' ? '📂 ማመልከቻዎችን ይመልከቱ' : '📂 View Requests',
        web_app: { url: APP_URL }
      }]]
    }
  });
}

async function notifyMentorshipAccepted(userId, mentorName) {
  const lang = await getUserLang(userId);
  const text = lang === 'am'
    ? `🎉 እንኳን ደስ አለዎት! ከአማካሪዎ *${mdEscape(mentorName)}* ጋር የነበረዎት የምክር ጥያቄ ተቀባይነት አግኝቷል!`
    : `🎉 *Congratulations!* Your mentorship request to *${mdEscape(mentorName)}* was accepted!`;

  await safeSend(userId, text, {
    reply_markup: {
      inline_keyboard: [[{
        text: lang === 'am' ? '💬 አሁን ያውሩ' : '💬 Chat Now',
        web_app: { url: APP_URL }
      }]]
    }
  });
}

async function notifyMentorshipRejected(userId, mentorName) {
  const lang = await getUserLang(userId);
  const text = lang === 'am'
    ? `📋 *የጥያቄ ምላሽ*\n\nከአማካሪ *${mdEscape(mentorName)}* ጋር የነበረዎት ጥያቄ ተቀባይነት አላገኘም። እባክዎን ሌላ አማካሪ ይሞክሩ።`
    : `📋 *Request Status Update*\n\nYour mentorship request to *${mdEscape(mentorName)}* was not accepted at this time. Please try another mentor.`;

  await safeSend(userId, text);
}


// ─── Message Handler ──────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = getState(chatId);
  const lang = await getUserLang(chatId);
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
        
        if (args.length > 1 && args[1].startsWith('session_')) {
          const sessionId = args[1].replace('session_', '');
          if (!user) {
            // New user trying to join a session - prompt registration via Mini App
            const lang = await getUserLang(chatId);
            return safeSend(chatId, 'Welcome to Holy Counseling Bot – a dedicated space for mentorship and guidance. Please register using the Holy app.', {
              reply_markup: {
                inline_keyboard: [[{
                  text: 'Register',
                  web_app: { url: `${APP_URL}?start=register` }
                }]]
              }
            });
          } else {
            // Registered user joining a session - send join button
            const lang = await getUserLang(chatId);
            return safeSend(chatId, tSync(lang, 'session_invite'), {
              reply_markup: {
                inline_keyboard: [[{
                  text: tSync(lang, 'btn_join_session'),
                  web_app: { url: `${APP_URL}?start=session_${sessionId}` }
                }]]
              }
            });
          }
        }

        if (!user) {
          const lang = await getUserLang(chatId);
          return safeSend(chatId, 'Please register via the web app to continue.', {
            reply_markup: {
              inline_keyboard: [[{
                text: 'Register',
                web_app: { url: `${APP_URL}?start=register` }
              }]]
            }
          });
        }
        return showMainMenu(chatId, await t(chatId, 'welcome_back', { nick: mdEscape(user.anonymous_id) }));
      }
      if (command === '/menu') return showMainMenu(chatId);
              if (command === '/apply') {
          // Ensure the user is registered via Mini App
          const { data: userRecord } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();
          if (!userRecord) {
            const lang = await getUserLang(chatId);
            return safeSend(chatId, 'Please register via the web app to apply.', {
              reply_markup: {
                inline_keyboard: [[{
                  text: 'Register',
                  web_app: { url: `${APP_URL}?start=register` }
                }]]
              }
            });
          }

          // User exists, check role
          const { data: userRole } = await supabase.from('users').select('role').eq('telegram_id', chatId).single();
          if (userRole?.role === 'mentor' || userRole?.role === 'admin')
            return safeSend(chatId, await t(chatId, 'already_mentor'));
          const { data: ex } = await supabase.from('mentor_applications').select('id')
            .eq('telegram_id', chatId).eq('status', 'pending').single();
          if (ex) return safeSend(chatId, await t(chatId, 'application_pending'));
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
          const nick = input.replace('@', '');
          const { data: u } = await supabase.from('users').select('telegram_id').eq('anonymous_id', nick).single();
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
  const textMatches = (key) => text === tSync(lang, key);

  if (textMatches('btn_find_mentor')) {
    const { data: ut } = await supabase.from('user_topics').select('topic_id, topics(name)').eq('telegram_id', chatId);
    if (!ut?.length) return safeSend(chatId, tSync(lang, 'no_topics_set'));
    const buttons = ut.map(t => [{ text: t.topics.name, callback_data: `search_topic_${t.topic_id}` }]);
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
      .select('user_id, topics(name)').eq('mentor_id', chatId).eq('is_active', true);

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

    let textStr = `👥 *${tSync(lang, 'my_mentees_title')}*\n\n`;
    const buttons = [];
    for (const m of mentees) {
      const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', m.user_id).single();
      textStr += `👤 @${mdEscape(u?.anonymous_id || String(m.user_id))} (${mdEscape(m.topics?.name || '?')})\n`;
      buttons.push([
        { text: lang === 'am' ? '💬 አውራ' : '💬 Chat', callback_data: `focus_chat_${m.user_id}` },
        { text: `❌ ${tSync(lang, 'btn_end')} @${u?.anonymous_id || m.user_id}`, callback_data: `end_mentorship_${m.user_id}` }
      ]);
    }
    return safeSend(chatId, textStr, { reply_markup: { inline_keyboard: buttons } });
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
        const adminIds = process.env.ADMIN_TELEGRAM_ID || process.env.ADMIN_CHAT_ID;
        if (adminIds) {
          const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', chatId).single();
          const adminMsg = `🆕 *New Mentor Application*\n\nUser: *${mdEscape(u?.anonymous_id || String(chatId))}*\n\n*Sex:* ${mdEscape(state.tempData.sex)}\n*Education:* ${mdEscape(state.tempData.educational_background)}\n*About:* ${mdEscape(about)}`;
          for (const id of adminIds.split(',')) {
            if (id.trim()) await safeSend(id.trim(), adminMsg, {
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Approve', callback_data: `admin_approve_${chatId}` },
                  { text: '❌ Reject', callback_data: `admin_reject_${chatId}` }
                ]]
              }
            });
          }
        }
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
      const { error } = await supabase.from('mentorship_requests').insert({ user_id: chatId, mentor_id: mentorId, topic_id: topicId, message: msgStr });
      if (error) await safeSend(chatId, await t(chatId, 'request_failed'));
      else {
        const [{ data: u }, { data: topic }] = await Promise.all([
          supabase.from('users').select('anonymous_id').eq('telegram_id', chatId).single(),
          supabase.from('topics').select('name').eq('id', topicId).single()
        ]);
        const mentorLang = await getUserLang(mentorId);
        await safeSend(mentorId, tSync(mentorLang, 'new_mentorship_request', {
          nick: mdEscape(u.anonymous_id), topic: mdEscape(topic.name), message: mdEscape(msgStr || tSync(mentorLang, 'none'))
        }), {
          reply_markup: {
            inline_keyboard: [[
              { text: tSync(mentorLang, 'btn_accept'), callback_data: `mentor_accept_${chatId}_${topicId}` },
              { text: tSync(mentorLang, 'btn_reject'), callback_data: `mentor_reject_${chatId}` }
            ]]
          }
        });
        await safeSend(chatId, await t(chatId, 'request_sent'));
      }
      clearState(chatId); return showMainMenu(chatId);
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
    const partnersInfo = await getActiveChatPartners(chatId);
    if (!partnersInfo) {
      const lang = await getUserLang(chatId);
      return safeSend(chatId, tSync(lang, 'no_active_mentor'), {
        reply_markup: { inline_keyboard: [[{ text: tSync(lang, 'btn_find_mentor'), callback_data: 'menu_mentors' }]] }
      });
    }

    let targetId = null;
    if (partnersInfo.partners.length === 1) {
      targetId = partnersInfo.partners[0];
    } else {
      if (state?.step === 'chat_active' && state.targetId) {
        targetId = state.targetId;
      } else {
        const lang = await getUserLang(chatId);
        const { data: mentees } = await supabase.from('users').select('telegram_id, anonymous_id').in('telegram_id', partnersInfo.partners);
        let listStr = tSync(lang, 'multiple_partners') + '\n\n';
        mentees.forEach((m, i) => listStr += `${i + 1}. @${m.anonymous_id}\n`);
        listStr += `\n${tSync(lang, 'use_reply_cmd')}`;
        return safeSend(chatId, listStr);
      }
    }

    if (targetId) await forwardMessage(chatId, targetId, text.trim());
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
      education_level: state.tempData.education_level, role: 'user', max_mentees: DEFAULT_MAX_MENTEES
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
      await bot.sendMessage(chatId, tSync(selectedLang, 'session_invite'), {
        reply_markup: {
          inline_keyboard: [[{
            text: tSync(selectedLang, 'btn_join_session'),
            web_app: { url: `${APP_URL}?start=session_${sessionId}` }
          }]]
        }
      });
    }
  }

  // Mentor Search & Sort
  else if (data === 'menu_mentors') {
    const { data: ut } = await supabase.from('user_topics').select('topic_id, topics(name)').eq('telegram_id', chatId);
    if (!ut?.length) return safeSend(chatId, tSync(lang, 'no_topics_set'));
    const buttons = ut.map(t => [{ text: t.topics.name, callback_data: `search_topic_${t.topic_id}` }]);
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
    const parts = data.split('_'); // mentor_req_{id}_{topicId}
    setState(chatId, 'mentor_req_msg', null, { mentorId: parts[2], topicId: parts[3] });
    await safeSend(chatId, tSync(lang, 'mentor_req_msg_prompt'));
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
    await safeSend(chatId, tSync(newLang, 'language_updated'));
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
          return bot.answerCallbackQuery(query.id, { text: '⚠️ Repaired. Please tap Schedule again.', show_alert: true });
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
      .select('user_id, topics(name)').eq('mentor_id', chatId).eq('is_active', true);

    if (error) { console.error('[My Mentees] Error:', error); return bot.answerCallbackQuery(query.id, { text: 'Error loading mentees.' }); }

    if (!mentees?.length) {
      const { data: swapped } = await supabase.from('mentorship_assignments').select('id, mentor_id').eq('user_id', chatId).eq('is_active', true);
      if (swapped?.length) {
        await supabase.from('mentorship_assignments').update({ mentor_id: chatId, user_id: swapped[0].mentor_id }).eq('id', swapped[0].id);
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Repaired. Please try again.', show_alert: true });
      }
      return bot.answerCallbackQuery(query.id, { text: tSync(lang, 'no_mentees'), show_alert: true });
    }

    let textStr = `👥 *${tSync(lang, 'my_mentees_title')}*\n\n`;
    const buttons = [];
    for (const m of mentees) {
      const { data: u } = await supabase.from('users').select('anonymous_id').eq('telegram_id', m.user_id).single();
      textStr += `👤 @${mdEscape(u?.anonymous_id || String(m.user_id))} (${mdEscape(m.topics?.name || '?')})\n`;
      buttons.push([
        { text: lang === 'am' ? '💬 አውራ' : '💬 Chat', callback_data: `focus_chat_${m.user_id}` },
        { text: `❌ ${tSync(lang, 'btn_end')} @${u?.anonymous_id || m.user_id}`, callback_data: `end_mentorship_${m.user_id}` }
      ]);
    }
    await safeSend(chatId, textStr, { reply_markup: { inline_keyboard: buttons } });
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
  const { data: vs } = await supabase.from('daily_verses').select('*').eq('is_active', true);
  const v = vs?.[Math.floor(Date.now() / 86400000) % (vs?.length || 1)];

  if (v && opted?.length) {
    for (const u of opted) {
      const lang = u.language || 'en';
      let text = `📖 *${tSync(lang, 'verse_title')}*\n*${mdEscape(v.reference)}*\n\n${mdEscape(v.text)}`;
      if (lang === 'am') {
        const amVerse = await getAmharicVerse(v.text);
        if (amVerse) text += `\n\n🇪🇹 *${tSync('am', 'amharic_translation')}:*\n_${mdEscape(amVerse)}_`;
      }
      await safeSend(u.telegram_id, text);
    }
  }
}, 60 * 1000);

// Background job to reset streaks at midnight Ethiopia time
setInterval(async () => {
  const now = getEthiopiaNow();
  if (now.getHours() !== 0 || now.getMinutes() !== 0) return;

  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  const yestStr = yest.toISOString().split('T')[0];

  const { error } = await supabase.from('bible_streaks')
    .update({ current_streak: 0 })
    .lt('last_read_date', yestStr);

  if (!error) console.log('[Scheduler] Daily streak reset check completed.');
}, 60 * 1000);

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
  notifyMentorApproved,
  notifyMentorRejected,
  broadcastToAll,
  notifySessionInvite,
  notifyMentorshipRequest,
  notifyMentorshipAccepted,
  notifyMentorshipRejected
};