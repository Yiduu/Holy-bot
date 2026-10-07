'use strict';
// Rules for goals v2: who may tick what, streaks, missed runs, challenge generation.
const assert = require('assert');
const R = require('../utils/goalRules');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

const T = '2026-10-07';
const task = (due, status = 'pending', extra = {}) => ({ due_date: due, status, ...extra });
const ch = { type: 'challenge', status: 'active' };

test('date helpers', () => {
  assert.strictEqual(R.addDays('2026-09-30', 1), '2026-10-01');
  assert.strictEqual(R.daysBetween('2026-09-24', '2026-10-23'), 29);
  assert(R.isValidDay('2026-10-07') && !R.isValidDay('2026-02-30') && !R.isValidDay('x'));
  assert(R.isValidTime('20:00') && !R.isValidTime('24:00'));
});

test('mentee: challenge day is only open on the day itself', () => {
  assert.strictEqual(R.menteeCannotSetDone(ch, task(T), T), null);
  assert(R.menteeCannotSetDone(ch, task('2026-10-06'), T), 'past day must be closed');
  assert(R.menteeCannotSetDone(ch, task('2026-10-06', 'done'), T), 'past done day cannot be undone');
  assert(R.menteeCannotSetDone(ch, task('2026-10-08'), T), 'future day not started');
  assert(R.menteeCannotSetDone(ch, task(T, 'missed'), T));
  assert(R.menteeCannotSetDone(ch, task(T, 'skipped'), T));
});

test('mentee: one-time and progressive tasks stay open until the due date', () => {
  const one = { type: 'one_time', status: 'active' };
  assert.strictEqual(R.menteeCannotSetDone(one, task('2026-10-10'), T), null);
  assert.strictEqual(R.menteeCannotSetDone(one, task(null), T), null);
  assert(R.menteeCannotSetDone(one, task('2026-10-06'), T));
  assert(R.menteeCannotSetDone({ ...one, status: 'archived' }, task(T), T));
});

test('streak: counts fully done days, missed day breaks it, done days stay done', () => {
  const tasks = [];
  for (let n = 0; n < 13; n++) {
    const d = R.addDays('2026-09-24', n);
    const miss = n === 5 || n === 8;
    tasks.push(task(d, miss ? 'missed' : 'done'), task(d, miss ? 'missed' : 'done', { position: 1 }));
  }
  tasks.push(task(T), task(T)); // today still pending: not a failure
  assert.strictEqual(R.computeStreak(tasks, T), 4);
  tasks.slice(-2).forEach(t => { t.status = 'done'; });
  assert.strictEqual(R.computeStreak(tasks, T), 5);
  assert.strictEqual(R.goalStats(tasks, T).done, 11 * 2 + 2);
});

test('streak: a half-done day breaks it; skipped days are neutral', () => {
  const half = [task('2026-10-05', 'done'), task('2026-10-06', 'done'), task('2026-10-06', 'missed'), task(T, 'done')];
  assert.strictEqual(R.computeStreak(half, T), 1);
  const skip = [task('2026-10-05', 'done'), task('2026-10-06', 'skipped'), task(T, 'done')];
  assert.strictEqual(R.computeStreak(skip, T), 2);
});

test('trailing missed days', () => {
  const t = [task('2026-10-03', 'done'), task('2026-10-04', 'missed'), task('2026-10-05', 'missed'), task('2026-10-06', 'missed'), task(T)];
  assert.strictEqual(R.trailingMissedDays(t, T), 3);
  assert.strictEqual(R.trailingMissedDays([task('2026-10-06', 'done')], T), 0);
});

test('challenge generation: one row per template entry per day', () => {
  const rows = R.buildChallengeTasks({ title: 'x', start_date: '2026-09-24', end_date: '2026-10-23', task_template: ['Prayer', 'Journal'] });
  assert.strictEqual(rows.length, 60);
  assert.deepStrictEqual(rows[0], { title: 'Prayer', position: 0, due_date: '2026-09-24' });
  assert.strictEqual(rows[59].due_date, '2026-10-23');
  assert.strictEqual(R.buildChallengeTasks({ title: 'Solo', start_date: T, end_date: T, task_template: [] }).length, 1);
});

test('per-day plan: each day gets its own tasks, empty days are rest days', () => {
  const g = { title: 'x', custom_days: true, start_date: '2026-10-07', end_date: '2026-10-10', task_template: [] };
  const n = R.normalizeDayPlan({ '2026-10-07': [' Read Psalm 23 ', ''], '2026-10-09': ['Fast', 'Pray', 'Journal'] }, g.start_date, g.end_date);
  assert.deepStrictEqual(n.plan, { '2026-10-07': ['Read Psalm 23'], '2026-10-09': ['Fast', 'Pray', 'Journal'] });
  const rows = R.buildChallengeTasks(g, g.start_date, g.end_date, n.plan);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.filter(r => r.due_date === '2026-10-09').map(r => [r.position, r.title]), [[0, 'Fast'], [1, 'Pray'], [2, 'Journal']]);
  assert(!rows.some(r => r.due_date === '2026-10-08' || r.due_date === '2026-10-10'), 'rest days have no rows');
  // extending a custom challenge never invents work
  assert.strictEqual(R.buildChallengeTasks(g, '2026-10-11', '2026-10-14').length, 0);
});

test('per-day plan validation', () => {
  assert(R.normalizeDayPlan({}, T, '2026-10-10').error, 'empty plan rejected');
  assert(R.normalizeDayPlan({ '2026-10-07': ['', '  '] }, T, '2026-10-10').error, 'blank-only plan rejected');
  assert(R.normalizeDayPlan({ '2026-11-01': ['x'] }, T, '2026-10-10').error, 'day outside range rejected');
  assert(R.normalizeDayPlan({ 'nope': ['x'] }, T, '2026-10-10').error, 'bad date rejected');
  assert(R.normalizeDayPlan({ [T]: ['1', '2', '3', '4', '5'] }, T, '2026-10-10').error, 'too many tasks rejected');
});

console.log(`${passed} goal rule tests passed`);
