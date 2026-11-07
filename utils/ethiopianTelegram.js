'use strict';

// Ethiopian calendar and clock for the Telegram bot (Amharic users).
//
// Storage never changes: dates stay Gregorian ISO ('2026-11-06') and times stay
// 24h Ethiopia time (EAT). Only the labels, the date-picker keyboard and the
// typed-time parser here differ by language. The maths lives in
// frontend/ethiopian-calendar.js, shared with the Mini App.

const EthCal = require('../frontend/ethiopian-calendar.js');

const LONG_DATE = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };

/** 'YYYY-MM-DD' -> "ጥቅምት 27" (am) or "Nov 6" (en). Pass options for a longer form (LONG_DATE). */
function dayLabel(iso, lang, o = { month: 'short', day: 'numeric' }) {
  const day = String(iso).substring(0, 10);
  if (lang === 'am') return EthCal.format(day, o, 'am');
  try { return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o }); } catch { return day; }
}

/** 'HH:MM' (24h, Ethiopia) -> "ጠዋት 3 ሰዓት" (am) or "9:00 AM" (en). */
function clockLabel(hm, lang) {
  return EthCal.fmtHM(String(hm).substring(0, 5), lang === 'am' ? 'am' : 'en');
}

/**
 * 'HH:MM' (24h) from a 12h "02:30 PM" (the time-slot buttons, English users) or a
 * typed Ethiopian-clock time ("ከሰዓት 8:30", Amharic users). null if it is neither.
 */
function parseSessionTime(text) {
  const m = String(text).trim().match(/^(0?[1-9]|1[0-2]):([0-5][0-9])\s?(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const pm = m[3].toUpperCase() === 'PM';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  return EthCal.parseEthTime(text);
}

/** Label for a time-slot button such as "09:00 AM": the Ethiopian clock for Amharic. */
function slotLabel(slot, lang) {
  if (lang !== 'am') return slot;
  const hm = parseSessionTime(slot);
  return hm ? EthCal.fmtHM(hm, 'am') : slot;
}

/**
 * Inline month grid for an Ethiopian month. `key` is 'YYYY-MM' in Ethiopian numbers.
 * Day buttons carry the Gregorian ISO date (cal_select_<ISO>), so everything after
 * the pick is unchanged; ecal_nav_<key> moves between months (Pagume included).
 */
function ethCalendarKeyboard(key, backText) {
  const { y, m } = EthCal.parseKey(key);
  const rows = [];
  rows.push([
    { text: '◀️', callback_data: `ecal_nav_${EthCal.shiftKey(key, -1)}` },
    { text: EthCal.monthLabel(key, 'am'), callback_data: 'noop' },
    { text: '▶️', callback_data: `ecal_nav_${EthCal.shiftKey(key, 1)}` },
  ]);
  // Monday-first, like the English calendar (ሰ ማ ረ ሐ አ ቅ እ)
  rows.push([1, 2, 3, 4, 5, 6, 0].map(wd => ({ text: EthCal.weekdayName(wd, 'am', true), callback_data: 'noop' })));
  const offset = (EthCal.fromISO(EthCal.toISO(y, m, 1)).wd + 6) % 7;
  let row = Array(offset).fill({ text: ' ', callback_data: 'noop' });
  for (let d = 1; d <= EthCal.daysInMonth(y, m); d++) {
    row.push({ text: String(d), callback_data: `cal_select_${EthCal.toISO(y, m, d)}` });
    if (row.length === 7) { rows.push(row); row = []; }
  }
  if (row.length) {
    while (row.length < 7) row.push({ text: ' ', callback_data: 'noop' });
    rows.push(row);
  }
  rows.push([{ text: backText, callback_data: 'menu_schedule' }]);
  return { inline_keyboard: rows };
}

module.exports = { LONG_DATE, dayLabel, clockLabel, parseSessionTime, slotLabel, ethCalendarKeyboard };
