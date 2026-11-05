'use strict';

// Guest mode sandbox: lets a mentor try the app AS A MENTEE without touching
// real data. Everything lives in memory, keyed by the mentor's telegram id,
// and is discarded on exit, on restart, or after IDLE_MS of inactivity.
//
// This module never imports supabase or the bot, so it cannot write real data
// or notify anyone. Goal behaviour reuses the real pure rules (goalRules) so a
// guest sees exactly what a real mentee would see.

const R = require('./goalRules');

const IDLE_MS = 6 * 60 * 60 * 1000;   // forget a sandbox after 6h idle
const MAX_SANDBOXES = 200;            // hard cap so memory can't grow unbounded
const MAX_GOALS = 20;
const MAX_JOURNAL = 100;

const GUEST_BASE_ID = 9000000000000;  // never collides with real Telegram ids

const stores = new Map();
let seq = 1;
const nid = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`;

function sweep() {
  const now = Date.now();
  for (const [k, s] of stores) if (now - s.touched > IDLE_MS) stores.delete(k);
  while (stores.size > MAX_SANDBOXES) stores.delete(stores.keys().next().value);
}

function create(mentorId, sex) {
  const menteeId = GUEST_BASE_ID + (Number(mentorId) % 1000000);
  return {
    mentorId: String(mentorId),
    touched: Date.now(),
    persona: {
      telegram_id: menteeId,
      anonymous_id: 'Guest_Mentee',
      sex: ['M', 'F', 'prefer_not'].includes(sex) ? sex : 'prefer_not',
      age_range: '25-34',
    },
    requests: [],            // [{ id, mentor, topic_id, status, created_at }]
    waitlist: new Set(),
    assignment: null,        // { mentor } once a request is "accepted"
    goals: [], tasks: [],
    streak: { current: 0, longest: 0, last: null, log: {} },
    journal: [],
    messages: [],
    topics: [],              // chosen topic ids
    settings: { display_name: 'Guest Mentee', notify_messages: true, notify_sessions: true, notify_daily_verse: false, notify_streak_reminder: true },
  };
}

function get(mentorId) { const s = stores.get(String(mentorId)); if (s) s.touched = Date.now(); return s || null; }

function start(mentorId, sex) {
  sweep();
  const s = create(mentorId, sex);
  stores.set(String(mentorId), s);
  return s;
}

function end(mentorId) { return stores.delete(String(mentorId)); }

// ── User object shaped like /api/auth/me → user ─────────────────────────
function userView(s) {
  const p = s.persona;
  return {
    telegram_id: p.telegram_id, anonymous_id: p.anonymous_id, role: 'user',
    sex: p.sex, age_range: p.age_range, is_banned: false, is_guest: true,
    user_settings: { ...s.settings, telegram_id: p.telegram_id },
  };
}

// ── Mentorship simulation ────────────────────────────────────────────────
function addRequest(s, mentor, topicId) {
  if (s.assignment) return { status: 409, error: 'You already have a mentor in this preview.' };
  if (s.requests.some(r => r.status === 'pending' && String(r.mentor.telegram_id) === String(mentor.telegram_id))) {
    return { status: 409, error: 'You already have a pending request with this mentor.' };
  }
  const r = { id: nid(), mentor, topic_id: topicId || null, status: 'pending', created_at: new Date().toISOString() };
  s.requests.push(r);
  return { request: r };
}

function pendingMentorIds(s) { return new Set(s.requests.filter(r => r.status === 'pending').map(r => r.mentor.telegram_id)); }

function cancelRequest(s, id) {
  const r = s.requests.find(x => x.id === id && x.status === 'pending');
  if (!r) return false;
  r.status = 'cancelled';
  return true;
}

// The mentor presses "simulate acceptance" so they can preview the rest of
// the mentee experience (chat, goals) without involving a real mentor.
function simulateAccept(s, requestId) {
  const r = s.requests.find(x => x.id === requestId && x.status === 'pending');
  if (!r) return { status: 404, error: 'Request not found' };
  r.status = 'accepted';
  s.assignment = { id: nid(), mentor: r.mentor, started_at: new Date().toISOString() };
  s.messages.push({
    id: nid(), from_id: r.mentor.telegram_id, to_id: s.persona.telegram_id,
    content: 'Welcome! (Preview message) This is how a first message from your mentor looks.',
    created_at: new Date().toISOString(), is_read: false,
  });
  return { assignment: s.assignment };
}

function endAssignment(s) { s.assignment = null; s.goals = []; s.tasks = []; s.messages = []; }

// ── Goals (same rules as routes/goals.js, in memory) ────────────────────
const goalView = (s, g) => {
  const tasks = s.tasks.filter(t => t.goal_id === g.id)
    .sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')) || a.position - b.position);
  return { ...g, tasks, stats: R.goalStats(tasks, R.ethiopiaToday()) };
};
const listGoals = s => s.goals.filter(g => g.status !== 'archived').map(g => goalView(s, g)).reverse();

function createGoal(s, b) {
  if (!s.assignment) return { status: 403, error: 'Send a request and use "Simulate acceptance" first.' };
  if (s.goals.length >= MAX_GOALS) return { status: 400, error: 'Preview limit reached (20 goals).' };
  const today = R.ethiopiaToday();
  const title = String(b.title || '').trim();
  if (!title) return { status: 400, error: 'title is required' };
  if (title.length > 200) return { status: 400, error: 'Title is too long (max 200 characters)' };
  if (!['one_time', 'progressive', 'challenge'].includes(b.type)) return { status: 400, error: 'Invalid goal type' };

  const goal = { id: nid(), mentor_id: s.assignment.mentor.telegram_id, mentee_id: s.persona.telegram_id,
    type: b.type, title, task_template: [], status: 'active', created_at: new Date().toISOString() };
  let tasks = [];
  const deadline = b.type === 'one_time' ? b.due_date : b.end_date;

  if (b.type === 'challenge') {
    if (!R.isValidDay(b.start_date) || !R.isValidDay(b.end_date)) return { status: 400, error: 'Start and end dates are required' };
    if (b.start_date < today) return { status: 400, error: "The start date can't be in the past" };
    const span = R.daysBetween(b.start_date, b.end_date) + 1;
    if (span < 1 || span > R.MAX_CHALLENGE_DAYS) return { status: 400, error: `A challenge can run 1 to ${R.MAX_CHALLENGE_DAYS} days` };
    if (b.reminder_time && !R.isValidTime(b.reminder_time)) return { status: 400, error: 'Invalid reminder time' };
    Object.assign(goal, { start_date: b.start_date, end_date: b.end_date, reminder_time: b.reminder_time || '20:00' });
    if (b.day_plan) {
      const r = R.normalizeDayPlan(b.day_plan, b.start_date, b.end_date);
      if (r.error) return { status: 400, error: r.error };
      goal.custom_days = true;
      tasks = R.buildChallengeTasks(goal, b.start_date, b.end_date, r.plan);
    } else {
      const r = R.normalizeTemplate(b.task_template, title);
      if (r.error) return { status: 400, error: r.error };
      goal.task_template = r.template;
      tasks = R.buildChallengeTasks(goal);
    }
  } else {
    if (deadline && (!R.isValidDay(deadline) || deadline < today)) return { status: 400, error: 'The due date must be today or later' };
    goal.end_date = deadline || null;
    if (b.type === 'progressive') {
      const n = parseInt(b.target_count, 10);
      if (!(n >= 1 && n <= R.MAX_PROGRESSIVE)) return { status: 400, error: `Target must be 1 to ${R.MAX_PROGRESSIVE}` };
      goal.target_count = n;
      tasks = Array.from({ length: n }, (_, i) => ({ title: `${title} (${i + 1}/${n})`.slice(0, 200), position: i, due_date: goal.end_date }));
    } else {
      tasks = [{ title, position: 0, due_date: goal.end_date }];
    }
  }
  if (b.description) goal.description = String(b.description).trim().slice(0, 1000) || null;

  s.goals.push(goal);
  tasks.forEach(t => s.tasks.push({ status: 'pending', ...t, id: nid(), goal_id: goal.id,
    mentor_id: goal.mentor_id, mentee_id: goal.mentee_id, created_at: goal.created_at }));
  return { goal: goalView(s, goal) };
}

function deleteGoal(s, id) {
  const i = s.goals.findIndex(g => g.id === id);
  if (i < 0) return false;
  s.goals.splice(i, 1);
  s.tasks = s.tasks.filter(t => t.goal_id !== id);
  return true;
}

// Mentee ticks / un-ticks a task and can leave a note. Mirrors
// goalService.setTaskDone for the mentee actor, including its blocking rules.
function setTaskDone(s, taskId, { done, note }) {
  const today = R.ethiopiaToday();
  const task = s.tasks.find(t => t.id === taskId);
  if (!task) return { status: 404, error: 'Task not found' };
  const goal = s.goals.find(g => g.id === task.goal_id);
  if (!goal) return { status: 404, error: 'Goal not found' };

  const blocked = R.menteeCannotSetDone(goal, task, today);
  if (blocked) return { status: 409, error: blocked };

  const now = new Date().toISOString();
  if (typeof done === 'boolean') {
    if (done && task.status !== 'done') {
      Object.assign(task, { status: 'done', completed_at: now, completed_by: s.persona.telegram_id });
    } else if (!done && task.status === 'done') {
      Object.assign(task, { status: R.isGoalPastDue(task.due_date, today) ? 'missed' : 'pending', completed_at: null, completed_by: null });
    }
  }
  if (typeof note === 'string') {
    const clean = note.trim().slice(0, 500);
    Object.assign(task, { note: clean || null, note_at: clean ? now : null });
  }
  task.updated_at = now;

  const all = s.tasks.filter(t => t.goal_id === goal.id);
  const st = R.goalStats(all, today);
  const finished = st.total > 0 && st.pending === 0 && st.missed === 0 &&
    (goal.type !== 'challenge' || today >= String(goal.end_date).substring(0, 10));
  goal.status = finished ? 'completed' : 'active';
  return { goal: goalView(s, goal) };
}

// ── Streak ───────────────────────────────────────────────────────────────
function streakView(s) {
  const today = R.ethiopiaToday();
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = R.addDays(today, -i);
    week.push({ date: d, is_today: d === today, read: !!s.streak.log[d], used_freeze: false });
  }
  return { current_streak: s.streak.current, longest_streak: s.streak.longest, last_read_date: s.streak.last,
    freezes_available: 0, week, notify_streak_reminder: s.settings.notify_streak_reminder !== false };
}

function markStreak(s) {
  const today = R.ethiopiaToday();
  const st = s.streak;
  if (st.log[today]) return { ...streakView(s), milestone: false, freeze_used: false, was_reset: false };
  const wasReset = !!st.last && st.last !== R.addDays(today, -1);
  st.current = wasReset || !st.last ? 1 : st.current + 1;
  st.longest = Math.max(st.longest, st.current);
  st.last = today;
  st.log[today] = true;
  return { ...streakView(s), milestone: [7, 30, 100].includes(st.current), freeze_used: false, was_reset: wasReset };
}

// ── Journal ──────────────────────────────────────────────────────────────
function addJournal(s, { content, mood }) {
  const text = String(content || '').trim();
  if (!text) return { status: 400, error: 'Content is required' };
  if (s.journal.length >= MAX_JOURNAL) return { status: 400, error: 'Preview limit reached.' };
  const e = { id: nid(), telegram_id: s.persona.telegram_id, content: text.slice(0, 5000), mood: mood || null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  s.journal.unshift(e);
  return { entry: e };
}
function updateJournal(s, id, { content, mood }) {
  const e = s.journal.find(x => x.id === id);
  if (!e) return { status: 404, error: 'Entry not found' };
  if (typeof content === 'string' && content.trim()) e.content = content.trim().slice(0, 5000);
  if (mood !== undefined) e.mood = mood;
  e.updated_at = new Date().toISOString();
  return { entry: e };
}
function deleteJournal(s, id) {
  const i = s.journal.findIndex(x => x.id === id);
  if (i < 0) return false;
  s.journal.splice(i, 1);
  return true;
}

module.exports = {
  GUEST_BASE_ID, start, get, end, userView,
  addRequest, pendingMentorIds, cancelRequest, simulateAccept, endAssignment,
  listGoals, createGoal, deleteGoal, setTaskDone,
  streakView, markStreak, addJournal, updateJournal, deleteJournal,
};
