'use strict';
// Ethiopian calendar + clock helpers (frontend/ethiopian-calendar.js).
const assert = require('assert');
const E = require('../frontend/ethiopian-calendar.js');

const eth = iso => { const e = E.fromISO(iso); return `${e.y}-${e.m}-${e.d}`; };

// Known anchors (new year, holidays, Pagume)
assert.strictEqual(eth('2007-09-12'), '2000-1-1');   // Ethiopian Millennium
assert.strictEqual(eth('2023-09-11'), '2015-13-6');  // leap Pagume has 6 days
assert.strictEqual(eth('2023-09-12'), '2016-1-1');
assert.strictEqual(eth('2024-09-11'), '2017-1-1');
assert.strictEqual(eth('2025-09-11'), '2018-1-1');
assert.strictEqual(eth('2026-09-10'), '2018-13-5');
assert.strictEqual(eth('2026-09-11'), '2019-1-1');
assert.strictEqual(eth('2026-01-07'), '2018-4-29'); // Genna (Christmas): Tahsas 29
assert.strictEqual(eth('2026-01-19'), '2018-5-11');  // Timket (Epiphany): Tir 11
assert.strictEqual(eth('2026-03-02'), '2018-6-23');  // Adwa Victory Day: Yekatit 23
assert.strictEqual(eth('2026-11-06'), '2019-2-27');

// Round trip every day 1900-2100, and month lengths
let n = 0;
for (let ms = Date.UTC(1900, 0, 1); ms <= Date.UTC(2100, 11, 31); ms += 864e5) {
  const iso = new Date(ms).toISOString().substring(0, 10);
  const e = E.fromISO(iso);
  assert.ok(E.isValid(e.y, e.m, e.d), `invalid ${iso} -> ${e.y}-${e.m}-${e.d}`);
  assert.strictEqual(E.toISO(e.y, e.m, e.d), iso);
  n++;
}
assert.ok(n > 70000);
assert.strictEqual(E.daysInMonth(2015, 13), 6);
assert.strictEqual(E.daysInMonth(2018, 13), 5);
assert.strictEqual(E.isValid(2018, 13, 6), false);
assert.strictEqual(E.isValid(2018, 14, 1), false);

// Formatting
assert.strictEqual(E.format('2026-11-06', { month: 'long', day: 'numeric' }, 'am'), 'ጥቅምት 27');
assert.strictEqual(E.format('2026-11-06', { month: 'long', year: 'numeric' }, 'am'), 'ጥቅምት 2019 ዓ.ም');
assert.strictEqual(E.format('2026-11-06', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, 'am'), 'አርብ፣ ጥቅምት 27 2019 ዓ.ም');
assert.strictEqual(E.format('2026-09-10', { month: 'short', day: 'numeric' }, 'am'), 'ጳጉሜን 5');
assert.strictEqual(E.format('2026-11-06', { weekday: 'narrow' }, 'am'), 'አ');
assert.strictEqual(E.format('2026-11-06', { month: 'long', day: 'numeric' }, 'en'), 'Tikimt 27');

// Month keys / navigation across Pagume and the new year
assert.strictEqual(E.monthKey('2026-11-06'), '2019-02');
assert.strictEqual(E.monthFirstISO('2019-02'), '2026-10-11');
assert.strictEqual(E.shiftKey('2018-13', 1), '2019-01');
assert.strictEqual(E.shiftKey('2019-01', -1), '2018-13');
assert.strictEqual(E.monthLabel('2019-02', 'am'), 'ጥቅምት 2019 ዓ.ም');

// Ethiopian clock (6:00 AM = 12:00)
const t = hm => E.fmtHM(hm, 'am');
assert.strictEqual(t('06:00'), 'ጠዋት 12 ሰዓት');
assert.strictEqual(t('09:00'), 'ጠዋት 3 ሰዓት');
assert.strictEqual(t('12:00'), 'ቀትር 6 ሰዓት');
assert.strictEqual(t('15:30'), 'ከሰዓት 9:30');
assert.strictEqual(t('18:00'), 'ምሽት 12 ሰዓት');
assert.strictEqual(t('21:00'), 'ምሽት 3 ሰዓት');
assert.strictEqual(t('23:00'), 'ምሽት 5 ሰዓት');
assert.strictEqual(t('00:00'), 'ሌሊት 6 ሰዓት');
assert.strictEqual(t('01:30'), 'ሌሊት 7:30');
assert.strictEqual(t('05:59'), 'ሌሊት 11:59');
assert.strictEqual(E.fmtHM('21:05', 'en'), '9:05 PM');
assert.strictEqual(E.fmtHM('00:00', 'en'), '12:00 AM');
assert.strictEqual(E.fmtHM('09:00', 'am', { standard: true }), '9:00 AM');
assert.strictEqual(E.fmtHMBoth('09:00', 'am'), 'ጠዋት 3 ሰዓት (9:00 AM)');
assert.strictEqual(E.fmtHM('', 'am'), '');
// every minute of the day maps to a distinct, valid label
const seen = new Set();
for (let h = 0; h < 24; h++) for (const m of [0, 30]) seen.add(t(`${String(h).padStart(2, '0')}:${m ? '30' : '00'}`));
assert.strictEqual(seen.size, 48);

// Typed Ethiopian times parse back to 24h, and every formatted half hour round-trips
const pt = E.parseEthTime;
assert.strictEqual(pt('ጠዋት 3:00'), '09:00');
assert.strictEqual(pt('3 ሰዓት ጠዋት'), '09:00');
assert.strictEqual(pt('ከሰዓት 8:30'), '14:30');
assert.strictEqual(pt('ማታ 3 ሰዓት'), '21:00');
assert.strictEqual(pt('ምሽት 5 ሰዓት'), '23:00');
assert.strictEqual(pt('ሌሊት 7:30'), '01:30');
assert.strictEqual(pt('ቀትር 6'), '12:00');
assert.strictEqual(pt('ጠዋት 12 ሰዓት'), '06:00');
assert.strictEqual(pt('ጠዋት 7'), null, 'morning only has 12,1-5');
assert.strictEqual(pt('3:00'), null, 'period word is required');
assert.strictEqual(pt('ጠዋት 13'), null);
assert.strictEqual(pt('ጠዋት 3 ማታ'), null, 'two period words');
assert.strictEqual(pt('02:30 PM'), null, 'international times are not Ethiopian-clock input');
for (let h = 0; h < 24; h++) for (const mm of ['00', '30']) {
  const hm = `${String(h).padStart(2, '0')}:${mm}`;
  assert.strictEqual(pt(E.fmtHM(hm, 'am')), hm, `round trip ${hm}`);
}

// Instants are read in Ethiopia time (UTC+3), not UTC: 22:00Z Nov 6 is already Nov 7 in Addis
assert.strictEqual(E.isoInTz('2026-11-06T22:00:00Z'), '2026-11-07');
assert.strictEqual(E.hmInTz('2026-11-06T22:00:00Z'), '01:00');
assert.strictEqual(E.formatInstant('2026-11-06T06:00:00Z', 'am'), 'ጥቅምት 27 2019 ዓ.ም፣ ጠዋት 3 ሰዓት');

console.log('ethiopian-calendar tests passed');
