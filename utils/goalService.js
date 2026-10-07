'use strict';

// Shared goal operations used by routes/goals.js (mini app) and bot.js
// (Telegram buttons), so both enforce the same rules and push the same
// real-time updates.

const { emitToUser } = require('./index');
const R = require('./goalRules');

async function tasksFor(supabase, goalId) {
  const { data, error } = await supabase
    .from('goal_tasks').select('*').eq('goal_id', goalId)
    .order('due_date', { ascending: true }).order('position', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function withTasks(supabase, goal, today = R.ethiopiaToday()) {
  const tasks = await tasksFor(supabase, goal.id);
  return { ...goal, tasks, stats: R.goalStats(tasks, today) };
}

async function listGoals(supabase, mentorId, menteeId) {
  const { data, error } = await supabase
    .from('goals').select('*').eq('mentor_id', mentorId).eq('mentee_id', menteeId)
    .neq('status', 'archived').order('created_at', { ascending: false });
  if (error) throw error;
  const today = R.ethiopiaToday();
  return Promise.all((data || []).map(g => withTasks(supabase, g, today)));
}

// Push the fresh goal (with tasks and stats) to both sides.
async function emitGoal(supabase, goalId) {
  const { data: goal } = await supabase.from('goals').select('*').eq('id', goalId).single();
  if (!goal) return null;
  const full = await withTasks(supabase, goal);
  emitToUser(goal.mentee_id, 'goal2_updated', full);
  emitToUser(goal.mentor_id, 'goal2_updated', full);
  return full;
}

// Tick / un-tick a task, optionally with the mentee's note.
// Returns { error: {status, message} } or { goal, task, dayCompleted }.
async function setTaskDone(supabase, { taskId, actorId, done, note }) {
  const today = R.ethiopiaToday();
  let { data: task } = await supabase.from('goal_tasks').select('*').eq('id', taskId).maybeSingle();
  if (!task) {
    // Telegram buttons sent before the v2 migration carry the old goal id.
    const { data: legacy } = await supabase.from('goal_tasks').select('*').eq('goal_id', taskId).order('position').limit(1);
    task = legacy?.[0];
  }
  if (!task) return { error: { status: 404, message: 'Task not found' } };

  const isMentor = String(task.mentor_id) === String(actorId);
  const isMentee = String(task.mentee_id) === String(actorId);
  if (!isMentor && !isMentee) return { error: { status: 404, message: 'Task not found' } };

  const { data: goal } = await supabase.from('goals').select('*').eq('id', task.goal_id).single();
  if (!goal) return { error: { status: 404, message: 'Goal not found' } };

  if (!isMentor) {
    const blocked = R.menteeCannotSetDone(goal, task, today);
    if (blocked) return { error: { status: 409, message: blocked } };
  }

  const now = new Date().toISOString();
  const updates = {};
  if (typeof done === 'boolean') {
    if (done && task.status !== 'done') {
      Object.assign(updates, { status: 'done', completed_at: now, completed_by: actorId });
      if (task.status === 'missed') Object.assign(updates, { reopened_at: now, reopened_by: actorId });
    } else if (!done && task.status === 'done') {
      // Un-ticking a past day (mentor only) puts it back to missed, not pending,
      // otherwise the sweep would just flag it again.
      const past = R.isGoalPastDue(task.due_date, today);
      Object.assign(updates, { status: past ? 'missed' : 'pending', completed_at: null, completed_by: null });
      if (past) updates.missed_flagged_at = now;
    }
  }
  if (isMentee && typeof note === 'string') {
    const clean = note.trim().slice(0, 500);
    Object.assign(updates, { note: clean || null, note_at: clean ? now : null });
  }
  if (!Object.keys(updates).length) {
    return { goal: await withTasks(supabase, goal, today), task, dayCompleted: false };
  }
  updates.updated_at = now;

  const { data: saved, error } = await supabase.from('goal_tasks').update(updates).eq('id', task.id).select().single();
  if (error) return { error: { status: 500, message: error.message } };

  // Goal-level status follows its tasks.
  const all = await tasksFor(supabase, goal.id);
  const stats = R.goalStats(all, today);
  const finished = stats.total > 0 && stats.pending === 0 && stats.missed === 0 &&
    (goal.type !== 'challenge' || today >= String(goal.end_date).substring(0, 10));
  const nextStatus = goal.status === 'archived' ? 'archived' : (finished ? 'completed' : 'active');
  if (nextStatus !== goal.status) {
    await supabase.from('goals').update({
      status: nextStatus, completed_at: nextStatus === 'completed' ? now : null, updated_at: now,
    }).eq('id', goal.id);
    goal.status = nextStatus;
  }

  const sameDay = all.filter(t => t.due_date && t.status !== 'skipped' &&
    String(t.due_date).substring(0, 10) === String(task.due_date).substring(0, 10));
  const dayCompleted = updates.status === 'done' && isMentee && sameDay.length > 0 && sameDay.every(t => t.status === 'done');

  const full = await emitGoal(supabase, goal.id);

  if (dayCompleted || (updates.status === 'done' && isMentee && goal.type !== 'challenge' && finished)) {
    try {
      const { notifyTaskDone } = require('../bot');
      await notifyTaskDone(goal.mentor_id, goal.mentee_id, full || goal, saved, stats);
    } catch (e) { console.error('[Goals] mentor notification failed:', e.message); }
  }
  return { goal: full, task: saved, dayCompleted };
}

module.exports = { listGoals, withTasks, emitGoal, setTaskDone };
