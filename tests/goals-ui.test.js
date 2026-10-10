'use strict';
// Smoke test for frontend/goals.js: renders a challenge in the mentor card and
// the mentee card, selects a day, ticks tasks, and checks the lock rules.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });
const add = (s, n) => new Date(Date.UTC(...s.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 864e5).toISOString().substring(0, 10);
const start = add(TODAY, -3), end = add(TODAY, 4);

function makeGoal() {
  const tasks = [];
  for (let d = start; d <= end; d = add(d, 1)) {
    ['Prayer', 'Journal'].forEach((title, position) => tasks.push({
      id: `t-${d}-${position}`, title, position, due_date: d,
      status: d < TODAY ? (d === add(TODAY, -2) ? 'missed' : 'done') : 'pending',
    }));
  }
  return { id: 'g1', mentee_id: 2, mentor_id: 1, type: 'challenge', title: 'Test challenge', status: 'active',
    start_date: start, end_date: end, tasks, stats: { done: 4, total: 16, pct: 25, streak: 1, missed: 2 } };
}

const dom = new JSDOM('<!doctype html><body><div id="panel"></div><div class="page-content"><div id="goalPageBody"></div></div><div id="card" class="hidden"><span id="myGoalsProgressLabel"></span><div id="myGoalsProgressTrack"></div><div id="list"></div></div></body>',
  { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const calls = [];
w.currentLanguage = 'en';
w.currentUser = { telegram_id: 2 };
w.escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
w.menteeIcon = () => '<i></i>';
w.haptic = () => {};
w.currentPage = 'my-mentees';
w.showAppPageQuiet = p => { w.currentPage = p; };
w.showToast = () => {};
w.apiFetch = async (p, o = {}) => {
  calls.push([o.method || 'GET', p, o.body]);
  if (p.startsWith('/api/goals/mentee/') || p === '/api/goals/mine') return [makeGoal()];
  if (p.startsWith('/api/goals/tasks/')) { const g = makeGoal(); const t = g.tasks.find(x => x.id === p.split('/').pop()); if (t && o.body?.done) t.status = 'done'; return g; }
  return makeGoal();
};
w.eval(fs.readFileSync(path.join(__dirname, '../frontend/goals.js'), 'utf8'));
const doc = w.document;
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
  // mentor card
  const panel = doc.getElementById('panel');
  await w.HolyGoals.mountMentor(panel, 2);
  assert(panel.querySelector('.hg-goal'), 'goal rendered');
  assert.strictEqual(panel.querySelectorAll('.hg-d:not(.x)').length, 8, 'one cell per day');
  assert(panel.querySelector('.hg-d.n'), 'today highlighted');
  assert(panel.querySelector('.hg-d.s'), 'missed day shown');
  assert(panel.querySelector('.hg-d.f'), 'future day shown dimmed');
  assert.strictEqual(panel.querySelectorAll('.hg-day .hg-task').length, 2, 'today has two tasks');

  // select a past day: mentor can still tick it (reopen)
  panel.querySelector(`.hg-d[data-date="${add(TODAY, -2)}"]`).click();
  const missedTask = panel.querySelector('.hg-day .hg-task');
  assert(!missedTask.disabled, 'mentor may reopen a past day');
  // select a future day: locked even for the mentor
  panel.querySelector(`.hg-d[data-date="${add(TODAY, 2)}"]`).click();
  assert(panel.querySelector('.hg-day .hg-task').disabled, 'future day locked');

  // mentor ticks today's task
  panel.querySelector(`.hg-d[data-date="${TODAY}"]`).click();
  panel.querySelector('.hg-day .hg-task').click();
  await tick();
  assert(calls.some(c => c[0] === 'PATCH' && c[1] === `/api/goals/tasks/t-${TODAY}-0` && c[2].done === true), 'PATCH sent');

  // new goal: "New goal" opens a type list page, each type opens its own page
  const page = doc.getElementById('goalPageBody');
  panel.querySelector('[data-act="new"]').click();
  assert.strictEqual(w.currentPage, 'goal-new', 'goal page opens');
  assert.strictEqual(page.querySelectorAll('[data-act="pick"]').length, 3, 'three goal types listed');
  assert(!page.querySelector('.hg-new'), 'no form until a type is picked');
  page.querySelector('[data-type="progressive"]').click();
  assert(page.querySelector('[data-f="target"]'), 'progressive page has its own fields');
  assert(!page.querySelector('[data-f="start"]'), 'progressive page has no challenge fields');
  assert(page.querySelector('.hg-how li'), 'type page explains how it works');
  page.querySelector('[data-f="title"]').value = 'Kept title';
  assert(w.HolyGoals.back(), 'back handled');
  assert(page.querySelector('[data-act="pick"]'), 'back returns to the type list');
  page.querySelector('[data-type="one_time"]').click();
  assert(page.querySelector('[data-f="due"]'), 'one-time page has a due date');
  assert.strictEqual(page.querySelector('[data-f="title"]').value, 'Kept title', 'title survives switching pages');
  w.HolyGoals.back();
  page.querySelector('[data-type="challenge"]').click();
  page.querySelector('[data-act="addtpl"]').click();
  assert.strictEqual(page.querySelectorAll('[data-tpl] input').length, 2, 'extra daily task input');

  // per-day planner: switch to "different each day", plan two days, submit
  page.querySelector('[data-f="title"]').value = 'Lent';
  page.querySelector('[data-act="fmode"][data-mode="custom"]').click();
  assert.strictEqual(page.querySelector('[data-f="title"]').value, 'Lent', 'typed title survives repaint');
  assert(page.querySelector('[data-dayedit]'), 'day editor shown');
  assert.strictEqual(page.querySelectorAll('.hg-plan .hg-d:not(.x)').length, 30, 'one planner cell per day (30-day default)');
  page.querySelector('[data-dayedit] input').value = 'Read Psalm 1';
  page.querySelector(`.hg-plan .hg-d[data-date="${add(TODAY, 1)}"]`).click();
  page.querySelector('[data-dayedit] input').value = 'Fast until noon';
  page.querySelector('[data-act="padd"]').click();
  page.querySelectorAll('[data-dayedit] input')[1].value = 'Evening prayer';
  page.querySelector('[data-act="create"]').click();
  await tick();
  const post = calls.find(c => c[0] === 'POST' && c[1] === '/api/goals');
  assert(post, 'goal POSTed');
  assert.strictEqual(JSON.stringify(post[2].day_plan), JSON.stringify({ [TODAY]: ['Read Psalm 1'], [add(TODAY, 1)]: ['Fast until noon', 'Evening prayer'] }), 'different tasks per day sent');
  assert(!post[2].task_template, 'no repeated template in custom mode');
  assert.strictEqual(w.currentPage, 'my-mentees', 'creating returns to the mentee list');
  // creating with an empty plan is blocked client-side
  panel.querySelector('[data-act="new"]').click();
  page.querySelector('[data-type="challenge"]').click();
  page.querySelector('[data-act="fmode"][data-mode="custom"]').click();
  const before = calls.length;
  page.querySelector('[data-f="title"]').value = 'Empty';
  page.querySelector('[data-act="create"]').click();
  await tick();
  assert.strictEqual(calls.length, before, 'empty plan not submitted');
  page.querySelector('[data-act="back"]').click();
  page.querySelector('[data-act="back"]')?.click();
  w.HolyGoals.back();
  assert.strictEqual(w.currentPage, 'my-mentees', 'back leaves the goal pages');

  // calendar shows one month at a time
  assert(panel.querySelectorAll('.hg-goal .hg-cal:not([hidden])').length === 1, 'single visible month');

  // mentee card: past and future days are locked, today is open and offers a note
  const card = doc.getElementById('card'), list = doc.getElementById('list');
  await w.HolyGoals.mountMentee(card, list);
  assert(!card.classList.contains('hidden'), 'card shown when goals exist');
  assert(!list.querySelector('[data-act="new"]'), 'mentee cannot create goals');
  assert(!list.querySelector('[data-act="edit"]'), 'mentee cannot edit goals');
  list.querySelector(`.hg-d[data-date="${add(TODAY, -1)}"]`).click();
  assert([...list.querySelectorAll('.hg-day .hg-task')].every(b => b.disabled), 'past day closed for mentee');
  list.querySelector(`.hg-d[data-date="${TODAY}"]`).click();
  const open = list.querySelector('.hg-day .hg-task');
  assert(!open.disabled, 'today open for mentee');
  open.click();
  await tick();
  assert(list.querySelector('textarea[data-note]'), 'note box appears after ticking');

  // realtime push replaces the goal
  const g = makeGoal(); g.title = 'Renamed'; g.mentee_id = 2;
  w.HolyGoals.onRealtime(g);
  assert(/Renamed/.test(panel.textContent) || /Renamed/.test(list.textContent), 'realtime update applied');
  console.log('goals UI smoke test passed');
})().catch(e => { console.error(e); process.exit(1); });
