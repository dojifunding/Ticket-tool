const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const path = require('path');

const { initDatabase, getDb, createNotification } = require('./database');
const { injectUser } = require('./middleware/auth');

// ─── Express App ─────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Session Config ──────────────────────────────────
const sessionMiddleware = session({
  store: new MemoryStore({ checkPeriod: 86400000 }),
  secret: process.env.SESSION_SECRET || 'projecthub-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }
});

app.use(sessionMiddleware);

// Share session with Socket.io
io.engine.use(sessionMiddleware);

// ─── Middleware ───────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(injectUser);

// Make io accessible in routes
app.set('io', io);

// ─── Routes ──────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/projects', require('./routes/projects'));
app.use('/tickets', require('./routes/tickets'));
app.use('/admin', require('./routes/admin'));
app.use('/admin/articles', require('./routes/articles'));
app.use('/help', require('./routes/help'));
app.use('/api', require('./routes/api'));

// ─── Error page ──────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', {
    user: req.session?.user,
    title: 'Page introuvable',
    message: 'La page que vous recherchez n\'existe pas.',
    code: 404
  });
});

// ─── Global error handler ────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Express Error]', err);
  res.status(500).render('error', {
    user: req.session?.user,
    title: 'Erreur serveur',
    message: 'Une erreur interne est survenue.',
    code: 500
  });
});

// ─── Socket.io ───────────────────────────────────────
const onlineUsers = new Map();

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const user = sess?.user;

  if (!user) {
    socket.disconnect();
    return;
  }

  // Track online status
  onlineUsers.set(user.id, { socketId: socket.id, user });
  socket.join(`user-${user.id}`);

  // Join role-based rooms
  socket.join(`role-${user.role}`);
  if (user.role === 'admin') {
    socket.join('role-developer');
    socket.join('role-support');
  }

  // Broadcast online users
  io.emit('users:online', Array.from(onlineUsers.values()).map(u => u.user));

  // ─── Notification handling ──────────────────────
  socket.on('notifications:read', (notifId) => {
    try {
      const db = getDb();
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(Number(notifId), user.id);
    } catch (e) { console.error('[Socket] notifications:read error:', e.message); }
  });

  socket.on('notifications:readAll', () => {
    try {
      const db = getDb();
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
    } catch (e) { console.error('[Socket] notifications:readAll error:', e.message); }
  });

  // ─── Task real-time updates ─────────────────────
  socket.on('task:move', (data) => {
    try {
      const db = getDb();
      const taskId = Number(data.taskId);
      const newStatus = String(data.status);

      db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, taskId);

      const task = db.prepare(`
        SELECT t.*, u.full_name as assignee_name 
        FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id 
        WHERE t.id = ?
      `).get(taskId);

      if (task) {
        io.to('role-developer').emit('task:updated', task);

        if (task.assigned_to && task.assigned_to !== user.id) {
          createNotification(
            task.assigned_to, 'task_update', 'Tâche déplacée',
            user.full_name + ' a déplacé "' + task.title + '" vers ' + newStatus,
            '/projects/' + task.project_id + '/board'
          );
          io.to('user-' + task.assigned_to).emit('notification:new');
        }

        // ─── ESCALATION FEEDBACK ───
        if (task.escalated_from_ticket) {
          try {
            const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(task.escalated_from_ticket);
            if (ticket) {
              const isDone = (newStatus === 'done');
              const statusLabels = { backlog: 'Backlog', todo: 'À faire', in_progress: 'En cours', review: 'En revue', done: '✅ Terminé' };
              const statusLabel = statusLabels[newStatus] || newStatus;

              const feedbackMsg = isDone
                ? '✅ L\'équipe développement a résolu le problème. La tâche "' + task.title + '" est terminée.'
                : '🔄 La tâche escaladée "' + task.title + '" est passée à : ' + statusLabel;

              db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?, ?, ?, 1)').run(ticket.id, user.id, feedbackMsg);
              db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticket.id);

              const targets = new Set();
              if (ticket.created_by) targets.add(ticket.created_by);
              if (ticket.assigned_to) targets.add(ticket.assigned_to);
              targets.forEach(tid => {
                createNotification(tid, 'escalation', isDone ? 'Escalade résolue' : 'Escalade mise à jour',
                  (isDone ? 'Tâche terminée' : 'Statut : ' + statusLabel) + ' — ' + ticket.reference, '/tickets/' + ticket.id);
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
    } catch (e) {
      console.error('[Socket] task:move error:', e.message);
    }
  });

  // ─── Chat messages in tickets ───────────────────
  socket.on('ticket:message', (data) => {
    try {
      const db = getDb();
      const ticketId = Number(data.ticketId);
      const content = String(data.content);
      const isInternal = data.isInternal ? 1 : 0;

      db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?, ?, ?, ?)').run(ticketId, user.id, content, isInternal);
      db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticketId);

      // Get the message we just inserted
      const message = db.prepare(`
        SELECT tm.*, u.full_name, u.avatar_color, u.role as user_role
        FROM ticket_messages tm
        JOIN users u ON tm.user_id = u.id
        WHERE tm.ticket_id = ? AND tm.user_id = ?
        ORDER BY tm.id DESC LIMIT 1
      `).get(ticketId, user.id);

      io.to('role-support').emit('ticket:newMessage', { ticketId, message });

      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
      if (ticket && ticket.assigned_to && ticket.assigned_to !== user.id) {
        createNotification(
          ticket.assigned_to, 'ticket_message', 'Nouveau message',
          user.full_name + ' a ajouté un message sur ' + ticket.reference,
          '/tickets/' + ticketId
        );
        io.to('user-' + ticket.assigned_to).emit('notification:new');
      }
    } catch (e) {
      console.error('[Socket] ticket:message error:', e.message);
    }
  });

  // ─── Task comments ─────────────────────────────
  socket.on('task:comment', (data) => {
    try {
      const db = getDb();
      const taskId = Number(data.taskId);
      const content = String(data.content);

      db.prepare('INSERT INTO task_comments (task_id, user_id, content) VALUES (?, ?, ?)').run(taskId, user.id, content);

      // Get the comment we just inserted
      const comment = db.prepare(`
        SELECT tc.*, u.full_name, u.avatar_color
        FROM task_comments tc
        JOIN users u ON tc.user_id = u.id
        WHERE tc.task_id = ? AND tc.user_id = ?
        ORDER BY tc.id DESC LIMIT 1
      `).get(taskId, user.id);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      io.to('role-developer').emit('task:newComment', { taskId, comment });

      if (task && task.assigned_to && task.assigned_to !== user.id) {
        createNotification(
          task.assigned_to, 'task_comment', 'Nouveau commentaire',
          user.full_name + ' a commenté "' + task.title + '"',
          '/projects/' + task.project_id + '/tasks/' + taskId
        );
        io.to('user-' + task.assigned_to).emit('notification:new');
      }
    } catch (e) {
      console.error('[Socket] task:comment error:', e.message);
    }
  });

  // ─── Disconnect ─────────────────────────────────
  socket.on('disconnect', () => {
    onlineUsers.delete(user.id);
    io.emit('users:online', Array.from(onlineUsers.values()).map(u => u.user));
  });
});

// ─── Catch uncaught errors to prevent crashes ────────
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

// ─── Start Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║         🚀 ProjectHub démarré           ║
  ║   URL : http://localhost:${PORT}            ║
  ╚══════════════════════════════════════════╝
    `);
  });
})();
