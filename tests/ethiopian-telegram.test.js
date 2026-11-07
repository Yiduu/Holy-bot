'use strict';
// utils/ethiopianTelegram.js: labels, typed-time parsing and the Ethiopian
// month keyboard used by the bot for Amharic users.
const assert = require('assert');
const T = require('../utils/ethiopianTelegram');
const E = require('../frontend/ethiopian-calendar.js');

// Labels
assert.strictEqual(T.dayLabel('2026-11-06', 'am'), 'ጥቅምት 27');
assert.strictEqual(T.dayLabel('2026-11-06', 'en'), 'Nov 6');
assert.strictEqual(T.dayLabel('2026-11-06T00:00:00Z', 'en', T.LONG_DATE), 'Friday, November 6, 2026');
assert.strictEqual(T.dayLabel('2026-11-06', 'am', T.LONG_DATE), 'አርብ፣ ጥቅምት 27 2019 ዓ.ም');
assert.strictEqual(T.clockLabel('09:00:00', 'am'), 'ጠዋት 3 ሰዓት');
assert.strictEqual(T.clockLabel('09:00', 'en'), '9:00 AM');

// Typed session times: slot buttons / English 12h, and the Ethiopian clock
assert.strictEqual(T.parseSessionTime('09:00 AM'), '09:00');
assert.strictEqual(T.parseSessionTime('12:00 AM'), '00:00');
assert.strictEqual(T.parseSessionTime('12:30 pm'), '12:30');
assert.strictEqual(T.parseSessionTime('02:30 PM'), '14:30');
assert.strictEqual(T.parseSessionTime('ከሰዓት 8:30'), '14:30');
assert.strictEqual(T.parseSessionTime('ጠዋት 3 ሰዓት'), '09:00');
assert.strictEqual(T.parseSessionTime('25:00 PM'), null);
assert.strictEqual(T.parseSessionTime('tomorrow'), null);
assert.strictEqual(T.parseSessionTime('3:00'), null);

// Slot buttons: Ethiopian clock label for Amharic, callback data is untouched by the label
for (const [slot, am] of [['09:00 AM', 'ጠዋት 3 ሰዓት'], ['12:00 PM', 'ቀትር 6 ሰዓት'], ['03:00 PM', 'ከሰዓት 9 ሰዓት'], ['06:00 PM', 'ምሽት 12 ሰዓት'], ['09:00 PM', 'ምሽት 3 ሰዓት']]) {
  assert.strictEqual(T.slotLabel(slot, 'am'), am);
  assert.strictEqual(T.slotLabel(slot, 'en'), slot);
}

// Keyboard: header, Monday-first weekdays, every day maps to a distinct Gregorian ISO date
function check(key) {
  const kb = T.ethCalendarKeyboard(key, 'ተመለስ').inline_keyboard;
  const { y, m } = E.parseKey(key);
  assert.strictEqual(kb[0][1].text, E.monthLabel(key, 'am'));
  assert.strictEqual(kb[1].map(b => b.text).join(''), 'ሰማረሐአቅእ');
  assert.strictEqual(kb[kb.length - 1][0].callback_data, 'menu_schedule');
  const days = kb.slice(2, -1);
  days.forEach(r => assert.strictEqual(r.length, 7, 'every grid row has 7 cells'));
  const picks = days.flat().filter(b => b.callback_data.startsWith('cal_select_'));
  assert.strictEqual(picks.length, E.daysInMonth(y, m));
  picks.forEach((b, i) => {
    assert.strictEqual(b.text, String(i + 1));
    assert.strictEqual(b.callback_data, `cal_select_${E.toISO(y, m, i + 1)}`);
  });
  // the 1st sits under its weekday (Monday-first column)
  const first = days.flat().findIndex(b => b.text === '1');
  assert.strictEqual(first % 7, (E.fromISO(E.toISO(y, m, 1)).wd + 6) % 7);
  // Telegram limit: callback_data <= 64 bytes
  kb.flat().forEach(b => assert.ok(Buffer.byteLength(b.callback_data) <= 64));
  return kb;
}
for (const key of ['2019-01', '2019-02', '2019-12', '2018-13', '2019-13', '2015-13', '2020-13']) check(key);
assert.strictEqual(check('2018-13').slice(2, -1).flat().filter(b => b.callback_data.startsWith('cal_select_')).length, 5, 'Pagume 2018: 5 days');
assert.strictEqual(check('2019-13').slice(2, -1).flat().filter(b => b.callback_data.startsWith('cal_select_')).length, 6, 'Pagume 2019 (leap): 6 days');
// navigation wraps across Pagume into the new year and back
const nav = key => T.ethCalendarKeyboard(key, 'x').inline_keyboard[0];
assert.strictEqual(nav('2018-13')[2].callback_data, 'ecal_nav_2019-01');
assert.strictEqual(nav('2019-01')[0].callback_data, 'ecal_nav_2018-13');

console.log('ethiopian-telegram tests passed');
