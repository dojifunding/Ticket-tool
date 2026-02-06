const router = require('express').Router();
const { getDb, createNotification } = require('../database');
const { isAuthenticated } = require('../middleware/auth');

router.use(isAuthenticated);

// ─── Get Notifications ───────────────────────────────
router.get('/notifications', (req, res) => {
  const db = getDb();
  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(req.session.user.id);

  const unreadCount = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.session.user.id).c;

  res.json({ notifications, unreadCount });
});

// ─── Mark Notification Read ──────────────────────────
router.post('/notifications/:id/read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

// ─── Mark All Read ───────────────────────────────────
router.post('/notifications/read-all', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')
    .run(req.session.user.id);
  res.json({ ok: true });
});

// ─── Update Task Status (Drag & Drop) ────────────────
router.post('/tasks/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const validStatuses = ['backlog', 'todo', 'in_progress', 'review', 'done'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, req.params.id);

  const task = db.prepare(`
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color
    FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?
  `).get(req.params.id);

  // Broadcast update
  req.app.get('io').to('role-developer').emit('task:updated', task);

  // Notify assigned dev
  if (task.assigned_to && task.assigned_to !== req.session.user.id) {
    createNotification(task.assigned_to, 'task_update', 'Tâche mise à jour',
      `${req.session.user.full_name} a déplacé "${task.title}" → ${status}`,
      `/projects/${task.project_id}/board`);
    req.app.get('io').to(`user-${task.assigned_to}`).emit('notification:new');
  }

  // ─── ESCALATION FEEDBACK: notify support when escalated task changes status ───
  if (task.escalated_from_ticket) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(task.escalated_from_ticket);
    if (ticket) {
      const user = req.session.user;
      const isDone = (status === 'done');
      const statusLabels = { backlog: 'Backlog', todo: 'À faire', in_progress: 'En cours', review: 'En revue', done: '✅ Terminé' };
      const statusLabel = statusLabels[status] || status;

      const feedbackMsg = isDone
        ? '✅ L\'équipe développement a résolu le problème lié à ce ticket. La tâche "' + task.title + '" est terminée.'
        : '🔄 La tâche escaladée "' + task.title + '" est passée au statut : ' + statusLabel;

      db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?, ?, ?, 1)').run(ticket.id, user.id, feedbackMsg);
      db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticket.id);

      const notifTargets = new Set();
      if (ticket.created_by) notifTargets.add(ticket.created_by);
      if (ticket.assigned_to) notifTargets.add(ticket.assigned_to);

      notifTargets.forEach(targetId => {
        createNotification(targetId, 'escalation', isDone ? 'Escalade résolue' : 'Escalade mise à jour',
          (isDone ? 'Tâche terminée' : 'Statut : ' + statusLabel) + ' — ' + ticket.reference,
          '/tickets/' + ticket.id);
        req.app.get('io').to('user-' + targetId).emit('notification:new');
      });

      req.app.get('io').to('role-support').emit('ticket:updated', { ticketId: ticket.id });
      req.app.get('io').to('role-support').emit('ticket:newMessage', {
        ticketId: ticket.id,
        message: { full_name: user.full_name, avatar_color: '#6366f1', role: 'developer', content: feedbackMsg, is_internal: 1 }
      });
    }
  }

  res.json({ ok: true, task });
});

// ─── Search (global) ─────────────────────────────────
router.get('/search', (req, res) => {
  const db = getDb();
  const { q } = req.query;
  const user = req.session.user;
  const results = [];

  if (user.role === 'admin' || user.role === 'developer') {
    const tasks = db.prepare(`
      SELECT t.id, t.title, t.status, t.type, t.project_id, p.name as project_name, 'task' as result_type
      FROM tasks t JOIN projects p ON t.project_id = p.id
      WHERE t.title LIKE ? OR t.description LIKE ?
      LIMIT 5
    `).all(`%${q}%`, `%${q}%`);
    results.push(...tasks);

    const projects = db.prepare(`
      SELECT id, name, code, status, 'project' as result_type
      FROM projects WHERE name LIKE ? OR code LIKE ? LIMIT 3
    `).all(`%${q}%`, `%${q}%`);
    results.push(...projects);
  }

  if (user.role === 'admin' || user.role === 'support') {
    const tickets = db.prepare(`
      SELECT id, reference, subject, status, priority, 'ticket' as result_type
      FROM tickets WHERE subject LIKE ? OR reference LIKE ? OR client_name LIKE ? OR description LIKE ?
      LIMIT 5
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    results.push(...tickets);
  }

  res.json(results);
});

// ─── Dashboard Stats for Admin ───────────────────────
router.get('/stats', (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const db = getDb();

  res.json({
    openTickets: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status NOT IN (?, ?)').get('resolved', 'closed').c,
    activeTasks: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status NOT IN (?, ?)').get('done', 'backlog').c,
    escalations: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE type = ? AND status != ?').get('escalation', 'done').c,
  });
});

module.exports = router;
