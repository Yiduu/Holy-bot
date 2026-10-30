'use strict';
// Scheduling rules for per-task reminders and the 11:00 PM last reminder,
// run against a small in-memory stand-in for the Supabase query builder.
const assert = require('assert');
const { makeGoalReminders } = require('../utils/goalReminders');

const TODAY = '2026-11-02';

function fakeDb(tables) {
  const join = (table, row) => (table === 'goal_tasks' ? { ...row, goals: tables.goals.find(g => g.id === row.goal_id) } : { ...row });
  const get = (row, col) => col.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
  const orTest = (row, expr) => expr.split(',').some(part => {
    const [col, op, ...rest] = part.split('.'); const v = rest.join('.');
    const cur = get(row, col);
    return op === 'is' ? (v === 'null' ? cur == null : false) : op === 'neq' ? cur !== v : false;
  });
  return {
    from(table) {
      const filters = []; let update = null, order = null;
      const q = {
        select() { return q; },
        update(obj) { update = obj; return q; },
        eq(c, v) { filters.push(r => get(r, c) === v); return q; },
        is(c, v) { filters.push(r => get(r, c) == v); return q; },
        not(c, op, v) { filters.push(r => get(r, c) != v); return q; },
        in(c, vs) { filters.push(r => vs.includes(get(r, c))); return q; },
        or(expr) { filters.push(r => orTest(r, expr)); return q; },
        order(c) { order = c; return q; },
        then(res, rej) {
          try {
            let rows = tables[table].filter(r => filters.every(f => f(join(table, r))));
            if (update) { rows.forEach(r => Object.assign(r, update)); }
            rows = rows.map(r => join(table, r));
            if (order) rows.sort((a, b) => a[order] - b[order]);
            res({ data: rows, error: null });
          } catch (e) { rej(e); }
        },
      };
      return q;
    },
  };
}

function setup(nowHM, tasks, goals) {
  const tables = {
    goals: goals || [{ id: 'g1', title: 'Lent', type: 'challenge', status: 'active', final_reminder_sent_on: null }],
    goal_tasks: tasks,
  };
  const sent = { task: [], final: [] };
  let clock = nowHM;
  const jobs = makeGoalReminders({
    supabase: fakeDb(tables),
    notifyTaskReminder: async (mentee, goal, task) => { sent.task.push([mentee, task.title]); },
    notifyFinalReminder: async (mentee, goal, ts) => { sent.final.push([mentee, ts.map(t => t.title)]); },
    now: () => clock, log: { log() {}, error() {} },
  });
  return { tables, sent, jobs, at: hm => { clock = hm; } };
}
const task = (id, title, extra = {}) => ({ id, goal_id: 'g1', mentee_id: 7, title, due_date: TODAY, status: 'pending', position: 0, remind_at: null, task_reminder_sent_on: null, ...extra });

(async () => {
  let n = 0; const ok = m => { n++; console.log('  ok  ' + m); };

  { // on time, once
    const s = setup('06:00', [task('a', 'Prayer', { remind_at: '06:00:00' }), task('b', 'Journal', { remind_at: '20:00' })]);
    assert.strictEqual(await s.jobs.sendTaskReminders(TODAY), 1);
    assert.deepStrictEqual(s.sent.task, [[7, 'Prayer']], 'only the task whose time has come, only that task');
    await s.jobs.sendTaskReminders(TODAY); s.at('06:01'); await s.jobs.sendTaskReminders(TODAY);
    assert.strictEqual(s.sent.task.length, 1, 'never twice, however often the scheduler runs');
    s.at('20:00'); await s.jobs.sendTaskReminders(TODAY);
    assert.deepStrictEqual(s.sent.task.map(t => t[1]), ['Prayer', 'Journal'], 'the next task is reminded at its own time');
    ok('each task is reminded once, at its own time');
  }
  { // before its time / too late
    const s = setup('05:59', [task('a', 'Prayer', { remind_at: '06:00' })]);
    await s.jobs.sendTaskReminders(TODAY); assert.strictEqual(s.sent.task.length, 0, 'not early');
    s.at('08:30'); await s.jobs.sendTaskReminders(TODAY); assert.strictEqual(s.sent.task.length, 0, 'not hours late');
    ok('not before its time, not hours late');
  }
  { // done / skipped / other day / no time / paused goal
    const s = setup('09:00', [
      task('a', 'Done', { remind_at: '06:00', status: 'done' }), task('b', 'Rest', { remind_at: '06:00', status: 'skipped' }),
      task('c', 'Tomorrow', { remind_at: '06:00', due_date: '2026-11-03' }), task('d', 'No time'),
      task('e', 'Archived goal', { remind_at: '08:30', goal_id: 'g2' }),
    ], [{ id: 'g1', title: 'x', type: 'challenge', status: 'active' }, { id: 'g2', title: 'y', type: 'challenge', status: 'archived' }]);
    assert.strictEqual(await s.jobs.sendTaskReminders(TODAY), 0);
    ok('done, skipped (rest), other-day, no-time and archived tasks never remind');
  }
  { // changing a task's time re-arms it (the API clears task_reminder_sent_on)
    const s = setup('06:00', [task('a', 'Prayer', { remind_at: '06:00' })]);
    await s.jobs.sendTaskReminders(TODAY);
    Object.assign(s.tables.goal_tasks[0], { remind_at: '06:30', task_reminder_sent_on: null }); s.at('06:30');
    await s.jobs.sendTaskReminders(TODAY);
    assert.strictEqual(s.sent.task.length, 2);
    ok('a changed time fires again');
  }
  { // 11 PM
    const s = setup('22:59', [task('a', 'Prayer', { remind_at: '06:00', status: 'done' }), task('b', 'Journal', { remind_at: '20:00' }), task('c', 'Walk', { position: 1 })]);
    await s.jobs.sendFinalReminders(TODAY); assert.strictEqual(s.sent.final.length, 0, 'not before 11 PM');
    s.at('23:00'); await s.jobs.sendFinalReminders(TODAY); await s.jobs.sendFinalReminders(TODAY); s.at('23:30'); await s.jobs.sendFinalReminders(TODAY);
    assert.deepStrictEqual(s.sent.final, [[7, ['Journal', 'Walk']]], 'once, only unfinished tasks');
    ok('11:00 PM reminder: once a day, only unfinished tasks');
  }
  { // everything done at 11 PM, and goals without per-task reminders
    const a = setup('23:00', [task('a', 'Prayer', { remind_at: '06:00', status: 'done' })]);
    await a.jobs.sendFinalReminders(TODAY); assert.strictEqual(a.sent.final.length, 0, 'all done: nothing sent');
    const b = setup('23:00', [task('a', 'Prayer')]);
    await b.jobs.sendFinalReminders(TODAY); assert.strictEqual(b.sent.final.length, 0, 'old daily-only goals are untouched');
    ok('11:00 PM reminder skipped when all done, or when the goal has no per-task reminders');
  }
  { // a failed send does not stop the others
    const tables = { goals: [{ id: 'g1', title: 'x', type: 'challenge', status: 'active' }], goal_tasks: [task('a', 'A', { remind_at: '06:00' }), task('b', 'B', { remind_at: '06:00' })] };
    const got = [];
    const jobs = makeGoalReminders({ supabase: fakeDb(tables), notifyFinalReminder() {}, now: () => '06:00', log: { log() {}, error() {} },
      notifyTaskReminder: async (m, g, t) => { if (t.title === 'A') throw new Error('blocked'); got.push(t.title); } });
    await jobs.sendTaskReminders(TODAY); assert.deepStrictEqual(got, ['B']);
    ok('one failed send does not block the rest');
  }
  console.log(`${n} goal reminder scheduling tests passed`);
})().catch(e => { console.error(e); process.exit(1); });
