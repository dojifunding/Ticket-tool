const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { isAuthenticated, isAdmin } = require('../middleware/auth');

router.use(isAuthenticated, isAdmin);

// ─── Admin Dashboard ─────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();

  const stats = {
    users: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get().c,
    projects: db.prepare('SELECT COUNT(*) as c FROM projects WHERE status = ?').get('active').c,
    activeTasks: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status NOT IN (?, ?)').get('done', 'backlog').c,
    openTickets: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status NOT IN (?, ?)').get('resolved', 'closed').c,
    urgentTickets: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE priority = ? AND status NOT IN (?, ?)').get('urgent', 'resolved', 'closed').c,
    escalations: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE type = ? AND status != ?').get('escalation', 'done').c,
  };

  const recentActivity = db.prepare(`
    SELECT al.*, u.full_name, u.avatar_color, u.role
    FROM activity_log al
    JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT 20
  `).all();

  const ticketsByStatus = {
    open: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('open').c,
    in_progress: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('in_progress').c,
    waiting: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('waiting').c,
    resolved: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('resolved').c,
    closed: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('closed').c,
  };

  const tasksByStatus = {
    backlog: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('backlog').c,
    todo: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('todo').c,
    in_progress: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('in_progress').c,
    review: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('review').c,
    done: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('done').c,
  };

  res.render('admin/dashboard', { stats, recentActivity, ticketsByStatus, tasksByStatus, title: 'Admin — Dashboard' });
});

// ─── User Management ─────────────────────────────────
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM tasks WHERE assigned_to = u.id AND status != 'done') as active_tasks,
      (SELECT COUNT(*) FROM tickets WHERE assigned_to = u.id AND status NOT IN ('resolved','closed')) as active_tickets
    FROM users u ORDER BY u.role, u.full_name
  `).all();

  res.render('admin/users', { users, title: 'Gestion des utilisateurs' });
});

// ─── Create User ─────────────────────────────────────
router.post('/users/create', (req, res) => {
  const db = getDb();
  const { username, email, password, full_name, role } = req.body;
  const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (username, email, password, full_name, role, avatar_color)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, email, hash, full_name, role, color);
    res.redirect('/admin/users');
  } catch (err) {
    res.redirect('/admin/users?error=duplicate');
  }
});

// ─── Toggle User Active ──────────────────────────────
router.post('/users/:id/toggle', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user && user.id !== req.session.user.id) {
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(user.is_active ? 0 : 1, req.params.id);
  }
  res.redirect('/admin/users');
});

module.exports = router;
