const router = require('express').Router();
const { getDb, logActivity, createNotification } = require('../database');
const { isAuthenticated, isDeveloper } = require('../middleware/auth');

router.use(isAuthenticated, isDeveloper);

// ─── Projects List ───────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const projects = db.prepare(`
    SELECT p.*,
      u.full_name as creator_name,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') as done_count
    FROM projects p
    LEFT JOIN users u ON p.created_by = u.id
    ORDER BY p.updated_at DESC
  `).all();

  res.render('projects/index', { projects, title: 'Projets' });
});

// ─── New Project Form ────────────────────────────────
router.get('/new', (req, res) => {
  res.render('projects/form', { project: null, title: 'Nouveau Projet' });
});

// ─── Create Project ──────────────────────────────────
router.post('/new', (req, res) => {
  const db = getDb();
  const { name, code, description, priority, color } = req.body;
  const user = req.session.user;

  try {
    db.prepare(`
      INSERT INTO projects (name, code, description, priority, color, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, code.toUpperCase(), description, priority, color || '#6366f1', user.id);

    logActivity(user.id, 'created', 'project', db.prepare('SELECT last_insert_rowid() as id').get().id, name);

    // Notify all developers
    const devs = db.prepare('SELECT id FROM users WHERE role IN (?, ?) AND id != ?').all('developer', 'admin', user.id);
    devs.forEach(dev => {
      createNotification(dev.id, 'project_created', 'Nouveau projet', `${user.full_name} a créé le projet "${name}"`, '/projects');
      req.app.get('io').to(`user-${dev.id}`).emit('notification:new');
    });

    res.redirect('/projects');
  } catch (err) {
    res.render('projects/form', {
      project: req.body,
      title: 'Nouveau Projet',
      error: err.message.includes('UNIQUE') ? 'Ce code projet existe déjà' : 'Erreur lors de la création'
    });
  }
});

// ─── Project Board (Kanban) ──────────────────────────
router.get('/:id/board', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).render('error', { user: req.session.user, title: 'Projet introuvable', message: 'Ce projet n\'existe pas.', code: 404 });

  const tasks = db.prepare(`
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.project_id = ?
    ORDER BY t.priority DESC, t.position ASC
  `).all(req.params.id);

  const developers = db.prepare('SELECT id, full_name, avatar_color FROM users WHERE role IN (?, ?) AND is_active = 1').all('developer', 'admin');

  const columns = {
    backlog: tasks.filter(t => t.status === 'backlog'),
    todo: tasks.filter(t => t.status === 'todo'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    review: tasks.filter(t => t.status === 'review'),
    done: tasks.filter(t => t.status === 'done')
  };

  res.render('projects/board', { project, columns, developers, title: `${project.name} — Board` });
});

// ─── Create Task ─────────────────────────────────────
router.post('/:id/tasks', (req, res) => {
  const db = getDb();
  const { title, description, status, priority, type, assigned_to, due_date } = req.body;
  const user = req.session.user;
  const projectId = req.params.id;

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, type, assigned_to, created_by, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, title, description, status || 'todo', priority, type || 'task', assigned_to || null, user.id, due_date || null);

  db.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);

  const task = db.prepare(`
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color
    FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?
  `).get(result.lastInsertRowid);

  // Real-time broadcast
  req.app.get('io').to('role-developer').emit('task:created', task);

  // Notify assigned dev
  if (assigned_to && parseInt(assigned_to) !== user.id) {
    createNotification(parseInt(assigned_to), 'task_assigned', 'Tâche assignée',
      `${user.full_name} vous a assigné "${title}"`, `/projects/${projectId}/board`);
    req.app.get('io').to(`user-${assigned_to}`).emit('notification:new');
  }

  logActivity(user.id, 'created', 'task', result.lastInsertRowid, title);
  res.redirect(`/projects/${projectId}/board`);
});

// ─── Task Detail ─────────────────────────────────────
router.get('/:projectId/tasks/:taskId', (req, res) => {
  const db = getDb();
  const task = db.prepare(`
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color,
      c.full_name as creator_name,
      p.name as project_name, p.code as project_code
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN users c ON t.created_by = c.id
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.id = ? AND t.project_id = ?
  `).get(req.params.taskId, req.params.projectId);

  if (!task) return res.status(404).render('error', { user: req.session.user, title: 'Tâche introuvable', message: '', code: 404 });

  const comments = db.prepare(`
    SELECT tc.*, u.full_name, u.avatar_color
    FROM task_comments tc JOIN users u ON tc.user_id = u.id
    WHERE tc.task_id = ? ORDER BY tc.created_at ASC
  `).all(req.params.taskId);

  const developers = db.prepare('SELECT id, full_name, avatar_color FROM users WHERE role IN (?, ?) AND is_active = 1').all('developer', 'admin');

  // If escalated from ticket, get ticket info
  let sourceTicket = null;
  if (task.escalated_from_ticket) {
    sourceTicket = db.prepare('SELECT id, reference, subject FROM tickets WHERE id = ?').get(task.escalated_from_ticket);
  }

  res.render('projects/task-detail', { task, comments, developers, sourceTicket, title: task.title });
});

// ─── Update Task ─────────────────────────────────────
router.post('/:projectId/tasks/:taskId/update', (req, res) => {
  const db = getDb();
  const { title, description, status, priority, type, assigned_to, due_date } = req.body;
  const user = req.session.user;

  const oldTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);

  db.prepare(`
    UPDATE tasks SET title=?, description=?, status=?, priority=?, type=?, assigned_to=?, due_date=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(title, description, status, priority, type, assigned_to || null, due_date || null, req.params.taskId);

  const task = db.prepare(`
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color
    FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?
  `).get(req.params.taskId);

  req.app.get('io').to('role-developer').emit('task:updated', task);

  // Notify if reassigned
  if (assigned_to && parseInt(assigned_to) !== oldTask.assigned_to && parseInt(assigned_to) !== user.id) {
    createNotification(parseInt(assigned_to), 'task_assigned', 'Tâche assignée',
      `${user.full_name} vous a assigné "${title}"`, `/projects/${req.params.projectId}/tasks/${req.params.taskId}`);
    req.app.get('io').to(`user-${assigned_to}`).emit('notification:new');
  }

  // ─── ESCALATION FEEDBACK: notify support when escalated task changes status ───
  if (task.escalated_from_ticket && oldTask.status !== status) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(task.escalated_from_ticket);
    if (ticket) {
      const statusLabels = { backlog: 'Backlog', todo: 'À faire', in_progress: 'En cours', review: 'En revue', done: '✅ Terminé' };
      const statusLabel = statusLabels[status] || status;
      const isDone = (status === 'done');

      // Add automatic message to ticket conversation
      const feedbackMsg = isDone
        ? '✅ L\'équipe développement a résolu le problème lié à ce ticket. La tâche "' + task.title + '" est terminée.'
        : '🔄 La tâche escaladée "' + task.title + '" est passée au statut : ' + statusLabel;

      db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?, ?, ?, 1)').run(ticket.id, user.id, feedbackMsg);
      db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticket.id);

      // Notify support agents (ticket creator + assigned agent)
      const notifTargets = new Set();
      if (ticket.created_by) notifTargets.add(ticket.created_by);
      if (ticket.assigned_to) notifTargets.add(ticket.assigned_to);

      const notifTitle = isDone ? 'Escalade résolue' : 'Escalade mise à jour';
      const notifMessage = isDone
        ? 'La tâche "' + task.title + '" liée au ticket ' + ticket.reference + ' est terminée.'
        : 'La tâche "' + task.title + '" liée au ticket ' + ticket.reference + ' est passée à : ' + statusLabel;

      notifTargets.forEach(targetId => {
        createNotification(targetId, 'escalation', notifTitle, notifMessage, '/tickets/' + ticket.id);
        req.app.get('io').to('user-' + targetId).emit('notification:new');
      });

      // Broadcast to support room
      req.app.get('io').to('role-support').emit('ticket:updated', { ticketId: ticket.id });
      req.app.get('io').to('role-support').emit('ticket:newMessage', {
        ticketId: ticket.id,
        message: { full_name: user.full_name, avatar_color: '#6366f1', role: 'developer', content: feedbackMsg, is_internal: 1 }
      });
    }
  }

  res.redirect(`/projects/${req.params.projectId}/tasks/${req.params.taskId}`);
});

// ─── Delete Task ─────────────────────────────────────
router.post('/:projectId/tasks/:taskId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE id = ? AND project_id = ?').run(req.params.taskId, req.params.projectId);
  res.redirect(`/projects/${req.params.projectId}/board`);
});

module.exports = router;
