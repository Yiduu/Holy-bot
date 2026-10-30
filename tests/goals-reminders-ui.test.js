'use strict';
// Per-task reminders in the goal planner (frontend/goals.js): time chips, the
// reminder sheet, copy-with-reminders, and what is sent to the API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });
const add = (s, n) => new Date(Date.UTC(...s.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 864e5).toISOString().substring(0, 10);

const dom = new JSDOM('<!doctype html><body><div id="panel"></div><div id="goalPageBody"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const calls = [];
const state = { goals: [] };
w.currentLanguage = 'en';
w.currentUser = { telegram_id: 1 };
w.currentPage = 'my-mentees';
w.showAppPageQuiet = p => { w.currentPage = p; };
w.escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
w.menteeIcon = () => '<i></i>';
w.haptic = () => {};
w.showToast = () => {};
w.apiFetch = async (p, o = {}) => {
  calls.push([o.method || 'GET', p, o.body]);
  if (p.startsWith('/api/goals/mentee/')) return state.goals;
  return { id: 'g1', mentee_id: 2, mentor_id: 1, type: 'challenge', title: 'x', status: 'active', start_date: TODAY, end_date: TODAY, tasks: [], stats: {} };
};
w.eval(fs.readFileSync(path.join(__dirname, '../frontend/goals.js'), 'utf8'));
const doc = w.document;
// Payloads are built inside jsdom's realm, so compare as JSON, not by prototype.
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const tick = () => new Promise(r => setTimeout(r, 20));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const sheet = () => doc.querySelector('.hg-rs');
const chips = () => [...doc.querySelectorAll('#goalPageBody .hg-pt .hg-rchip')];

(async () => {
  await w.HolyGoals.mountMentor(doc.getElementById('panel'), 2);
  click(doc.querySelector('#panel [data-act="new"]'));
  const page = doc.getElementById('goalPageBody');
  click(page.querySelector('[data-type="challenge"]'));
  page.querySelector('[data-f="title"]').value = 'Lent';
  page.querySelector('[data-f="title"]').dispatchEvent(new w.Event('input', { bubbles: true }));

  // "same every day": every task row has a "Remind" chip, none set yet
  assert.strictEqual(chips().length, 1, 'one chip per task row');
  assert(!chips()[0].classList.contains('on'), 'no reminder set yet');
  assert(page.textContent.includes('11:00 PM'), 'last reminder at 11:00 PM is shown');

  // open the sheet, pick the Morning preset, then save
  click(chips()[0]);
  assert(sheet(), 'sheet opens');
  assert(sheet().querySelector('[data-rs="save"]').disabled, 'Save waits for a time');
  assert(!sheet().querySelector('[data-rs="off"]'), 'nothing to remove yet');
  click(sheet().querySelector('[data-rs="p"][data-at="06:00"]'));
  assert(sheet().querySelector('[data-rs="p"][data-at="06:00"]').classList.contains('on'), 'preset highlighted');
  const custom = sheet().querySelector('[data-rs="t"]');
  assert.strictEqual(custom.type, 'time', 'native time input, like the live-session scheduler');
  custom.value = '07:15';
  custom.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert(!sheet().querySelector('[data-rs="p"].on'), 'custom time clears the preset highlight');
  click(sheet().querySelector('[data-rs="save"]'));
  assert(!sheet(), 'sheet closes on save');
  assert(chips()[0].classList.contains('on') && /7:15/.test(chips()[0].textContent), 'chip shows the saved time');

  // typed title survives; add a second task without a reminder; turn one off again
  click(page.querySelector('[data-act="addtpl"]'));
  assert.strictEqual(chips().length, 2);
  page.querySelectorAll('[data-tpl] input')[0].value = 'Prayer';
  page.querySelectorAll('[data-tpl] input')[1].value = 'Journal';
  page.querySelector('[data-tpl] input').dispatchEvent(new w.Event('input', { bubbles: true }));
  click(page.querySelector('[data-act="create"]'));
  await tick();
  const post = calls.find(c => c[0] === 'POST' && c[1] === '/api/goals');
  same(post[2].task_template, [{ title: 'Prayer', remind_at: '07:15' }, 'Journal'], 'reminder travels with its task; no reminder stays a plain string');

  // custom plan: reminder on day 1, copy to the other days with and without reminder times
  click(doc.querySelector('#panel [data-act="new"]'));
  click(page.querySelector('[data-type="challenge"]'));
  page.querySelector('[data-f="title"]').value = 'Plan';
  page.querySelector('[data-f="end"]').value = add(TODAY, 2);
  page.querySelector('[data-f="end"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  click(page.querySelector('[data-act="fmode"][data-mode="custom"]'));
  page.querySelector('[data-dayedit] input').value = 'Scripture';
  page.querySelector('[data-dayedit] input').dispatchEvent(new w.Event('input', { bubbles: true }));
  click(chips()[0]);
  click(sheet().querySelector('[data-rs="p"][data-at="18:00"]'));
  click(sheet().querySelector('[data-rs="save"]'));
  click(page.querySelector('[data-act="pfill"][data-scope="all"]'));
  click(page.querySelector('[data-act="create"]'));
  await tick();
  const plan = calls.filter(c => c[0] === 'POST' && c[1] === '/api/goals').pop()[2].day_plan;
  assert.strictEqual(Object.keys(plan).length, 3, 'copied to all three days');
  for (const day of Object.keys(plan)) same(plan[day], [{ title: 'Scripture', remind_at: '18:00' }], day);

  // copy box: hidden until the day has a task, no checkbox, nothing to explain
  click(doc.querySelector('#panel [data-act="new"]'));
  click(page.querySelector('[data-type="challenge"]'));
  page.querySelector('[data-f="title"]').value = 'Plan 3';
  page.querySelector('[data-f="end"]').value = add(TODAY, 1);
  page.querySelector('[data-f="end"]').dispatchEvent(new w.Event('change', { bubbles: true }));
  click(page.querySelector('[data-act="fmode"][data-mode="custom"]'));
  assert(!page.querySelector('.hg-copy'), 'no copy box on an empty day');
  assert(!page.textContent.includes('then you can copy it'), 'no "add a task first" hint');
  assert(!page.querySelector('.hg-copy-rem, [data-act="pcopyrem"]'), 'no "include reminder times" checkbox');
  page.querySelector('[data-dayedit] input').value = 'Walk';
  page.querySelector('[data-dayedit] input').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert(page.querySelector('.hg-copy'), 'copy box appears once the day has a task');
  page.querySelector('[data-dayedit] input').value = '';
  page.querySelector('[data-dayedit] input').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert(!page.querySelector('.hg-copy'), 'and goes away again when the task is cleared');
  page.querySelector('[data-dayedit] input').value = 'Walk';
  page.querySelector('[data-dayedit] input').dispatchEvent(new w.Event('input', { bubbles: true }));
  click(chips()[0]); click(sheet().querySelector('[data-rs="p"][data-at="06:00"]')); click(sheet().querySelector('[data-rs="save"]'));
  click(page.querySelector('[data-act="pfill"][data-scope="all"]'));
  click(page.querySelector('[data-act="create"]'));
  await tick();
  const plan2 = calls.filter(c => c[0] === 'POST' && c[1] === '/api/goals').pop()[2].day_plan;
  for (const day of Object.keys(plan2)) same(plan2[day], [{ title: 'Walk', remind_at: '06:00' }], 'reminder copied with its task on ' + day);

  // sheet closes with Escape
  click(chips()[0]);
  assert(sheet(), 'reopens');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert(!sheet(), 'Escape closes the sheet');

  // an existing challenge: the mentor can set / clear a reminder on an upcoming task
  state.goals = [{ id: 'g9', mentee_id: 3, mentor_id: 1, type: 'challenge', title: 'Live', status: 'active', start_date: TODAY, end_date: add(TODAY, 2), stats: {},
    tasks: [{ id: 't1', title: 'Pray', due_date: TODAY, status: 'pending', remind_at: '06:00:00' }, { id: 't2', title: 'Read', due_date: TODAY, status: 'done' }] }];
  const p2 = doc.createElement('div'); doc.body.appendChild(p2);
  await w.HolyGoals.mountMentor(p2, 3);
  const rc = p2.querySelectorAll('.hg-rrow .hg-rchip');
  assert.strictEqual(rc.length, 1, 'chip only on the pending task, not the done one');
  assert(/6:00/.test(rc[0].textContent), 'DB time (06:00:00) shown as 6:00');
  click(rc[0]);
  click(sheet().querySelector('[data-rs="off"]'));           // Remove
  await tick();
  const patch = calls.filter(c => c[0] === 'PATCH' && c[1] === '/api/goals/tasks/t1').pop();
  assert.strictEqual(patch[2].remind_at, '', 'turning it off sends an empty time');

  console.log('goal reminder UI tests passed');
})().catch(e => { console.error(e); process.exit(1); });
