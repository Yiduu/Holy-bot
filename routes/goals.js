'use strict';

const express = require('express');
const R = require('../utils/goalRules');
const S = require('../utils/goalService');
const { emitToUser } = require('../utils');

module.exports = (supabase, requireAuth) => {
  const router = express.Router();
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message || 'Server error' });

  async function activeAssignment(mentorId, menteeId) {
    const { data } = await supabase.from('mentorship_assignments').select('id')
      .eq('mentor_id', mentorId).eq('user_id', menteeId).eq('is_active', true).maybeSingle();
    return !!data;
  }
  async function ownGoal(goalId, mentorId) {
    const { data } = await supabase.from('goals').select('*').eq('id', goalId).maybeSingle();
    return data && String(data.mentor_id) === String(mentorId) ? data : null;
  }

  // GET /api/goals/mine – the mentee's goals from their active mentor
  router.get('/mine', requireAuth, async (req, res) => {
    try {
      const me = req.telegramUser.id;
      const { data: a } = await supabase.from('mentorship_assignments').select('mentor_id')
        .eq('user_id', me).eq('is_active', true).maybeSingle();
      if (!a) return res.json([]);
      res.json(await S.listGoals(supabase, a.mentor_id, me));
    } catch (e) { fail(res, e); }
  });

  // GET /api/goals/mentee/:id – a mentor's goals for one of their mentees
  router.get('/mentee/:id', requireAuth, async (req, res) => {
    try {
      const me = req.telegramUser.id;
      if (!(await activeAssignment(me, req.params.id))) return res.status(403).json({ error: 'No active assignment found for this mentee.' });
      res.json(await S.listGoals(supabase, me, req.params.id));
    } catch (e) { fail(res, e); }
  });

  // POST /api/goals – create a one-time, progressive or challenge goal
  router.post('/', requireAuth, async (req, res) => {
    try {
      const mentor_id = req.telegramUser.id;
      const b = req.body || {};
      const today = R.ethiopiaToday();
      const title = String(b.title || '').trim();
      if (!b.mentee_id || !title) return res.status(400).json({ error: 'mentee_id and title are required' });
      if (title.length > 200) return res.status(400).json({ error: 'Title is too long (max 200 characters)' });
      if (!['one_time', 'progressive', 'challenge'].includes(b.type)) return res.status(400).json({ error: 'Invalid goal type' });
      if (!(await activeAssignment(mentor_id, b.mentee_id))) return res.status(403).json({ error: 'No active assignment found for this mentee.' });

      const goal = { mentor_id, mentee_id: b.mentee_id, type: b.type, title, task_template: [] };
      let tasks = [];
      const deadline = b.type === 'one_time' ? b.due_date : b.end_date;

      if (b.type === 'challenge') {
        if (!R.isValidDay(b.start_date) || !R.isValidDay(b.end_date)) return res.status(400).json({ error: 'Start and end dates are required' });
        if (b.start_date < today) return res.status(400).json({ error: "The start date can't be in the past" });
        const span = R.daysBetween(b.start_date, b.end_date) + 1;
        if (span < 1 || span > R.MAX_CHALLENGE_DAYS) return res.status(400).json({ error: `A challenge can run 1 to ${R.MAX_CHALLENGE_DAYS} days` });
        const tpl = (Array.isArray(b.task_template) ? b.task_template : [title]).map(x => String(x).trim().slice(0, 200)).filter(Boolean);
        if (!tpl.length || tpl.length > R.MAX_TEMPLATE_TASKS) return res.status(400).json({ error: `Add 1 to ${R.MAX_TEMPLATE_TASKS} daily tasks` });
        if (b.reminder_time && !R.isValidTime(b.reminder_time)) return res.status(400).json({ error: 'Invalid reminder time' });
        Object.assign(goal, { start_date: b.start_date, end_date: b.end_date, task_template: tpl, reminder_time: b.reminder_time || '20:00' });
        tasks = R.buildChallengeTasks(goal);
      } else {
        if (deadline && (!R.isValidDay(deadline) || deadline < today)) return res.status(400).json({ error: 'The due date must be today or later' });
        goal.end_date = deadline || null;
        if (b.type === 'progressive') {
          const n = parseInt(b.target_count, 10);
          if (!(n >= 1 && n <= R.MAX_PROGRESSIVE)) return res.status(400).json({ error: `Target must be 1 to ${R.MAX_PROGRESSIVE}` });
          goal.target_count = n;
          tasks = Array.from({ length: n }, (_, i) => ({ title: `${title} (${i + 1}/${n})`.slice(0, 200), position: i, due_date: goal.end_date }));
        } else {
          tasks = [{ title, position: 0, due_date: goal.end_date }];
        }
      }
      if (b.description) goal.description = String(b.description).trim().slice(0, 1000) || null;

      const { data: g, error } = await supabase.from('goals').insert(goal).select().single();
      if (error) return res.status(500).json({ error: error.message });
      const { error: tErr } = await supabase.from('goal_tasks')
        .insert(tasks.map(t => ({ ...t, goal_id: g.id, mentor_id, mentee_id: g.mentee_id })));
      if (tErr) {
        await supabase.from('goals').delete().eq('id', g.id); // no half-created goals
        return res.status(500).json({ error: tErr.message });
      }

      const full = await S.emitGoal(supabase, g.id);
      try {
        const { notifyNewGoal } = require('../bot');
        const { data: ms } = await supabase.from('user_settings').select('display_name').eq('telegram_id', mentor_id).maybeSingle();
        await notifyNewGoal(g.mentee_id, { id: g.id, title: g.title, due_date: g.end_date }, ms?.display_name);
      } catch (e) { console.error('[Goals] new-goal notification failed:', e.message); }
      res.status(201).json(full);
    } catch (e) { fail(res, e); }
  });

  // PATCH /api/goals/tasks/:id – tick/un-tick (+ mentee note); mentor can also
  // rename, skip or restore a day.
  router.patch('/tasks/:id', requireAuth, async (req, res) => {
    try {
      const me = req.telegramUser.id;
      const { done, note, title, status } = req.body || {};
      if (title !== undefined || status !== undefined) {
        const { data: t } = await supabase.from('goal_tasks').select('*').eq('id', req.params.id).maybeSingle();
        if (!t || String(t.mentor_id) !== String(me)) return res.status(404).json({ error: 'Task not found' });
        const up = { updated_at: new Date().toISOString() };
        if (typeof title === 'string' && title.trim()) up.title = title.trim().slice(0, 200);
        if (status === 'skipped') Object.assign(up, { status: 'skipped', completed_at: null, completed_by: null });
        if (status === 'restore' && t.status === 'skipped') up.status = R.isGoalPastDue(t.due_date) ? 'missed' : 'pending';
        const { error } = await supabase.from('goal_tasks').update(up).eq('id', t.id);
        if (error) return res.status(500).json({ error: error.message });
        if (done === undefined && note === undefined) return res.json(await S.emitGoal(supabase, t.goal_id));
      }
      const r = await S.setTaskDone(supabase, { taskId: req.params.id, actorId: me, done, note });
      if (r.error) return fail(res, r.error);
      res.json(r.goal);
    } catch (e) { fail(res, e); }
  });

  // POST /api/goals/:id/tasks – add an extra task (optionally on a given day)
  router.post('/:id/tasks', requireAuth, async (req, res) => {
    try {
      const goal = await ownGoal(req.params.id, req.telegramUser.id);
      if (!goal) return res.status(404).json({ error: 'Goal not found' });
      const title = String(req.body?.title || '').trim().slice(0, 200);
      const due = req.body?.due_date || null;
      if (!title) return res.status(400).json({ error: 'Title is required' });
      if (goal.type === 'challenge' && !(R.isValidDay(due) && due >= String(goal.start_date).substring(0, 10) && due <= String(goal.end_date).substring(0, 10))) {
        return res.status(400).json({ error: 'Pick a day inside the challenge' });
      }
      const { data: last } = await supabase.from('goal_tasks').select('position').eq('goal_id', goal.id)
        .order('position', { ascending: false }).limit(1);
      const { error } = await supabase.from('goal_tasks').insert({
        goal_id: goal.id, mentor_id: goal.mentor_id, mentee_id: goal.mentee_id, title, due_date: due,
        position: (last?.[0]?.position ?? -1) + 1,
        status: due && R.isGoalPastDue(due) ? 'missed' : 'pending',
      });
      if (error) return res.status(500).json({ error: error.message });
      res.status(201).json(await S.emitGoal(supabase, goal.id));
    } catch (e) { fail(res, e); }
  });

  // DELETE /api/goals/tasks/:id
  router.delete('/tasks/:id', requireAuth, async (req, res) => {
    try {
      const { data: t } = await supabase.from('goal_tasks').select('goal_id, mentor_id').eq('id', req.params.id).maybeSingle();
      if (!t || String(t.mentor_id) !== String(req.telegramUser.id)) return res.status(404).json({ error: 'Task not found' });
      await supabase.from('goal_tasks').delete().eq('id', req.params.id);
      res.json(await S.emitGoal(supabase, t.goal_id));
    } catch (e) { fail(res, e); }
  });

  // PATCH /api/goals/:id – title, reminder time, archive, or move the end date
  router.patch('/:id', requireAuth, async (req, res) => {
    try {
      const goal = await ownGoal(req.params.id, req.telegramUser.id);
      if (!goal) return res.status(404).json({ error: 'Goal not found' });
      const b = req.body || {};
      const today = R.ethiopiaToday();
      const up = { updated_at: new Date().toISOString() };
      if (typeof b.title === 'string' && b.title.trim()) up.title = b.title.trim().slice(0, 200);
      if (b.reminder_time !== undefined) {
        if (b.reminder_time && !R.isValidTime(b.reminder_time)) return res.status(400).json({ error: 'Invalid reminder time' });
        up.reminder_time = b.reminder_time || null;
      }
      if (['active', 'archived'].includes(b.status)) up.status = b.status;

      if (b.end_date !== undefined && b.end_date !== goal.end_date) {
        if (!R.isValidDay(b.end_date)) return res.status(400).json({ error: 'Invalid end date' });
        const oldEnd = goal.end_date ? String(goal.end_date).substring(0, 10) : null;
        if (goal.type === 'challenge') {
          const span = R.daysBetween(String(goal.start_date).substring(0, 10), b.end_date) + 1;
          if (span < 1 || span > R.MAX_CHALLENGE_DAYS) return res.status(400).json({ error: `A challenge can run 1 to ${R.MAX_CHALLENGE_DAYS} days` });
          if (b.end_date > oldEnd) {
            const rows = R.buildChallengeTasks(goal, R.addDays(oldEnd, 1), b.end_date)
              .map(t => ({ ...t, goal_id: goal.id, mentor_id: goal.mentor_id, mentee_id: goal.mentee_id }));
            const { error } = await supabase.from('goal_tasks').insert(rows);
            if (error) return res.status(500).json({ error: error.message });
          } else {
            const { data: kept } = await supabase.from('goal_tasks').select('id').eq('goal_id', goal.id)
              .gt('due_date', b.end_date).in('status', ['done', 'missed']).limit(1);
            if (kept?.length) return res.status(409).json({ error: 'Days after the new end date already have progress.' });
            await supabase.from('goal_tasks').delete().eq('goal_id', goal.id).gt('due_date', b.end_date);
          }
        } else {
          if (b.end_date < today) return res.status(400).json({ error: 'The due date must be today or later' });
          await supabase.from('goal_tasks').update({ due_date: b.end_date, status: 'pending', missed_flagged_at: null, last_reminder_sent_on: null })
            .eq('goal_id', goal.id).in('status', ['pending', 'missed']);
        }
        up.end_date = b.end_date;
        if (goal.status === 'completed') up.status = 'active';
      }
      const { error } = await supabase.from('goals').update(up).eq('id', goal.id);
      if (error) return res.status(500).json({ error: error.message });
      res.json(await S.emitGoal(supabase, goal.id));
    } catch (e) { fail(res, e); }
  });

  // DELETE /api/goals/:id
  router.delete('/:id', requireAuth, async (req, res) => {
    try {
      const goal = await ownGoal(req.params.id, req.telegramUser.id);
      if (!goal) return res.status(404).json({ error: 'Goal not found' });
      const { error } = await supabase.from('goals').delete().eq('id', goal.id);
      if (error) return res.status(500).json({ error: error.message });
      const payload = { id: goal.id, mentee_id: goal.mentee_id, mentor_id: goal.mentor_id };
      emitToUser(goal.mentee_id, 'goal2_deleted', payload);
      emitToUser(goal.mentor_id, 'goal2_deleted', payload);
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });

  return router;
};
