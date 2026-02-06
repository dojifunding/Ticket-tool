const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const path = require('path');

const { initDatabase, getDb } = require('./database');
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

// ─── Socket.io ───────────────────────────────────────
const onlineUsers = new Map();

io.on('connection', (socket) => {
  const session = socket.request.session;
  const user = session?.user;

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
    const db = getDb();
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notifId, user.id);
  });

  socket.on('notifications:readAll', () => {
    const db = getDb();
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
  });

  // ─── Task real-time updates ─────────────────────
  socket.on('task:move', (data) => {
    const db = getDb();
    const { taskId, status: newStatus } = data;
    db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, taskId);
    const task = db.prepare('SELECT t.*, u.full_name as assignee_name FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.id = ?').get(taskId);
    io.to('role-developer').emit('task:updated', task);

    // Notify assigned user
    if (task.assigned_to && task.assigned_to !== user.id) {
      const { createNotification } = require('./database');
      createNotification(
        task.assigned_to,
        'task_update',
        'Tâche déplacée',
        `${user.full_name} a déplacé "${task.title}" vers ${newStatus}`,
        `/projects/${task.project_id}/board`
      );
      io.to(`user-${task.assigned_to}`).emit('notification:new');
    }
  });

  // ─── Chat messages in tickets ───────────────────
  socket.on('ticket:message', (data) => {
    const db = getDb();
    const { ticketId, content, isInternal } = data;

    db.prepare(`
      INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal)
      VALUES (?, ?, ?, ?)
    `).run(ticketId, user.id, content, isInternal ? 1 : 0);

    db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(ticketId);

    const message = db.prepare(`
      SELECT tm.*, u.full_name, u.avatar_color, u.role as user_role
      FROM ticket_messages tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.id = last_insert_rowid()
    `).get();

    // Emit to all support + admin
    io.to('role-support').emit('ticket:newMessage', { ticketId, message });

    // Notify assigned agent
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (ticket.assigned_to && ticket.assigned_to !== user.id) {
      const { createNotification } = require('./database');
      createNotification(
        ticket.assigned_to,
        'ticket_message',
        'Nouveau message',
        `${user.full_name} a ajouté un message sur ${ticket.reference}`,
        `/tickets/${ticketId}`
      );
      io.to(`user-${ticket.assigned_to}`).emit('notification:new');
    }
  });

  // ─── Task comments ─────────────────────────────
  socket.on('task:comment', (data) => {
    const db = getDb();
    const { taskId, content } = data;

    db.prepare(`
      INSERT INTO task_comments (task_id, user_id, content)
      VALUES (?, ?, ?)
    `).run(taskId, user.id, content);

    const comment = db.prepare(`
      SELECT tc.*, u.full_name, u.avatar_color
      FROM task_comments tc
      JOIN users u ON tc.user_id = u.id
      WHERE tc.id = last_insert_rowid()
    `).get();

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    io.to('role-developer').emit('task:newComment', { taskId, comment });

    if (task.assigned_to && task.assigned_to !== user.id) {
      const { createNotification } = require('./database');
      createNotification(
        task.assigned_to,
        'task_comment',
        'Nouveau commentaire',
        `${user.full_name} a commenté "${task.title}"`,
        `/projects/${task.project_id}/tasks/${taskId}`
      );
      io.to(`user-${task.assigned_to}`).emit('notification:new');
    }
  });

  // ─── Disconnect ─────────────────────────────────
  socket.on('disconnect', () => {
    onlineUsers.delete(user.id);
    io.emit('users:online', Array.from(onlineUsers.values()).map(u => u.user));
  });
});

// ─── Start Server ────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║         🚀 ProjectHub démarré           ║
  ║                                          ║
  ║   URL : http://localhost:${PORT}            ║
  ║                                          ║
  ║   Comptes de démo :                      ║
  ║   👑 admin    / admin123   (Admin)       ║
  ║   👨‍💻 dev1     / dev123     (Développeur) ║
  ║   👨‍💻 dev2     / dev123     (Développeur) ║
  ║   🎧 support1 / support123 (Support)    ║
  ║   🎧 support2 / support123 (Support)    ║
  ╚══════════════════════════════════════════╝
    `);
  });
})();
