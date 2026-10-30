'use strict';

// Shared rules for goals. Pure functions only (no database, no clock unless
// "today" is defaulted), so the REST API, the Telegram bot and the nightly
// jobs all agree, and the rules are unit-testable.
//
// "Today" is the date in Ethiopia, the same reference every scheduler uses.

const MS_DAY = 86400000;
const MAX_CHALLENGE_DAYS = 120;
const MAX_TEMPLATE_TASKS = 4;
const MAX_PROGRESSIVE = 50;
// Per-task reminders: a reminder that is more than this late (e.g. the server
// was down, or the task was added after its time) is skipped, not sent hours late.
const REMINDER_GRACE_MIN = 120;
// Last reminder of the day: lists what is still unfinished. Ethiopia local time.
const FINAL_REMINDER_TIME = '23:00';

function ethiopiaToday() {
  // en-CA formats as YYYY-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Addis_Ababa' });
}

// HH:MM (24h) in Ethiopia right now.
function ethiopiaTimeHM() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Addis_Ababa', hour12: false, hour: '2-digit', minute: '2-digit' });
}

const day = s => String(s).substring(0, 10);
const parseDay = s => { const [y, m, d] = day(s).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const formatDay = ms => new Date(ms).toISOString().substring(0, 10);
const addDays = (s, n) => formatDay(parseDay(s) + n * MS_DAY);
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / MS_DAY); // b - a
const isValidDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && formatDay(parseDay(s)) === s;
const isValidTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

const hmToMin = s => { const [h, m] = String(s).substring(0, 5).split(':').map(Number); return h * 60 + m; };

// Is a per-task reminder due right now? True from remind_at until
// REMINDER_GRACE_MIN later (same Ethiopia day, so no wrap-around).
function isTaskReminderDue(remindAt, nowHM = ethiopiaTimeHM()) {
  if (!remindAt) return false;
  const late = hmToMin(nowHM) - hmToMin(remindAt);
  return late >= 0 && late <= REMINDER_GRACE_MIN;
}

// A mentor's task entry is a title string (no reminder) or { title, remind_at }.
// Returns { title, remind_at } (remind_at null when absent) or { error }.
function taskItem(x) {
  const raw = x && typeof x === 'object' ? x : { title: x };
  const title = String(raw.title ?? '').trim().slice(0, 200);
  const at = raw.remind_at ? String(raw.remind_at).substring(0, 5) : null;
  if (at && !isValidTime(at)) return { error: 'Invalid reminder time' };
  return { title, remind_at: at };
}
// Keep plain strings when there is no reminder, so stored data for existing
// goals and old clients stays exactly as it was.
const compactItem = it => (it.remind_at ? { title: it.title, remind_at: it.remind_at } : it.title);
const itemTitle = x => (x && typeof x === 'object' ? String(x.title ?? '') : String(x ?? ''));
const itemRemind = x => (x && typeof x === 'object' && x.remind_at ? String(x.remind_at).substring(0, 5) : null);

// dueDate may be 'YYYY-MM-DD' or a full timestamp string; null/empty = no due date.
function isGoalPastDue(dueDate, today = ethiopiaToday()) {
  if (!dueDate) return false;
  return day(dueDate) < today;
}

// Why a MENTEE may not change this task right now, or null if they may.
// Mentors are never blocked by date: they can reopen any day.
//  - challenge days can only be ticked on the day itself
//  - one-time / progressive tasks can be ticked any time up to their due date
//  - once a date has passed the task is closed, whatever its status
function menteeCannotSetDone(goal, task, today = ethiopiaToday()) {
  if (goal.status === 'archived') return 'This goal is archived.';
  if (task.status === 'skipped') return 'Your mentor skipped this day.';
  if (task.status === 'missed') return 'This day has passed and is closed. Ask your mentor to reopen it.';
  if (!task.due_date) return null;
  const due = day(task.due_date);
  if (due < today) return 'This day has passed and is closed. Ask your mentor to reopen it.';
  if (goal.type === 'challenge' && due > today) return "This day hasn't started yet.";
  return null;
}

// Streak = consecutive fully-done days ending today (if today is already
// done) or yesterday. A day is done when every non-skipped task on it is
// done. Skipped-only days are neutral; a still-pending today is not a failure.
// Mirrors goal_current_streak() in migrations/20261007_goals_v2.sql.
function computeStreak(tasks, today = ethiopiaToday()) {
  const byDay = new Map();
  for (const t of tasks) {
    if (!t.due_date || t.status === 'skipped') continue;
    const d = day(t.due_date);
    if (d > today) continue;
    byDay.set(d, (byDay.get(d) ?? true) && t.status === 'done');
  }
  const days = [...byDay.entries()].filter(([d, ok]) => d < today || ok).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  let streak = 0;
  for (const [, ok] of days) { if (!ok) break; streak++; }
  return streak;
}

function goalStats(tasks, today = ethiopiaToday()) {
  const live = tasks.filter(t => t.status !== 'skipped');
  const done = live.filter(t => t.status === 'done').length;
  const todays = live.filter(t => t.due_date && day(t.due_date) === today);
  return {
    total: live.length,
    done,
    missed: live.filter(t => t.status === 'missed').length,
    pending: live.filter(t => t.status === 'pending').length,
    pct: live.length ? Math.round((done / live.length) * 100) : 0,
    streak: computeStreak(tasks, today),
    today_total: todays.length,
    today_done: todays.filter(t => t.status === 'done').length,
  };
}

// How many of the most recent past days in a row were missed (a day is missed
// when any non-skipped task on it is missed). Used to warn the mentor.
function trailingMissedDays(tasks, today = ethiopiaToday()) {
  const byDay = new Map();
  for (const t of tasks) {
    if (!t.due_date || t.status === 'skipped') continue;
    const d = day(t.due_date);
    if (d >= today) continue;
    byDay.set(d, byDay.get(d) || t.status === 'missed');
  }
  let run = 0;
  for (const [, missed] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    if (!missed) break;
    run++;
  }
  return run;
}

// Same for the "same every day" template: ['task', { title, remind_at }, ...].
function normalizeTemplate(raw, fallbackTitle) {
  const items = [];
  for (const x of Array.isArray(raw) ? raw : [fallbackTitle]) {
    const it = taskItem(x);
    if (it.error) return { error: it.error };
    if (it.title) items.push(compactItem(it));
  }
  if (!items.length || items.length > MAX_TEMPLATE_TASKS) return { error: `Add 1 to ${MAX_TEMPLATE_TASKS} daily tasks` };
  return { template: items };
}

// Validates a mentor's day-by-day plan: { 'YYYY-MM-DD': ['task' | { title, remind_at }, ...] }.
// Dates outside start..end are rejected, titles are trimmed/clamped, and a day
// with no tasks is simply a rest day. Returns { plan } or { error }.
function normalizeDayPlan(raw, start, end) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Add tasks for at least one day' };
  const plan = {};
  let any = false;
  for (const [d, list] of Object.entries(raw)) {
    if (!isValidDay(d) || d < day(start) || d > day(end)) return { error: `${d} is outside the challenge dates` };
    const items = [];
    for (const x of Array.isArray(list) ? list : []) {
      const it = taskItem(x);
      if (it.error) return { error: it.error };
      if (it.title) items.push(compactItem(it));
    }
    if (items.length > MAX_TEMPLATE_TASKS) return { error: `A day can have at most ${MAX_TEMPLATE_TASKS} tasks (${d})` };
    if (items.length) { plan[d] = items; any = true; }
  }
  return any ? { plan } : { error: 'Add tasks for at least one day' };
}

// One row per task per calendar day from..to (inclusive).
//  - custom_days goals use the mentor's per-day plan (days not in it get no
//    tasks, so extending a custom challenge never invents work)
//  - otherwise every day repeats task_template
function buildChallengeTasks(goal, from = goal.start_date, to = goal.end_date, plan = null) {
  const rows = [];
  const template = (goal.task_template?.length ? goal.task_template : [goal.title]);
  for (let d = day(from); d <= day(to); d = addDays(d, 1)) {
    const items = goal.custom_days ? (plan?.[d] || []) : template;
    items.forEach((x, position) => {
      const row = { title: itemTitle(x), position, due_date: d };
      const at = itemRemind(x);
      if (at) row.remind_at = at; // only set when used, so goals without reminders insert as before
      rows.push(row);
    });
  }
  return rows;
}

module.exports = {
  MAX_CHALLENGE_DAYS, MAX_TEMPLATE_TASKS, MAX_PROGRESSIVE, REMINDER_GRACE_MIN, FINAL_REMINDER_TIME,
  isTaskReminderDue, taskItem, normalizeTemplate,
  ethiopiaToday, ethiopiaTimeHM, isGoalPastDue, addDays, daysBetween, isValidDay, isValidTime,
  menteeCannotSetDone, computeStreak, trailingMissedDays, goalStats, buildChallengeTasks, normalizeDayPlan,
};
