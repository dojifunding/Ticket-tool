const router = require('express').Router();
const crypto = require('crypto');
const { getDb, generateTicketRef, createNotification, getSetting } = require('../database');
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

  // ─── Auto Pattern Detection (async, every 50 visitor messages) ───
  try {
    const msgCount = db.prepare("SELECT COUNT(*) as c FROM chat_messages WHERE sender_type='visitor'").get().c;
    if (msgCount > 0 && msgCount % 50 === 0 && ai.isConfigured()) {
      const pendingCount = db.prepare("SELECT COUNT(*) as c FROM ai_article_suggestions WHERE status='pending'").get().c;
      if (pendingCount < 10) { // Don't pile up too many suggestions
        console.log('[Chat] Auto-triggering pattern analysis (message #' + msgCount + ')');
        // Fire and forget — don't wait
        (async () => {
          try {
            const recentChats = db.prepare("SELECT content FROM chat_messages WHERE sender_type='visitor' AND created_at > datetime('now','-30 days') ORDER BY created_at DESC LIMIT 100").all();
            const recentTickets = db.prepare("SELECT subject, description FROM tickets WHERE created_at > datetime('now','-30 days') ORDER BY created_at DESC LIMIT 50").all();
            const questions = [
              ...recentTickets.map(t => `[Ticket] ${t.subject}: ${(t.description||'').substring(0, 150)}`),
              ...recentChats.map(c => `[Chat] ${c.content.substring(0, 150)}`)
            ];
            if (questions.length < 5) return;
            const existingTitles = db.prepare("SELECT title FROM articles WHERE is_published=1").all().map(a => a.title);
            const pendingTitles = db.prepare("SELECT title FROM ai_article_suggestions WHERE status='pending'").all().map(s => s.title);
            const suggestions = await ai.analyzeTicketPatterns(questions, [...existingTitles, ...pendingTitles]);
            let saved = 0;
            for (const s of suggestions) {
              if (!s.title || !s.content) continue;
              db.prepare("INSERT INTO ai_article_suggestions (title,content,excerpt,category_suggestion,source_type,source_details) VALUES(?,?,?,?,'auto_pattern',?)").run(
                s.title, s.content, s.excerpt || '', s.category_suggestion || 'general',
                JSON.stringify({ frequency: s.frequency || 0, sample_questions: s.sample_questions || [] })
              );
              saved++;
            }
            if (saved > 0) {
              const admins = db.prepare("SELECT id FROM users WHERE role IN('admin','support') AND is_active=1").all();
              for (const admin of admins) {
                db.prepare("INSERT INTO notifications (user_id,type,title,message,link) VALUES(?,?,?,?,?)").run(
                  admin.id, 'ai_suggestion',
                  `🤖 ${saved} article(s) FAQ suggéré(s)`,
                  `L'IA a détecté ${saved} sujet(s) récurrent(s). Revoyez les suggestions.`,
                  '/admin/articles/suggestions'
                );
              }
              console.log('[Chat] Auto-pattern: saved', saved, 'suggestions');
            }
          } catch (err) { console.error('[Chat] Auto-pattern error:', err.message); }
        })();
      }
    }
  } catch (e) { /* ignore pattern detection errors */ }
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
      // ─── FAQ-First Search: try to answer from existing articles (FREE) ───
      const faqFirst = getSetting('ai_livechat_faq_first', '1') === '1';

      // Shared stopwords list for both FAQ-first and KB search
      const stopwords = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','shall','should','may','might','must','can','could','i','me','my','we','our','you','your','he','she','it','they','them','their','this','that','what','which','who','how','when','where','why','in','on','at','to','for','with','from','of','and','or','but','not','no','if','so','as','by','up','out','about','into','les','la','le','un','une','des','du','de','est','sont','pour','dans','sur','avec','que','qui','quoi','quel','quelle','comment','pas','ne','se','ce','ces','mon','ton','son','nous','vous','ils','elles','et','ou','mais','donc','car','je','tu','il','elle','on','chez','par','en','au','aux','quelles','quels','phidias','propfirm','trading','trader','traders','compte','comptes','account','accounts']);

      // Extract meaningful keywords (no stopwords, no brand names)
      const userQ = content.toLowerCase().replace(/[^a-zà-ÿ0-9\s]/gi, ' ');
      const qKeywords = userQ.split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));

      if (faqFirst && qKeywords.length > 0) {
        const faqArticles = db.prepare('SELECT id, title, slug, content, excerpt FROM articles WHERE is_published=1 AND is_public=1').all();
        let bestMatch = null;
        let bestScore = 0;

        for (const faq of faqArticles) {
          const titleLower = faq.title.toLowerCase();
          const fullLower = (titleLower + ' ' + (faq.excerpt || '') + ' ' + faq.content).toLowerCase();
          let score = 0;
          let titleHits = 0;

          for (const w of qKeywords) {
            if (titleLower.includes(w)) { score += 3; titleHits++; }
            else if (fullLower.includes(w)) { score += 1; }
          }

          // Need at least 1 keyword in title AND normalized score > threshold
          const normalized = score / (qKeywords.length * 3);
          if (titleHits >= 1 && normalized > 0.3 && score > bestScore) {
            bestScore = score;
            bestMatch = faq;
          }
        }

        // High confidence threshold: need significant keyword overlap
        if (bestMatch && bestScore >= 4 && qKeywords.length >= 2) {
          const lang = req.session?.lang || 'fr';
          const articleUrl = '/help/article/' + bestMatch.slug;
          const faqReply = lang === 'fr'
            ? `D'après notre FAQ :\n\n**${bestMatch.title}**\n\n${bestMatch.content.substring(0, 800)}\n\n🔗 [Lire l'article complet](${articleUrl})`
            : `From our FAQ:\n\n**${bestMatch.title}**\n\n${bestMatch.content.substring(0, 800)}\n\n🔗 [Read the full article](${articleUrl})`;

          db.prepare('INSERT INTO chat_messages (session_id, sender_type, sender_name, content) VALUES (?,?,?,?)')
            .run(session.id, 'ai', 'Assistant', faqReply);

          console.log('[Chat] FAQ-first match! Score:', bestScore, '| Keywords:', qKeywords.join(','), '→', bestMatch.title, '(AI call saved)');
          return res.json({ ok: true, mode: 'faq', aiMessage: { sender_type: 'ai', sender_name: 'Assistant', content: faqReply, created_at: new Date().toISOString() } });
        }

        if (bestMatch) {
          console.log('[Chat] FAQ-first: best candidate "' + bestMatch.title + '" score=' + bestScore + ' but below threshold → falling through to AI');
        }
      }

      // ─── Smart KB Context: section-based search (simple RAG) ───
      const kbEntries = db.prepare('SELECT title, content FROM knowledge_base WHERE is_active=1').all();
      const userQuestion = content.toLowerCase();

      // Extract keywords from user question (reuse stopwords from above)
      const keywords = userQuestion
        .replace(/[^a-zà-ÿ0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !stopwords.has(w));

      let knowledgeContext = '';

      if (kbEntries.length > 0) {
        const scoredChunks = [];

        for (const kb of kbEntries) {
          if (kb.content.length <= 2000) {
            // Short entry: use as-is
            const lower = (kb.title + ' ' + kb.content).toLowerCase();
            const score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 1 : 0), 0);
            scoredChunks.push({ text: `[${kb.title}]:\n${kb.content}`, score: score || 0.05, len: kb.content.length });
            continue;
          }

          // ─── Split long content into MAJOR numbered sections ───
          // Match patterns like "1. Title", "20. 25K Static", "## Title"
          const sectionRegex = /\n(?=\d{1,2}\.\s+[A-Z0-9★◆■])|(?=\n#{1,3}\s)/g;
          const rawSections = kb.content.split(sectionRegex).filter(s => s.trim().length > 20);

          // If the split didn't work well (only 1 section), try alternative split
          const sections = rawSections.length > 1 ? rawSections : kb.content.split(/\n\n(?=[A-Z0-9#★◆■])/).filter(s => s.trim().length > 20);

          // Merge very small consecutive sections (< 200 chars)
          const mergedSections = [];
          let buffer = '';
          for (const sec of sections) {
            if (buffer.length > 0 && buffer.length + sec.length < 800) {
              buffer += '\n\n' + sec;
            } else {
              if (buffer) mergedSections.push(buffer);
              buffer = sec;
            }
          }
          if (buffer) mergedSections.push(buffer);

          for (const section of mergedSections) {
            const lower = (kb.title + ' ' + section).toLowerCase();

            // Score: count keyword matches + bonus for matches in first 100 chars (heading)
            let score = 0;
            const heading = lower.substring(0, 150);
            for (const kw of keywords) {
              if (heading.includes(kw)) score += 3; // Strong match in heading
              else if (lower.includes(kw)) score += 1; // Match in body
            }

            if (score > 0) {
              scoredChunks.push({ text: `[${kb.title}]:\n${section.trim()}`, score, len: section.length });
            }
          }

          // Always include table of contents / overview with low priority
          scoredChunks.push({ text: `[${kb.title} — Table of contents]:\n${kb.content.substring(0, 1000)}`, score: 0.1, len: 1000 });
        }

        // Sort by relevance (highest keyword matches first)
        scoredChunks.sort((a, b) => b.score - a.score);

        // Take top chunks up to 18K chars
        let totalLen = 0;
        const maxContext = 18000;
        for (const chunk of scoredChunks) {
          if (totalLen + chunk.len > maxContext) {
            // If chunk is very relevant (score >= 3) and we have room for part of it, truncate
            if (chunk.score >= 3 && totalLen < maxContext - 500) {
              const remaining = maxContext - totalLen;
              knowledgeContext += chunk.text.substring(0, remaining) + '\n...(truncated)\n\n';
              totalLen = maxContext;
            }
            continue;
          }
          knowledgeContext += chunk.text + '\n\n';
          totalLen += chunk.len;
        }

        // Fallback: if no keyword matches, send beginning of each entry
        if (knowledgeContext.length < 100) {
          knowledgeContext = kbEntries.map(k => `[${k.title}]:\n${k.content.substring(0, 5000)}`).join('\n\n').substring(0, maxContext);
        }
      }

      // Gather FAQ articles — ALL published articles with links
      const faqArticles = db.prepare('SELECT title, slug, content FROM articles WHERE is_published=1 AND is_public=1').all();
      const faqContext = faqArticles.map(a => `[FAQ: ${a.title}] (link: /help/article/${a.slug}):\n${a.content.substring(0, 1000)}`).join('\n\n');

      // Get chat history (last 10 messages)
      const history = db.prepare('SELECT sender_type, content FROM chat_messages WHERE session_id=? ORDER BY created_at DESC LIMIT 10').all(session.id).reverse();

      const lang = req.session?.lang || 'fr';
      const companyName = getSetting('company_name', '');
      const chatbotContext = getSetting('chatbot_context', '');
      console.log('[Chat] AI — Keywords:', keywords.join(', '), '| KB context:', knowledgeContext.length, 'chars | FAQ articles:', faqArticles.length, '| Company:', companyName || '(default)');

      const aiResponse = await ai.livechatReply(history, knowledgeContext, faqContext, lang, companyName, chatbotContext);

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
