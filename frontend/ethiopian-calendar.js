/* Ethiopian calendar + Ethiopian clock helpers (Amharic).
 *
 * One file, two homes: loaded in the browser as window.EthCal and require()d by
 * the bot (bot.js). No dependencies, no Intl calendar data: Telegram WebViews
 * and slim Node builds don't all ship the "ethiopic" calendar, so the maths is
 * done here and every device agrees.
 *
 * Storage never changes. The database, the API and every scheduler keep using
 * Gregorian ISO dates ("2026-11-06") and 24h "HH:MM" times in Ethiopia local
 * time (EAT, UTC+3). This module only converts for DISPLAY and for picking.
 *
 * Calendar:  13 months. 12 x 30 days, then Pagume (5 days, 6 in a leap year).
 *            Leap year when year % 4 === 3. Year number is "ዓ.ም." (E.C.).
 * Clock:     Ethiopians count hours from sunrise: 6:00 AM is "12:00", 7:00 AM
 *            is "1:00", noon is "6:00", 6:00 PM is "12:00" again, midnight is
 *            "6:00". A period word says which half of the day it is.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EthCal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TZ = 'Africa/Addis_Ababa';

  // Rata Die (day count, 0001-01-01 Gregorian = 1) of 1 Meskerem, year 1 E.C.
  const ETH_EPOCH_RD = 2796;
  const UNIX_EPOCH_RD = 719163; // Rata Die of 1970-01-01

  const MONTHS = {
    am: ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜን'],
    en: ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'],
  };
  // Index = JS getUTCDay() (0 = Sunday)
  const WEEKDAYS = {
    am: ['እሑድ', 'ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'አርብ', 'ቅዳሜ'],
    en: ['Ehud', 'Segno', 'Maksegno', 'Rob', 'Hamus', 'Arb', 'Qidame'],
  };
  const WEEKDAYS_NARROW = { am: ['እ', 'ሰ', 'ማ', 'ረ', 'ሐ', 'አ', 'ቅ'], en: ['E', 'S', 'M', 'R', 'H', 'A', 'Q'] };
  const ERA = { am: 'ዓ.ም', en: 'E.C.' };
  const COMMA = { am: '፣ ', en: ', ' };

  // Day periods on the Ethiopian clock, by standard (24h) hour.
  const PERIODS = {
    am: { morning: 'ጠዋት', noon: 'ቀትር', afternoon: 'ከሰዓት', evening: 'ምሽት', night: 'ሌሊት' },
    en: { morning: 'morning', noon: 'noon', afternoon: 'afternoon', evening: 'evening', night: 'night' },
  };
  const HOUR_WORD = { am: 'ሰዓት', en: "o'clock" };

  const pad = n => String(n).padStart(2, '0');
  const lg = lang => (lang === 'en' ? 'en' : 'am');

  // ── Gregorian ISO <-> Rata Die ───────────────────────────────────────────
  function rdFromISO(iso) {
    const [y, m, d] = String(iso).substring(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 864e5) + UNIX_EPOCH_RD;
  }
  function isoFromRd(rd) {
    return new Date((rd - UNIX_EPOCH_RD) * 864e5).toISOString().substring(0, 10);
  }

  // ── Ethiopian date <-> Rata Die ──────────────────────────────────────────
  const rdFromEth = (y, m, d) => ETH_EPOCH_RD - 1 + 365 * (y - 1) + Math.floor(y / 4) + 30 * (m - 1) + d;

  function ethFromRd(rd) {
    const y = Math.floor((4 * (rd - ETH_EPOCH_RD) + 1463) / 1461);
    const m = Math.floor((rd - rdFromEth(y, 1, 1)) / 30) + 1;
    const d = rd + 1 - rdFromEth(y, m, 1);
    return { y, m, d };
  }

  const isLeap = y => y % 4 === 3;
  const daysInMonth = (y, m) => (m < 13 ? 30 : isLeap(y) ? 6 : 5);
  const isValid = (y, m, d) => Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)
    && m >= 1 && m <= 13 && d >= 1 && d <= daysInMonth(y, m);

  /** Gregorian 'YYYY-MM-DD' -> { y, m, d, wd }  (wd: 0 = Sunday) */
  function fromISO(iso) {
    const rd = rdFromISO(iso);
    return { ...ethFromRd(rd), wd: ((rd % 7) + 7) % 7 };
  }
  /** Ethiopian y/m/d -> Gregorian 'YYYY-MM-DD' */
  function toISO(y, m, d) {
    return isoFromRd(rdFromEth(y, m, d));
  }

  // ── "What day is it for this person" ─────────────────────────────────────
  /** Gregorian 'YYYY-MM-DD' of an instant, as seen in a time zone (default Ethiopia). */
  function isoInTz(when, tz) {
    return new Date(when || Date.now()).toLocaleDateString('en-CA', { timeZone: tz || TZ });
  }
  /** 'HH:MM' (24h) of an instant in a time zone (default Ethiopia). */
  function hmInTz(when, tz) {
    return new Date(when || Date.now()).toLocaleTimeString('en-GB', { timeZone: tz || TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  }

  // ── Date formatting ──────────────────────────────────────────────────────
  /**
   * format('2026-11-06', { weekday:'long', month:'long', day:'numeric', year:'numeric' }, 'am')
   *   -> "አርብ፣ ጥቅምት 26 2019 ዓ.ም"
   * Options follow Intl: weekday 'long'|'short'|'narrow', month 'long'|'short'|'numeric',
   * day 'numeric', year 'numeric'. 'short' month = same name (Amharic month names are short).
   */
  function format(iso, o, lang) {
    o = o || {};
    const L = lg(lang), e = fromISO(iso);
    const wd = o.weekday
      ? (o.weekday === 'narrow' ? WEEKDAYS_NARROW[L][e.wd] : WEEKDAYS[L][e.wd])
      : '';
    const month = o.month ? (o.month === 'numeric' || o.month === '2-digit' ? String(e.m) : MONTHS[L][e.m - 1]) : '';
    const day = o.day ? String(e.d) : '';
    const year = o.year ? `${e.y} ${ERA[L]}` : '';
    const md = [month, day].filter(Boolean).join(' ');
    const core = [md, year].filter(Boolean).join(md && year ? ' ' : '');
    return wd && core ? wd + COMMA[L] + core : wd || core;
  }

  const monthName = (m, lang) => MONTHS[lg(lang)][m - 1];
  const weekdayName = (wd, lang, narrow) => (narrow ? WEEKDAYS_NARROW : WEEKDAYS)[lg(lang)][wd];

  // ── Month keys for calendar grids ('YYYY-MM' in Ethiopian numbers) ───────
  const monthKey = iso => { const e = fromISO(iso); return `${e.y}-${pad(e.m)}`; };
  const parseKey = key => { const [y, m] = String(key).split('-').map(Number); return { y, m }; };
  /** Gregorian ISO of the 1st of an Ethiopian month key */
  const monthFirstISO = key => { const { y, m } = parseKey(key); return toISO(y, m, 1); };
  const monthLabel = (key, lang) => { const { y, m } = parseKey(key); const L = lg(lang); return `${MONTHS[L][m - 1]} ${y} ${ERA[L]}`; };
  /** Next / previous month key (Pagume is month 13). */
  function shiftKey(key, delta) {
    let { y, m } = parseKey(key);
    m += delta;
    while (m > 13) { m -= 13; y++; }
    while (m < 1) { m += 13; y--; }
    return `${y}-${pad(m)}`;
  }

  // ── Ethiopian clock ──────────────────────────────────────────────────────
  /** 24h hour (0-23) -> { hour: 1..12, period } on the Ethiopian clock. */
  function ethClock(h24) {
    const hour = ((h24 - 6 + 24) % 12) || 12;
    const period = h24 >= 6 && h24 < 12 ? 'morning' : h24 === 12 ? 'noon' : h24 > 12 && h24 < 18 ? 'afternoon' : h24 >= 18 ? 'evening' : 'night';
    return { hour, period };
  }
  const parseHM = hm => { const [h, m] = String(hm).substring(0, 5).split(':').map(Number); return { h, m }; };

  /**
   * 'HH:MM' (24h, Ethiopia local) -> display text.
   *   fmtHM('09:00','am')  -> "ጠዋት 3 ሰዓት"      fmtHM('15:30','am') -> "ከሰዓት 9:30"
   *   fmtHM('09:00','en')  -> "9:00 AM"
   * Pass { standard:true } to get the international 12h clock in Amharic too, or
 * { bare:true } for the clock part only ("3 ሰዓት") when a period label sits next to it.
   */
  function fmtHM(hm, lang, opts) {
    if (!/^\d{1,2}:\d{2}/.test(String(hm || ''))) return '';
    const { h, m } = parseHM(hm);
    if (lg(lang) === 'en' || (opts && opts.standard)) {
      const h12 = h % 12 || 12;
      return `${h12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
    }
    const c = ethClock(h);
    const clock = m === 0 ? `${c.hour} ${HOUR_WORD.am}` : `${c.hour}:${pad(m)}`;
    return opts && opts.bare ? clock : `${PERIODS.am[c.period]} ${clock}`;
  }

  const PERIOD_WORDS = { 'ጠዋት': 'morning', 'ጥዋት': 'morning', 'ቀትር': 'noon', 'ከሰዓት': 'afternoon', 'ምሽት': 'evening', 'ማታ': 'evening', 'ሌሊት': 'night' };
  const PW = Object.keys(PERIOD_WORDS).join('|');
  const ETH_TIME_RE = new RegExp(`^(?:(${PW})\\s*)?(\\d{1,2})(?::([0-5]\\d))?(?:\\s*(${PW}))?$`);

  /**
   * Typed Ethiopian time -> 'HH:MM' (24h), or null when it isn't one.
   *   "ጠዋት 3:00" / "3 ሰዓት ጠዋት" -> "09:00"   "ከሰዓት 8:30" -> "14:30"
   *   "ማታ 3 ሰዓት" -> "21:00"        "ሌሊት 7:30" -> "01:30"      "ቀትር 6" -> "12:00"
   * The period word is required (the same hour exists twice a day), and it must fit the hour.
   */
  function parseEthTime(text) {
    // Drop the hour word, but only right after a number: ከሰዓት (afternoon) ends in ሰዓት too.
    const t = String(text || '').replace(/(\d)\s*ሰዓት/g, '$1 ').replace(/\s+/g, ' ').trim();
    const m = t.match(ETH_TIME_RE);
    if (!m || (m[1] && m[4]) || !(m[1] || m[4])) return null;
    const e = Number(m[2]), min = m[3] ? Number(m[3]) : 0;
    if (e < 1 || e > 12) return null;
    const dayHour = e === 12 || e <= 5; // 12,1..5 -> first half of its 12h block; 6..11 -> second half
    let h;
    switch (PERIOD_WORDS[m[1] || m[4]]) {
      case 'morning': if (!dayHour) return null; h = (e + 6) % 12; break;
      case 'noon': if (e !== 6) return null; h = 12; break;
      case 'afternoon': if (dayHour) return null; h = e === 6 ? 12 : (e + 6) % 12 + 12; break;
      case 'evening': if (!dayHour) return null; h = (e + 6) % 12 + 12; break;
      default: if (dayHour) return null; h = (e + 6) % 12; // night
    }
    return `${pad(h)}:${pad(min)}`;
  }

  /** Both clocks, for places where confusion is costly: "ጠዋት 3 ሰዓት (9:00 AM)". */
  function fmtHMBoth(hm, lang) {
    if (lg(lang) === 'en') return fmtHM(hm, 'en');
    return `${fmtHM(hm, 'am')} (${fmtHM(hm, 'am', { standard: true })})`;
  }

  /** An instant -> "ጥቅምት 26 2019 ዓ.ም፣ ጠዋት 3 ሰዓት" in the given time zone. */
  function formatInstant(when, lang, tz, o) {
    const iso = isoInTz(when, tz), hm = hmInTz(when, tz);
    return format(iso, o || { month: 'long', day: 'numeric', year: 'numeric' }, lang) + COMMA[lg(lang)] + fmtHM(hm, lang);
  }

  return {
    TZ, MONTHS, WEEKDAYS, WEEKDAYS_NARROW, ERA,
    fromISO, toISO, isValid, isLeap, daysInMonth,
    isoInTz, hmInTz, format, formatInstant, monthName, weekdayName,
    monthKey, monthFirstISO, monthLabel, shiftKey, parseKey,
    ethClock, fmtHM, fmtHMBoth, parseEthTime,
  };
});
