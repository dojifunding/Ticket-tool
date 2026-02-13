const router = require('express').Router();
const { getDb, generateTicketRef, logActivity, createNotification, getSetting } = require('../database');
const { isAuthenticated, isSupport } = require('../middleware/auth');

router.use(isAuthenticated, isSupport);

// ─── Tickets List ────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const { status, priority, assigned, search } = req.query;

  let sql = `
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color,
      c.full_name as creator_name, co.name as company_name, co.brand_color as company_color
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN users c ON t.created_by = c.id
    LEFT JOIN companies co ON t.company_id = co.id
    WHERE 1=1
  `;
  const params = [];

  // By default, hide resolved/closed (archived) tickets
  if (status === 'resolved') { sql += ' AND t.status = ?'; params.push('resolved'); }
  else if (status === 'closed') { sql += ' AND t.status = ?'; params.push('closed'); }
  else if (status === 'archived') { sql += ' AND t.status IN (?, ?)'; params.push('resolved', 'closed'); }
  else if (status && status !== 'all') { sql += ' AND t.status = ?'; params.push(status); }
  else if (!status || status === 'all') { sql += ' AND t.status NOT IN (?, ?)'; params.push('resolved', 'closed'); }

  if (priority && priority !== 'all') { sql += ' AND t.priority = ?'; params.push(priority); }
  if (assigned === 'me') { sql += ' AND t.assigned_to = ?'; params.push(req.session.user.id); }
  if (assigned === 'unassigned') { sql += ' AND t.assigned_to IS NULL'; }
  if (search) { sql += ' AND (t.subject LIKE ? OR t.reference LIKE ? OR t.client_name LIKE ? OR co.name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }

  // Company filter
  if (req.query.company === 'none') { sql += ' AND t.company_id IS NULL'; }
  else if (req.query.company && req.query.company !== 'all') { sql += ' AND t.company_id = ?'; params.push(parseInt(req.query.company)); }

  sql += ' ORDER BY CASE t.priority WHEN "urgent" THEN 1 WHEN "high" THEN 2 WHEN "medium" THEN 3 ELSE 4 END, t.updated_at DESC';

  const tickets = db.prepare(sql).all(...params);
  const agents = db.prepare('SELECT id, full_name, avatar_color FROM users WHERE role IN (?, ?) AND is_active = 1').all('support', 'admin');
  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();

  // Stats count all tickets (including archived)
  const stats = {
    total: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status NOT IN (?, ?)').get('resolved', 'closed').c,
    open: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('open').c,
    in_progress: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('in_progress').c,
    waiting: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('waiting').c,
    archived: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status IN (?, ?)').get('resolved', 'closed').c,
  };

  res.render('tickets/index', { tickets, agents, companies, stats, filters: req.query, title: 'Tickets' });
});

// ─── New Ticket Form ─────────────────────────────────
router.get('/new', (req, res) => {
  const db = getDb();
  const agents = db.prepare('SELECT id, full_name FROM users WHERE role IN (?, ?) AND is_active = 1').all('support', 'admin');
  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();
  res.render('tickets/form', { ticket: null, agents, companies, title: 'Nouveau Ticket' });
});

// ─── Create Ticket ───────────────────────────────────
router.post('/new', (req, res) => {
  const db = getDb();
  const { subject, description, priority, category, client_name, client_email, assigned_to, company_id } = req.body;
  const user = req.session.user;
  const reference = generateTicketRef();

  const result = db.prepare(`
    INSERT INTO tickets (reference, subject, description, priority, category, client_name, client_email, assigned_to, company_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reference, subject, description, priority, category, client_name, client_email, assigned_to || null, company_id || null, user.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid);

  // Real-time broadcast
  req.app.get('io').to('role-support').emit('ticket:created', ticket);

  // Notify assigned agent
  if (assigned_to && parseInt(assigned_to) !== user.id) {
    createNotification(parseInt(assigned_to), 'ticket_assigned', 'Ticket assigné',
      `${user.full_name} vous a assigné le ticket ${reference}`, `/tickets/${result.lastInsertRowid}`);
    req.app.get('io').to(`user-${assigned_to}`).emit('notification:new');
  }

  // Notify all support
  const supporters = db.prepare('SELECT id FROM users WHERE role IN (?, ?) AND id != ?').all('support', 'admin', user.id);
  supporters.forEach(s => {
    if (parseInt(assigned_to) !== s.id) {
      createNotification(s.id, 'ticket_created', 'Nouveau ticket',
        `${reference} — ${subject}`, `/tickets/${result.lastInsertRowid}`);
      req.app.get('io').to(`user-${s.id}`).emit('notification:new');
    }
  });

  logActivity(user.id, 'created', 'ticket', result.lastInsertRowid, reference);
  res.redirect(`/tickets/${result.lastInsertRowid}`);
});

// ─── Ticket Detail ───────────────────────────────────
router.get('/:id', (req, res) => {
  const db = getDb();
  const ticket = db.prepare(`
    SELECT t.*, u.full_name as assignee_name, u.avatar_color as assignee_color,
      c.full_name as creator_name, co.name as company_name, co.brand_color as company_color, co.slug as company_slug, co.logo_url as company_logo
    FROM tickets t
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN users c ON t.created_by = c.id
    LEFT JOIN companies co ON t.company_id = co.id
    WHERE t.id = ?
  `).get(req.params.id);

  if (!ticket) return res.status(404).render('error', { user: req.session.user, title: 'Ticket introuvable', message: '', code: 404 });

  const messages = db.prepare(`
    SELECT tm.*, 
      COALESCE(u.full_name, '💬 Visiteur') as full_name, 
      COALESCE(u.avatar_color, '#10b981') as avatar_color, 
      COALESCE(u.role, 'visitor') as user_role
    FROM ticket_messages tm
    LEFT JOIN users u ON tm.user_id = u.id
    WHERE tm.ticket_id = ?
    ORDER BY tm.created_at ASC
  `).all(req.params.id);

  const agents = db.prepare('SELECT id, full_name, avatar_color FROM users WHERE role IN (?, ?) AND is_active = 1').all('support', 'admin');

  // Get escalation info if exists
  let escalatedTask = null;
  if (ticket.escalated_to_task) {
    escalatedTask = db.prepare(`
      SELECT t.*, p.name as project_name, p.id as project_id
      FROM tasks t JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `).get(ticket.escalated_to_task);
  }

  // Projects for escalation dropdown
  const projects = db.prepare('SELECT id, name, code FROM projects WHERE status = ?').all('active');

  // Check if ticket has a livechat session
  const chatSession = db.prepare('SELECT * FROM chat_sessions WHERE ticket_id = ?').get(ticket.id);

  // Escalation settings
  const escalationEnabled = getSetting('escalation_enabled', '0') === '1';
  const escalationCategories = getSetting('escalation_categories', 'bug,feature_request').split(',').filter(c => c.trim());
  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();

  res.render('tickets/detail', { ticket, messages, agents, escalatedTask, projects, chatSession: chatSession || null, lang: req.session?.lang || 'fr', escalationEnabled, escalationCategories, companies, title: `${ticket.reference} — ${ticket.subject}` });
});

// ─── Update Ticket ───────────────────────────────────
router.post('/:id/update', (req, res) => {
  const db = getDb();
  const { status, priority, assigned_to, category, company_id } = req.body;
  const user = req.session.user;
  const oldTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);

  if (!oldTicket) return res.redirect('/tickets');

  let resolvedAt = oldTicket.resolved_at;
  if ((status === 'resolved' || status === 'closed') && !resolvedAt) {
    resolvedAt = new Date().toISOString();
  } else if (status !== 'resolved' && status !== 'closed') {
    resolvedAt = null;
  }

  db.prepare(`
    UPDATE tickets SET status=?, priority=?, assigned_to=?, category=?, company_id=?, resolved_at=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, priority, assigned_to || null, category, company_id || null, resolvedAt, req.params.id);

  const ticket = db.prepare('SELECT t.*, u.full_name as assignee_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?').get(req.params.id);
  const io = req.app.get('io');
  io.to('role-support').emit('ticket:updated', ticket);

  // ─── LIVECHAT: Close chat session when ticket is closed/resolved ───
  if (status === 'closed' || status === 'resolved') {
    const db2 = getDb();
    const chatSession = db2.prepare('SELECT * FROM chat_sessions WHERE ticket_id = ? AND status != ?').get(req.params.id, 'closed');
    if (chatSession) {
      db2.prepare('UPDATE chat_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run('closed', chatSession.id);

      // Add system message in chat
      const lang = req.session?.lang || 'fr';
      const { getTranslations } = require('../i18n');
      const t2 = getTranslations(lang);
      db2.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
        .run(chatSession.id, 'ai', 'System', t2.chat_closed_by_agent);

      // Push close event to visitor
      io.to(`livechat-${chatSession.visitor_token}`).emit('livechat:closed', {
        message: t2.chat_closed_by_agent
      });
    }
  }

  // Notify on reassignment
  if (assigned_to && parseInt(assigned_to) !== oldTicket.assigned_to && parseInt(assigned_to) !== user.id) {
    createNotification(parseInt(assigned_to), 'ticket_assigned', 'Ticket assigné',
      `${user.full_name} vous a assigné ${oldTicket.reference}`, `/tickets/${req.params.id}`);
    req.app.get('io').to(`user-${assigned_to}`).emit('notification:new');
  }

  res.redirect(`/tickets/${req.params.id}`);
});

// ─── ESCALATE TO DEV TEAM ────────────────────────────
router.post('/:id/escalate', (req, res) => {
  const db = getDb();
  const { project_id, title, description, priority, assigned_to } = req.body;
  const user = req.session.user;
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);

  if (!ticket) return res.redirect('/tickets');

  // Create task linked to ticket
  const taskResult = db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, type, assigned_to, created_by, escalated_from_ticket)
    VALUES (?, ?, ?, 'todo', ?, 'escalation', ?, ?, ?)
  `).run(parseInt(project_id), title || `[Escalade] ${ticket.subject}`, description || `Escaladé depuis le ticket ${ticket.reference}.\n\n${ticket.description}`,
    priority || ticket.priority === 'urgent' ? 'critical' : ticket.priority, assigned_to || null, user.id, ticket.id);

  // Link ticket to task
  db.prepare('UPDATE tickets SET escalated_to_task = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(taskResult.lastInsertRowid, ticket.id);

  // Add internal message
  db.prepare(`
    INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal)
    VALUES (?, ?, ?, 1)
  `).run(ticket.id, user.id, `🔺 Ce ticket a été escaladé à l'équipe de développement (Projet: ${project_id})`);

  // Notify all developers
  const devs = db.prepare('SELECT id FROM users WHERE role IN (?, ?)').all('developer', 'admin');
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(parseInt(project_id));
  devs.forEach(dev => {
    createNotification(dev.id, 'escalation', '🔺 Escalade support',
      `${user.full_name} a escaladé le ticket ${ticket.reference} vers "${project.name}"`,
      `/projects/${project_id}/tasks/${taskResult.lastInsertRowid}`);
    req.app.get('io').to(`user-${dev.id}`).emit('notification:new');
    req.app.get('io').to(`user-${dev.id}`).emit('escalation:new', {
      ticket, taskId: taskResult.lastInsertRowid, projectId: parseInt(project_id)
    });
  });

  logActivity(user.id, 'escalated', 'ticket', ticket.id, `→ Task #${taskResult.lastInsertRowid}`);
  res.redirect(`/tickets/${req.params.id}`);
});

module.exports = router;
