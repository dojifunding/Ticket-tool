// ═══════════════════════════════════════════════════════
//  ProjectHub SaaS — Multi-Tenant Server
// ═══════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const path = require('path');

const { initMasterDatabase, getTenantDb, requestStore, getDb, createNotification } = require('./database');
const { injectUser, requireOnboarding, requireActiveTenant } = require('./middleware/auth');
const { tenantMiddleware } = require('./middleware/tenant');

// ─── Express App ─────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Session Config ──────────────────────────────────
const sessionMiddleware = session({
  store: new MemoryStore({ checkPeriod: 86400000 }),
  secret: process.env.SESSION_SECRET || 'projecthub-saas-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// ─── Middleware ───────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// 1) Inject user + translations (always runs)
app.use(injectUser);

// ─── Super Admin routes (no tenant context needed) ──
app.use('/superadmin', require('./routes/superadmin'));

// 2) Tenant middleware (wraps request in AsyncLocalStorage)
app.use(tenantMiddleware);

// Make io accessible in routes
app.set('io', io);

// ─── Public Routes (no tenant needed) ────────────────
app.use('/', require('./routes/auth'));

// ─── Onboarding (tenant needed but no onboarding check) ──
app.use('/onboarding', require('./routes/onboarding'));

// ─── Protected Routes (tenant + auth + onboarding) ───
app.use(requireOnboarding);
app.use(requireActiveTenant);

app.use('/projects', require('./routes/projects'));
app.use('/tickets', require('./routes/tickets'));
app.use('/admin/articles', require('./routes/articles'));
app.use('/admin/knowledge', require('./routes/knowledge'));
app.use('/admin', require('./routes/admin'));
app.use('/help', require('./routes/help'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api', require('./routes/api'));

// ─── Account Routes ──────────────────────────────────
app.get('/account/upgrade', (req, res) => {
  const t = res.locals.t;
  res.render('error', {
    user: req.session?.user,
    title: t.trial_expired_title || 'Essai expiré',
    message: t.trial_expired_message || 'Votre essai gratuit de 7 jours est terminé. Contactez-nous pour continuer à utiliser ProjectHub.',
    code: 402
  });
});

// ─── Error page ──────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', {
    user: req.session?.user,
    title: 'Page introuvable',
    message: 'La page que vous recherchez n\'existe pas.',
    code: 404
  });
});

app.use((err, req, res, next) => {
  console.error('[Express Error]', err);
  res.status(500).render('error', {
    user: req.session?.user,
    title: 'Erreur serveur',
    message: 'Une erreur interne est survenue.',
    code: 500
  });
});

// ─── Socket.io (tenant-aware) ───────────────────────
const onlineUsers = new Map();
const livechatSockets = new Map();

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const user = sess?.user;
  const tenantId = sess?.tenantId;

  // ─── Livechat visitor (unauthenticated) ──────────
  socket.on('livechat:join', (token) => {
    if (!token) return;
    livechatSockets.set(token, socket.id);
    socket.join(`livechat-${token}`);
  });

  socket.on('livechat:leave', (token) => {
    livechatSockets.delete(token);
    socket.leave(`livechat-${token}`);
  });

  // ─── Staff: reply to livechat from ticket ────────
  socket.on('livechat:agentReply', (data) => {
    if (!user || !tenantId) return;
    requestStore.run({ db: getTenantDb(tenantId), tenantId }, () => {
      try {
        const db = getDb();
        const { ticketId, content } = data;
        const chatSession = db.prepare('SELECT * FROM chat_sessions WHERE ticket_id = ? AND status = ?').get(ticketId, 'human');
        if (!chatSession) return;

        db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
          .run(chatSession.id, 'agent', user.full_name, content);

        io.to(`livechat-${chatSession.visitor_token}`).emit('livechat:newMessage', {
          sender_type: 'agent', sender_name: user.full_name, content, created_at: new Date().toISOString()
        });
      } catch (e) { console.error('[Socket] livechat:agentReply error:', e.message); }
    });
  });

  // ─── Authenticated user handlers ─────────────────
  if (!user || !tenantId) return;

  onlineUsers.set(user.id + '-' + tenantId, { socketId: socket.id, user });
  socket.join(`user-${user.id}`);
  socket.join(`role-${user.role}`);
  socket.join(`tenant-${tenantId}`);
  if (user.role === 'admin') { socket.join('role-developer'); socket.join('role-support'); }

  io.to(`tenant-${tenantId}`).emit('users:online',
    Array.from(onlineUsers.values()).filter(u => u.user).map(u => u.user)
  );

  // ─── Notifications ────────────────────────────
  socket.on('notifications:read', (notifId) => {
    requestStore.run({ db: getTenantDb(tenantId), tenantId }, () => {
      try { getDb().prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(Number(notifId), user.id); }
      catch (e) { console.error('[Socket] notifications:read error:', e.message); }
    });
  });

  socket.on('notifications:readAll', () => {
    requestStore.run({ db: getTenantDb(tenantId), tenantId }, () => {
      try { getDb().prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id); }
      catch (e) { console.error('[Socket] notifications:readAll error:', e.message); }
    });
  });

  // ─── Task real-time updates ─────────────────────
  socket.on('task:move', (data) => {
    requestStore.run({ db: getTenantDb(tenantId), tenantId }, () => {
      try {
        const db = getDb();
        const taskId = Number(data.taskId);
        const newStatus = String(data.status);

        db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, taskId);
        const task = db.prepare('SELECT t.*, u.full_name as assignee_name FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?').get(taskId);

        if (task) {
          io.to('role-developer').emit('task:updated', task);

          if (task.assigned_to && task.assigned_to !== user.id) {
            createNotification(task.assigned_to, 'task_update', 'Tâche déplacée',
              user.full_name + ' a déplacé "' + task.title + '" vers ' + newStatus,
              '/projects/' + task.project_id + '/board');
            io.to('user-' + task.assigned_to).emit('notification:new');
          }

          // Escalation feedback
          if (task.escalated_from_ticket) {
            try {
              const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(task.escalated_from_ticket);
              if (ticket) {
                const isDone = (newStatus === 'done');
                const statusLabels = { backlog:'Backlog', todo:'À faire', in_progress:'En cours', review:'En revue', done:'✅ Terminé' };
                const feedbackMsg = isDone
                  ? '✅ L\'équipe développement a résolu le problème. La tâche "' + task.title + '" est terminée.'
                  : '🔄 La tâche escaladée "' + task.title + '" est passée à : ' + (statusLabels[newStatus] || newStatus);

                db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?,?,?,1)').run(ticket.id, user.id, feedbackMsg);
                db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticket.id);

                const targets = new Set();
                if (ticket.created_by) targets.add(ticket.created_by);
                if (ticket.assigned_to) targets.add(ticket.assigned_to);
                targets.forEach(tid => {
                  createNotification(tid, 'escalation', isDone ? 'Escalade résolue' : 'Escalade mise à jour',
                    (isDone ? 'Tâche terminée' : 'Statut : ' + (statusLabels[newStatus] || newStatus)) + ' — ' + ticket.reference,
                    '/tickets/' + ticket.id);
                  io.to('user-' + tid).emit('notification:new');
                });

                io.to('role-support').emit('ticket:updated', { ticketId: ticket.id });
                io.to('role-support').emit('ticket:newMessage', {
                  ticketId: ticket.id,
                  message: { full_name: user.full_name, avatar_color: '#6366f1', role: 'developer', content: feedbackMsg, is_internal: 1 }
                });
              }
            } catch (esc) { console.error('[Socket] escalation feedback error:', esc.message); }
          }
        }
      } catch (e) { console.error('[Socket] task:move error:', e.message); }
    });
  });

  // ─── Ticket messages ────────────────────────────
  socket.on('ticket:message', (data) => {
    if (!user) return;
    requestStore.run({ db: getTenantDb(tenantId), tenantId }, () => {
      try {
        const db = getDb();
        const ticketId = Number(data.ticketId);
        const content = String(data.content);
        const isInternal = data.isInternal ? 1 : 0;

        db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?,?,?,?)').run(ticketId, user.id, content, isInternal);
        db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticketId);

        const message = db.prepare('SELECT tm.*, u.full_name, u.avatar_color, u.role as user_role FROM ticket_messages tm JOIN users u ON tm.user_id = u.id WHERE tm.ticket_id = ? AND tm.user_id = ? ORDER BY tm.id DESC LIMIT 1').get(ticketId, user.id);
        io.to('role-support').emit('ticket:newMessage', { ticketId, message });

        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
        if (ticket && ticket.assigned_to && ticket.assigned_to !== user.id) {
          createNotification(ticket.assigned_to, 'ticket_message', 'Nouveau message',
            user.full_name + ' a ajouté un message sur ' + ticket.reference, '/tickets/' + ticketId);
          io.to('user-' + ticket.assigned_to).emit('notification:new');
        }

        // Livechat relay
        if (!isInternal) {
          const chatSession = db.prepare('SELECT * FROM chat_sessions WHERE ticket_id = ? AND status = ?').get(ticketId, 'human');
          if (chatSession) {
            db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
              .run(chatSession.id, 'agent', user.full_name, content);
            io.to(`livechat-${chatSession.visitor_token}`).emit('livechat:newMessage', {
              sender_type: 'agent', sender_name: user.full_name, content, created_at: new Date().toISOString()
            });
          }
        }
      } catch (e) { console.error('[Socket] ticket:message error:', e.message); }
    });
  });

  // ─── Task comments ─────────────────────────────
  socket.on('task:comment', (data) => {
    requestStore.run({ db: getTenantDb(tenantId), tenantId }, () => {
      try {
        const db = getDb();
        const taskId = Number(data.taskId);
        const content = String(data.content);

        db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?,?,?)').run(taskId, user.id, content);
        const comment = db.prepare('SELECT tc.*, u.full_name, u.avatar_color FROM task_comments tc JOIN users u ON tc.user_id = u.id WHERE tc.task_id = ? AND tc.user_id = ? ORDER BY tc.id DESC LIMIT 1').get(taskId, user.id);
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        io.to('role-developer').emit('task:newComment', { taskId, comment });

        if (task && task.assigned_to && task.assigned_to !== user.id) {
          createNotification(task.assigned_to, 'task_comment', 'Nouveau commentaire',
            user.full_name + ' a commenté "' + task.title + '"', '/projects/' + task.project_id + '/tasks/' + taskId);
          io.to('user-' + task.assigned_to).emit('notification:new');
        }
      } catch (e) { console.error('[Socket] task:comment error:', e.message); }
    });
  });

  // ─── Disconnect ─────────────────────────────────
  socket.on('disconnect', () => {
    if (user && tenantId) {
      onlineUsers.delete(user.id + '-' + tenantId);
      io.to(`tenant-${tenantId}`).emit('users:online',
        Array.from(onlineUsers.values()).filter(u => u.user).map(u => u.user)
      );
    }
    for (const [token, sid] of livechatSockets.entries()) {
      if (sid === socket.id) { livechatSockets.delete(token); break; }
    }
  });
});

// ─── Catch uncaught errors ──────────────────────────
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED REJECTION]', err); });

// ─── Start Server ───────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await initMasterDatabase();
  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║       🚀 ProjectHub SaaS démarré            ║
  ║   URL : http://localhost:${PORT}                ║
  ║   Mode : Multi-tenant                        ║
  ╚══════════════════════════════════════════════╝
    `);
    // Log AI provider config
    try { require('./ai').logConfig(); } catch (e) { console.log('[AI] Not configured'); }
  });
})();
