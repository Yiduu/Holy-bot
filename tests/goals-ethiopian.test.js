'use strict';
// frontend/goals.js in Amharic: Ethiopian month grid, day numbers, date selects
// that still submit Gregorian ISO dates, and the Ethiopian clock captions.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const E = require('../frontend/ethiopian-calendar.js');

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });
const add = (s, n) => new Date(Date.UTC(...s.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 864e5).toISOString().substring(0, 10);

// 2026-10-08 .. 2026-10-14 = Meskerem 28 .. Tikimt 4, 2019 E.C. (crosses a month boundary)
const start = '2026-10-08', end = '2026-10-14';
function makeGoal() {
  const tasks = [];
  for (let d = start; d <= end; d = add(d, 1)) tasks.push({ id: `t-${d}`, title: 'Prayer', position: 0, due_date: d, status: 'pending', remind_at: d === end ? '09:00' : null });
  return { id: 'g1', mentee_id: 2, mentor_id: 1, type: 'challenge', title: 'Fast', status: 'active', start_date: start, end_date: end,
    reminder_time: '20:00', tasks, stats: { done: 0, total: 7, pct: 0, streak: 0, missed: 0 } };
}

const dom = new JSDOM('<!doctype html><body><div id="panel"></div><div id="goalPageBody"></div><div id="card" class="hidden"><span id="myGoalsProgressLabel"></span><div id="myGoalsProgressTrack"></div><div id="list"></div></div></body>',
  { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const calls = [];
w.currentLanguage = 'am';
w.currentUser = { telegram_id: 1 };
w.currentPage = 'my-mentees';
w.showAppPageQuiet = p => { w.currentPage = p; };
w.escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
w.menteeIcon = () => '<i></i>';
w.haptic = () => {};
w.showToast = () => {};
w.apiFetch = async (p, o = {}) => { calls.push([o.method || 'GET', p, o.body]); return p.startsWith('/api/goals/mentee/') ? [makeGoal()] : makeGoal(); };
w.eval(fs.readFileSync(path.join(__dirname, '../frontend/ethiopian-calendar.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(__dirname, '../frontend/goals.js'), 'utf8'));
const doc = w.document;
const tick = () => new Promise(r => setTimeout(r, 20));
const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
const pick = (box, part, value) => { const s = box.querySelector(`[data-ed-part="${part}"]`); s.value = String(value); fire(s, 'change'); };

(async () => {
  const panel = doc.getElementById('panel');
  await w.HolyGoals.mountMentor(panel, 2);

  // Month grid is Ethiopian: opens on Tikimt (the selected day, Oct 14), with Meskerem before it
  const label = () => panel.querySelector('.hg-month').textContent;
  assert.strictEqual(label(), 'ጥቅምት 2019 ዓ.ም');
  const visible = () => [...panel.querySelectorAll('.hg-cal:not([hidden]) .hg-d:not(.x) span')].map(s => s.textContent);
  assert.deepStrictEqual(visible(), ['1', '2', '3', '4'], 'Oct 11-14 are Tikimt 1-4');
  panel.querySelector('.hg-mnav[aria-label="ያለፈው ወር"]').click();
  assert.strictEqual(label(), 'መስከረም 2019 ዓ.ም');
  assert.deepStrictEqual(visible(), ['28', '29', '30'], 'Oct 8-10 are Meskerem 28-30');
  // the weekday header is Monday-first Amharic
  assert.strictEqual([...panel.querySelectorAll('.hg-cal:not([hidden]) .hg-w')].map(x => x.textContent).join(''), 'ሰማረሐአቅእ');

  // Day title is Ethiopian; stored data-date stays Gregorian
  panel.querySelector(`.hg-d[data-date="${end}"]`)?.click();
  assert(panel.querySelector(`.hg-d[data-date="${end}"]`), 'cells keep Gregorian ISO in data-date');
  assert(/ጥቅምት 4/.test(panel.querySelector('.hg-day-title').textContent), 'day title in Ethiopian calendar');
  assert(!/Oct|2026/.test(panel.querySelector('.hg-goal').textContent), 'no Gregorian month or year left on the card');
  // A goal that is still running: its per-task reminder chip uses the Ethiopian clock (09:00 = ጠዋት 3 ሰዓት)
  w.HolyGoals.onRealtime({ id: 'g2', mentee_id: 2, mentor_id: 1, type: 'challenge', title: 'Run', status: 'active',
    start_date: TODAY, end_date: add(TODAY, 6), reminder_time: '20:00', stats: { done: 0, total: 1, pct: 0, streak: 0, missed: 0 },
    tasks: [{ id: 't-now', title: 'Pray', position: 0, due_date: TODAY, status: 'pending', remind_at: '09:00' }] });
  assert(/ጠዋት 3 ሰዓት/.test(panel.textContent), 'task reminder shown on the Ethiopian clock');

  // New goal form: date fields are Ethiopian selects, no native date input
  panel.querySelector('[data-act="new"]').click();
  const page = doc.getElementById('goalPageBody');
  page.querySelector('[data-type="challenge"]').click();
  assert.strictEqual(page.querySelectorAll('input[type="date"]').length, 0, 'no Gregorian date inputs in Amharic');
  const sBox = page.querySelector('[data-ed="start"]'), eBox = page.querySelector('[data-ed="end"]');
  assert(sBox && eBox);
  assert.strictEqual(sBox.querySelector('[data-ed-part="m"]').options.length, 14, '13 months + placeholder');

  // Reminder caption: default 20:00 -> ምሽት 2 ሰዓት, and it follows the input
  const rem = page.querySelector('[data-f="reminder"]');
  assert.strictEqual(rem.parentElement.querySelector('[data-etime]').textContent, '= ምሽት 2 ሰዓት');
  rem.value = '09:00'; fire(rem, 'input');
  assert.strictEqual(rem.parentElement.querySelector('[data-etime]').textContent, '= ጠዋት 3 ሰዓት');
  assert(/ምሽት 5 ሰዓት/.test(page.querySelector('.hg-last').textContent), 'last reminder (23:00) shown on the Ethiopian clock');

  // Picking Ethiopian y/m/d fills the hidden field with the Gregorian ISO date
  const e1 = E.fromISO(add(TODAY, 1));
  pick(page.querySelector('[data-ed="start"]'), 'y', e1.y);
  pick(page.querySelector('[data-ed="start"]'), 'm', e1.m);
  pick(page.querySelector('[data-ed="start"]'), 'd', e1.d);
  assert.strictEqual(page.querySelector('[data-f="start"]').value, add(TODAY, 1), 'start is Gregorian ISO');
  // duration chip fills the end from the start (seen through the end selects)
  page.querySelector('[data-act="dur"][data-n="7"]').click();
  assert.strictEqual(page.querySelector('[data-f="end"]').value, add(TODAY, 7));
  const eEnd = E.fromISO(add(TODAY, 7));
  const endBox = page.querySelector('[data-ed="end"]');
  assert.strictEqual(+endBox.querySelector('[data-ed-part="d"]').value, eEnd.d, 'end selects show the Ethiopian day');
  assert.strictEqual(+endBox.querySelector('[data-ed-part="m"]').value, eEnd.m);

  // Pagume has 6 days in a leap year and 5 otherwise. The day list follows the month,
  // and moving from Pagume 6 of a leap year to the next (normal) year clamps to Pagume 5.
  const endSel = () => page.querySelector('[data-ed="end"]');
  const years = [...endSel().querySelectorAll('[data-ed-part="y"] option')].map(o => +o.value).filter(Boolean);
  const leapY = years.find(y => E.isLeap(y) && years.includes(y + 1));
  pick(endSel(), 'y', leapY); pick(endSel(), 'm', 13);
  assert.strictEqual(endSel().querySelector('[data-ed-part="d"]').options.length, 1 + 6, 'leap Pagume offers 6 days');
  pick(endSel(), 'd', 6);
  assert.strictEqual(page.querySelector('[data-f="end"]').value, E.toISO(leapY, 13, 6));
  pick(endSel(), 'y', leapY + 1);
  assert.strictEqual(page.querySelector('[data-f="end"]').value, E.toISO(leapY + 1, 13, 5), 'Pagume 6 clamps to Pagume 5 in a normal year');
  assert.strictEqual(endSel().querySelector('[data-ed-part="d"]').options.length, 1 + 5, 'normal Pagume offers 5 days');
  // and an end date is never earlier than the start (the picker's min)
  pick(endSel(), 'y', years[0]); pick(endSel(), 'm', 1); pick(endSel(), 'd', 1);
  assert(page.querySelector('[data-f="end"]').value >= page.querySelector('[data-f="start"]').value, 'end is not before start');

  // Submit: the server still receives Gregorian ISO dates and 24h HH:MM
  page.querySelector('[data-act="dur"][data-n="7"]').click();
  page.querySelector('[data-f="title"]').value = 'Lent';
  page.querySelector('[data-tpl] input').value = 'Pray';
  page.querySelector('[data-act="create"]').click();
  await tick();
  const post = calls.find(c => c[0] === 'POST' && c[1] === '/api/goals');
  assert(post, 'goal POSTed');
  assert.strictEqual(post[2].start_date, add(TODAY, 1));
  assert.strictEqual(post[2].end_date, add(TODAY, 7));
  assert.strictEqual(post[2].reminder_time, '09:00');

  // Reminder sheet: presets show the Ethiopian clock, custom time has a caption
  page.querySelector('[data-act="back"]')?.click();
  panel.querySelector('[data-act="rsheet"]')?.click();
  const sheet = doc.querySelector('.hg-rs');
  assert(sheet, 'reminder sheet opens');
  assert(/12 ሰዓት/.test(sheet.querySelector('.hg-rs-presets').textContent), '06:00 preset reads 12 ሰዓት');
  assert(sheet.querySelector('[data-etime]'), 'caption under the custom time');

  console.log('goals Ethiopian calendar UI test passed');
})().catch(e => { console.error(e); process.exit(1); });
