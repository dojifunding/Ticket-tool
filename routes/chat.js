const router = require('express').Router();
const crypto = require('crypto');
const { getDb, generateTicketRef, createNotification } = require('../database');
const { getTranslations } = require('../i18n');
const ai = require('../ai');

// ─── Get or Create Session ───────────────────────────
router.post('/session', (req, res) => {
  const db = getDb();
  const { token, name, email } = req.body;

  if (token) {
    const session = db.prepare('SELECT * FROM chat_sessions WHERE visitor_token = ?').get(token);
    if (session) {
      const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC').all(session.id);
      return res.json({ ok: true, session, messages });
    }
  }

  // Create new session
  const newToken = crypto.randomUUID();
  db.prepare('INSERT INTO chat_sessions (visitor_token, visitor_name, visitor_email) VALUES (?,?,?)')
    .run(newToken, name || null, email || null);

  const session = db.prepare('SELECT * FROM chat_sessions WHERE visitor_token = ?').get(newToken);

  // Send welcome message
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
    .run(session.id, 'ai', 'Assistant', t.chat_welcome_msg);

  const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC').all(session.id);

  res.json({ ok: true, session, messages, isNew: true });
});

// ─── Update visitor info ─────────────────────────────
router.post('/session/update', (req, res) => {
  const db = getDb();
  const { token, name, email } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  db.prepare('UPDATE chat_sessions SET visitor_name=?, visitor_email=?, updated_at=CURRENT_TIMESTAMP WHERE visitor_token=?')
    .run(name || null, email || null, token);

  res.json({ ok: true });
});

// ─── Send Message ────────────────────────────────────
router.post('/message', async (req, res) => {
  const db = getDb();
  const { token, content } = req.body;
  if (!token || !content) return res.status(400).json({ error: 'Missing fields' });

  const session = db.prepare('SELECT * FROM chat_sessions WHERE visitor_token = ?').get(token);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Save visitor message
  db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
    .run(session.id, 'visitor', session.visitor_name || 'Visitor', content);
  db.prepare('UPDATE chat_sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.id);

  // If in human mode, also save to ticket_messages
  if (session.status === 'human' && session.ticket_id) {
    // Use a system user for visitor messages in tickets
    db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?,4,?,0)')
      .run(session.ticket_id, `💬 [${session.visitor_name || 'Visiteur'}]: ${content}`);
    db.prepare('UPDATE tickets SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.ticket_id);

    // Notify support via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.to('role-support').emit('ticket:newMessage', {
        ticketId: session.ticket_id,
        message: {
          full_name: session.visitor_name || 'Visiteur (Livechat)',
          avatar_color: '#10b981',
          role: 'visitor',
          content: `💬 [${session.visitor_name || 'Visiteur'}]: ${content}`,
          is_internal: 0
        }
      });
    }

    // Notify assigned agent
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(session.ticket_id);
    if (ticket?.assigned_to) {
      createNotification(ticket.assigned_to, 'livechat', 'Nouveau message livechat',
        (session.visitor_name || 'Visiteur') + ': ' + content.substring(0, 60),
        '/tickets/' + session.ticket_id);
      if (io) io.to('user-' + ticket.assigned_to).emit('notification:new');
    }

    return res.json({ ok: true, mode: 'human' });
  }

  // AI mode: generate response
  if (session.status === 'ai' && ai.isConfigured()) {
    try {
      // Gather knowledge base context (truncate to avoid timeout)
      const kbEntries = db.prepare('SELECT title, content FROM knowledge_base WHERE is_active=1').all();
      let knowledgeContext = '';
      for (const k of kbEntries) {
        const entry = `[${k.title}]: ${k.content.substring(0, 2000)}\n\n`;
        if (knowledgeContext.length + entry.length > 8000) break; // Cap total context
        knowledgeContext += entry;
      }

      // Gather FAQ articles context (limited)
      const faqArticles = db.prepare('SELECT title, content FROM articles WHERE is_published=1 AND is_public=1 LIMIT 5').all();
      const faqContext = faqArticles.map(a => `[${a.title}]: ${a.content.substring(0, 300)}`).join('\n\n');

      // Get chat history (last 10 messages only)
      const history = db.prepare('SELECT sender_type, content FROM chat_messages WHERE session_id=? ORDER BY created_at DESC LIMIT 10').all(session.id).reverse();

      const lang = req.session?.lang || 'fr';
      console.log('[Chat] AI request — KB:', kbEntries.length, 'entries (' + knowledgeContext.length + ' chars), FAQ:', faqArticles.length, ', History:', history.length);

      const aiResponse = await ai.livechatReply(history, knowledgeContext, faqContext, lang);

      // Save AI response
      db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
        .run(session.id, 'ai', 'Assistant', aiResponse);

      console.log('[Chat] AI responded:', aiResponse.substring(0, 80));
      return res.json({ ok: true, mode: 'ai', aiMessage: { sender_type: 'ai', sender_name: 'Assistant', content: aiResponse, created_at: new Date().toISOString() } });
    } catch (e) {
      console.error('[Chat] AI error:', e.message);
      const lang = req.session?.lang || 'fr';
      const t = getTranslations(lang);
      const fallback = e.message.startsWith('BILLING:')
        ? (lang === 'fr' ? 'Service temporairement indisponible. Souhaitez-vous parler à un agent ?' : 'Service temporarily unavailable. Would you like to speak with an agent?')
        : t.chat_ai_error;
      db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
        .run(session.id, 'ai', 'Assistant', fallback);
      return res.json({ ok: true, mode: 'ai', aiMessage: { sender_type: 'ai', sender_name: 'Assistant', content: fallback, created_at: new Date().toISOString() } });
    }
  }

  // AI not configured — still return a message so the user isn't left hanging
  console.log('[Chat] AI not configured — returning fallback');
  const lang = req.session?.lang || 'fr';
  const fallbackMsg = lang === 'fr'
    ? 'L\'IA n\'est pas configurée pour le moment. Cliquez sur "Parler à un humain" pour contacter un agent.'
    : 'AI is not configured. Click "Talk to a human" to contact an agent.';
  db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
    .run(session.id, 'ai', 'Assistant', fallbackMsg);
  res.json({ ok: true, mode: session.status, aiMessage: { sender_type: 'ai', sender_name: 'Assistant', content: fallbackMsg, created_at: new Date().toISOString() } });
});

// ─── Escalate to Human ──────────────────────────────
router.post('/escalate', (req, res) => {
  const db = getDb();
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const session = db.prepare('SELECT * FROM chat_sessions WHERE visitor_token = ?').get(token);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'human') return res.json({ ok: true, ticketRef: db.prepare('SELECT reference FROM tickets WHERE id=?').get(session.ticket_id)?.reference });

  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  // Create a ticket from this chat
  const reference = generateTicketRef();
  const chatHistory = db.prepare('SELECT sender_type, sender_name, content FROM chat_messages WHERE session_id=? ORDER BY created_at ASC').all(session.id);
  const historyText = chatHistory.map(m => `[${m.sender_name}]: ${m.content}`).join('\n');

  const subject = `💬 Livechat — ${session.visitor_name || 'Visiteur'}`;
  const description = `${t.chat_ticket_desc}\n\n--- ${t.chat_ticket_history} ---\n${historyText}`;

  db.prepare(`INSERT INTO tickets (reference, subject, description, category, client_name, client_email, created_by, status) VALUES (?,?,?,?,?,?,4,'in_progress')`)
    .run(reference, subject, description, 'general', session.visitor_name || null, session.visitor_email || null);

  const ticket = db.prepare('SELECT id FROM tickets WHERE reference=?').get(reference);

  // Update session
  db.prepare('UPDATE chat_sessions SET status=?, ticket_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run('human', ticket.id, session.id);

  // Add system message in chat
  db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
    .run(session.id, 'ai', 'System', t.chat_escalated_msg);

  // Notify support team
  const io = req.app.get('io');
  if (io) io.to('role-support').emit('livechat:new', { ticketId: ticket.id, reference, visitorName: session.visitor_name });

  // Notify all support agents
  const agents = db.prepare("SELECT id FROM users WHERE role IN ('admin','support') AND is_active=1").all();
  agents.forEach(a => {
    createNotification(a.id, 'livechat', '💬 Nouveau livechat',
      (session.visitor_name || 'Visiteur') + ' demande un agent humain',
      '/tickets/' + ticket.id);
    if (io) io.to('user-' + a.id).emit('notification:new');
  });

  res.json({ ok: true, ticketRef: reference });
});

// ─── Poll for new messages (human mode) ──────────────
router.get('/messages/:token', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM chat_sessions WHERE visitor_token = ?').get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const after = req.query.after || '1970-01-01';
  const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id=? AND created_at > ? ORDER BY created_at ASC')
    .all(session.id, after);

  res.json({ ok: true, messages, status: session.status });
});

// ─── Close Chat (visitor-initiated) ──────────────────
router.post('/close', (req, res) => {
  const db = getDb();
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const session = db.prepare('SELECT * FROM chat_sessions WHERE visitor_token = ?').get(token);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Close chat session
  db.prepare('UPDATE chat_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE visitor_token=?')
    .run('closed', token);

  // Add closing system message
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
    .run(session.id, 'ai', 'System', t.chat_closed_by_visitor);

  // If linked to a ticket, close the ticket too
  if (session.ticket_id) {
    db.prepare("UPDATE tickets SET status='closed', resolved_at=COALESCE(resolved_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(session.ticket_id);

    // Add internal note in ticket
    db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?,4,?,1)')
      .run(session.ticket_id, '💬 ' + t.chat_visitor_ended);

    // Notify support via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.to('role-support').emit('ticket:updated', { ticketId: session.ticket_id });
      io.to('role-support').emit('ticket:newMessage', {
        ticketId: session.ticket_id,
        message: { full_name: 'System', avatar_color: '#94a3b8', role: 'system', content: '💬 ' + t.chat_visitor_ended, is_internal: 1 }
      });
    }

    // Notify assigned agent
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(session.ticket_id);
    if (ticket?.assigned_to) {
      createNotification(ticket.assigned_to, 'livechat', '💬 Chat terminé',
        (session.visitor_name || 'Visiteur') + ' a terminé la conversation',
        '/tickets/' + session.ticket_id);
      if (io) io.to('user-' + ticket.assigned_to).emit('notification:new');
    }
  }

  res.json({ ok: true });
});

module.exports = router;
