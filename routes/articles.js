const router = require('express').Router();
const { getDb, logActivity } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const ai = require('../ai');
const crypto = require('crypto');

router.use(isAuthenticated);

// ─── Async AI Job Queue (avoids Render 30s HTTP timeout) ───
const aiJobs = new Map(); // jobId → { status, result, error, created }

function createJob(fn) {
  const jobId = crypto.randomBytes(8).toString('hex');
  aiJobs.set(jobId, { status: 'processing', result: null, error: null, created: Date.now() });

  // Run in background (no await!)
  fn().then(result => {
    aiJobs.set(jobId, { status: 'done', result, error: null, created: Date.now() });
  }).catch(err => {
    console.error('[AI Job] Error:', err.message);
    aiJobs.set(jobId, { status: 'error', result: null, error: err.message, created: Date.now() });
  });

  // Auto-cleanup after 5 min
  setTimeout(() => aiJobs.delete(jobId), 300000);
  return jobId;
}

// Poll endpoint
router.get('/ai/job/:jobId', (req, res) => {
  const job = aiJobs.get(req.params.jobId);
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

router.use(isAuthenticated);

// Only admin + support can manage articles
router.use((req, res, next) => {
  if (['admin', 'support'].includes(req.session.user.role)) return next();
  res.status(403).render('error', { user: req.session.user, title: 'Forbidden', message: '', code: 403 });
});

function slugify(text) {
  return text.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 80);
}

// ─── Articles List ───────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const articles = db.prepare(`
    SELECT a.*, c.name as category_name, c.icon as category_icon,
      u.full_name as author_name
    FROM articles a
    LEFT JOIN article_categories c ON a.category_id = c.id
    LEFT JOIN users u ON a.author_id = u.id
    ORDER BY a.updated_at DESC
  `).all();

  const categories = db.prepare('SELECT * FROM article_categories ORDER BY position ASC').all();

  // KB entries for "From KB" tab
  const kbEntries = db.prepare('SELECT id, title, content FROM knowledge_base WHERE is_active=1').all();

  // Pending AI suggestions count
  let pendingSuggestions = 0;
  try { pendingSuggestions = db.prepare('SELECT COUNT(*) as c FROM ai_article_suggestions WHERE status="pending"').get().c; } catch {}

  res.render('admin/articles', {
    articles, categories, kbEntries, pendingSuggestions,
    aiConfigured: ai.isConfigured(),
    title: res.locals.t.articles_title
  });
});

// ─── New Article Form ────────────────────────────────
router.get('/new', (req, res) => {
  const db = getDb();
  const categories = db.prepare('SELECT * FROM article_categories ORDER BY position ASC').all();
  res.render('admin/article-form', {
    article: null, categories,
    aiConfigured: ai.isConfigured(),
    title: res.locals.t.articles_new
  });
});

// ─── Create Article ──────────────────────────────────
router.post('/new', (req, res) => {
  const db = getDb();
  const { title, title_en, content, content_en, excerpt, excerpt_en, category_id, is_public, is_published } = req.body;
  const user = req.session.user;
  let slug = slugify(title);

  // Ensure unique slug
  const existing = db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug);
  if (existing) slug = slug + '-' + Date.now().toString(36);

  db.prepare(`
    INSERT INTO articles (title, slug, title_en, content, content_en, excerpt, excerpt_en, category_id, is_public, is_published, author_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, title_en || null, content, content_en || null, excerpt || null, excerpt_en || null,
    category_id || null, is_public ? 1 : 0, is_published ? 1 : 0, user.id);

  logActivity(user.id, 'created', 'article', 0, title);
  res.redirect('/admin/articles');
});

// ─── Edit Article Form ───────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.redirect('/admin/articles');

  const categories = db.prepare('SELECT * FROM article_categories ORDER BY position ASC').all();
  res.render('admin/article-form', {
    article, categories,
    aiConfigured: ai.isConfigured(),
    title: article.title
  });
});

// ─── Update Article ──────────────────────────────────
router.post('/:id/update', (req, res) => {
  const db = getDb();
  const { title, title_en, content, content_en, excerpt, excerpt_en, category_id, is_public, is_published } = req.body;

  db.prepare(`
    UPDATE articles SET title=?, title_en=?, content=?, content_en=?, excerpt=?, excerpt_en=?,
      category_id=?, is_public=?, is_published=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(title, title_en || null, content, content_en || null, excerpt || null, excerpt_en || null,
    category_id || null, is_public ? 1 : 0, is_published ? 1 : 0, req.params.id);

  res.redirect('/admin/articles');
});

// ─── Delete Article ──────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.redirect('/admin/articles');
});

// ─── Toggle Published ────────────────────────────────
router.post('/:id/toggle-publish', (req, res) => {
  const db = getDb();
  const article = db.prepare('SELECT is_published FROM articles WHERE id = ?').get(req.params.id);
  if (article) {
    db.prepare('UPDATE articles SET is_published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(article.is_published ? 0 : 1, req.params.id);
  }
  res.redirect('/admin/articles');
});

// ─── Bulk Publish AI-Generated Articles ──────────────
router.post('/ai/bulk-publish', (req, res) => {
  const db = getDb();
  const { articles } = req.body; // [{ title, content, excerpt, category_id, publish }]
  if (!articles || !Array.isArray(articles)) return res.status(400).json({ error: 'Invalid data' });

  let published = 0;
  for (const a of articles) {
    if (!a.publish || !a.title || !a.content) continue;
    const slug = a.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 80);
    // Ensure unique slug
    const existing = db.prepare('SELECT id FROM articles WHERE slug=?').get(slug);
    const finalSlug = existing ? slug + '-' + Date.now().toString(36) : slug;

    db.prepare(`INSERT INTO articles (title, slug, excerpt, content, category_id, is_published, is_public, author_id)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?)`).run(
      a.title, finalSlug, a.excerpt || '', a.content, a.category_id || null, req.session.user.id
    );
    published++;
  }

  res.json({ ok: true, published });
});

// ═══════════════════════════════════════════════════════
//  AI ENDPOINTS
// ═══════════════════════════════════════════════════════

// ─── AI: Generate Article ────────────────────────────
router.post('/ai/generate', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY.' });

  const { title, resources } = req.body;
  const lang = req.session.lang || 'fr';
  const jobId = createJob(async () => {
    const content = await ai.generateArticle(title, resources, lang);
    return { articles: [{ title, content, excerpt: '', category_suggestion: '' }] };
  });
  res.json({ ok: true, jobId });
});

// ─── AI: Generate from Content ───────────────────────
router.post('/ai/generate-from-content', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY.' });

  const { content } = req.body;
  const lang = req.session.lang || 'fr';
  const jobId = createJob(async () => {
    const articles = await ai.generateArticleFromContent(content, lang);
    return { articles };
  });
  res.json({ ok: true, jobId });
});

// ─── AI: Suggest Ticket Reply (Enhanced with KB + Staff Learning) ────
router.post('/ai/suggest-reply', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY.' });

  try {
    const db = getDb();
    const { ticketId } = req.body;
    const lang = req.session.lang || 'fr';

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const messages = db.prepare(`
      SELECT tm.*, u.full_name, u.role as user_role
      FROM ticket_messages tm JOIN users u ON tm.user_id = u.id
      WHERE tm.ticket_id = ? ORDER BY tm.created_at ASC
    `).all(ticketId);

    // Find relevant FAQ articles
    const keywords = ticket.subject.split(/\s+/).filter(w => w.length > 3);
    const keywordPattern = keywords.join('%');
    const faqArticles = keywordPattern ? db.prepare(`
      SELECT title, excerpt, content FROM articles
      WHERE is_published = 1 AND (title LIKE ? OR content LIKE ? OR excerpt LIKE ?)
      LIMIT 3
    `).all(`%${keywordPattern}%`, `%${keywordPattern}%`, `%${keywordPattern}%`) : [];

    // ─── KB Context (smart keyword search, same as livechat) ───
    const kbEntries = db.prepare('SELECT title, content FROM knowledge_base WHERE is_active=1').all();
    let kbContext = '';
    if (kbEntries.length > 0 && keywords.length > 0) {
      const scoredChunks = [];
      for (const kb of kbEntries) {
        const sections = kb.content.length > 1500
          ? kb.content.split(/\n(?=\d{1,2}\.\s+[A-Z0-9★◆■])|(?=\n#{1,3}\s)/g).filter(s => s.trim().length > 20)
          : [kb.content];
        for (const section of sections) {
          const lower = (kb.title + ' ' + section).toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            const kwl = kw.toLowerCase();
            if (lower.substring(0, 150).includes(kwl)) score += 3;
            else if (lower.includes(kwl)) score += 1;
          }
          if (score > 0) scoredChunks.push({ text: section.trim(), score, len: section.length });
        }
      }
      scoredChunks.sort((a, b) => b.score - a.score);
      let totalLen = 0;
      for (const chunk of scoredChunks.slice(0, 5)) {
        if (totalLen + chunk.len > 4000) break;
        kbContext += chunk.text + '\n\n';
        totalLen += chunk.len;
      }
    }

    // ─── Staff Learning: find past responses to similar tickets ───
    const staffResponses = [];
    if (keywords.length > 0) {
      const similarTickets = db.prepare(`
        SELECT t.id, t.subject FROM tickets t
        WHERE t.id != ? AND t.status IN ('resolved', 'closed')
        AND (${keywords.slice(0, 3).map(() => 't.subject LIKE ?').join(' OR ')})
        ORDER BY t.updated_at DESC LIMIT 5
      `).all(ticketId, ...keywords.slice(0, 3).map(k => `%${k}%`));

      for (const st of similarTickets) {
        const staffMsg = db.prepare(`
          SELECT tm.content, u.full_name as staff_name
          FROM ticket_messages tm JOIN users u ON tm.user_id = u.id
          WHERE tm.ticket_id = ? AND u.role IN ('admin', 'support')
          ORDER BY tm.created_at DESC LIMIT 1
        `).get(st.id);
        if (staffMsg) {
          staffResponses.push({ ...staffMsg, ticket_subject: st.subject });
        }
      }
    }

    console.log('[AI] Suggest reply — FAQ:', faqArticles.length, '| KB:', kbContext.length, 'chars | Staff history:', staffResponses.length);
    const suggestion = await ai.suggestTicketReply(ticket, messages, faqArticles, lang, kbContext, staffResponses);
    res.json({ ok: true, suggestion, articlesUsed: faqArticles.length, kbUsed: kbContext.length > 0, staffLearned: staffResponses.length });
  } catch (e) {
    console.error('[AI] Suggest reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI: Generate Articles from Knowledge Base ──────
router.post('/ai/generate-from-kb', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured' });

  const db = getDb();
  const { kbIds } = req.body;
  const lang = req.session.lang || 'fr';

  let kbEntries;
  if (kbIds === 'all' || !kbIds) {
    kbEntries = db.prepare('SELECT id, title, content FROM knowledge_base WHERE is_active=1').all();
  } else {
    const ids = Array.isArray(kbIds) ? kbIds : [kbIds];
    kbEntries = db.prepare(`SELECT id, title, content FROM knowledge_base WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active=1`).all(...ids);
  }

  if (!kbEntries.length) return res.status(400).json({ error: 'No KB entries found' });

  // Get real categories from DB so AI uses them
  const categories = db.prepare('SELECT slug, name, name_en FROM article_categories ORDER BY position').all();
  const catList = categories.map(c => `${c.slug} (${lang === 'fr' ? c.name : (c.name_en || c.name)})`).join(', ');

  const jobId = createJob(async () => {
    const articles = await ai.generateFromKB(kbEntries, lang, catList);
    return { articles };
  });
  res.json({ ok: true, jobId });
});

// ─── AI: Analyze Patterns → Suggest FAQ Articles ────
router.post('/ai/analyze-patterns', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured' });

  const db = getDb();
  const lang = req.session.lang || 'fr';

  // Collect data synchronously (fast)
  const recentTickets = db.prepare(`
    SELECT subject, description FROM tickets
    WHERE created_at > datetime('now', '-30 days')
    ORDER BY created_at DESC LIMIT 50
  `).all();

  const recentChats = db.prepare(`
    SELECT cm.content FROM chat_messages cm
    JOIN chat_sessions cs ON cm.session_id = cs.id
    WHERE cm.sender_type = 'visitor' AND cm.created_at > datetime('now', '-30 days')
    ORDER BY cm.created_at DESC LIMIT 100
  `).all();

  const questions = [
    ...recentTickets.map(t => `[Ticket] ${t.subject}: ${(t.description || '').substring(0, 150)}`),
    ...recentChats.map(c => `[Chat] ${c.content.substring(0, 150)}`)
  ];

  if (questions.length < 3) {
    return res.json({ ok: true, jobId: null, message: lang === 'fr' ? 'Pas assez de données (minimum 3 questions récentes).' : 'Not enough data (need at least 3 recent questions).' });
  }

  const existingTitles = db.prepare('SELECT title FROM articles WHERE is_published=1').all().map(a => a.title);
  const pendingSuggestions = db.prepare('SELECT title FROM ai_article_suggestions WHERE status="pending"').all().map(s => s.title);
  const allExisting = [...existingTitles, ...pendingSuggestions];

  const jobId = createJob(async () => {
    const suggestions = await ai.analyzeTicketPatterns(questions, allExisting, lang);

    // Save to DB and notify (inside async job — DB is still accessible)
    let saved = 0;
    const db2 = getDb();
    for (const s of suggestions) {
      if (!s.title || !s.content) continue;
      db2.prepare(`INSERT INTO ai_article_suggestions (title, content, excerpt, category_suggestion, source_type, source_details)
        VALUES (?, ?, ?, ?, 'pattern', ?)`).run(
        s.title, s.content, s.excerpt || '', s.category_suggestion || 'general',
        JSON.stringify({ frequency: s.frequency || 0, sample_questions: s.sample_questions || [] })
      );
      saved++;
    }

    if (saved > 0) {
      const admins = db2.prepare("SELECT id FROM users WHERE role IN ('admin', 'support') AND is_active=1").all();
      for (const admin of admins) {
        db2.prepare('INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)').run(
          admin.id, 'ai_suggestion',
          lang === 'fr' ? `🤖 ${saved} article(s) FAQ suggéré(s) par l'IA` : `🤖 ${saved} FAQ article(s) suggested by AI`,
          lang === 'fr' ? `L'IA a détecté ${saved} sujet(s) récurrent(s). Revoyez les suggestions.` : `AI detected ${saved} recurring topic(s). Review the suggestions.`,
          '/admin/articles/suggestions'
        );
      }
    }

    console.log('[AI] Pattern analysis — questions:', questions.length, '| saved:', saved);
    return { saved, total: suggestions.length };
  });
  res.json({ ok: true, jobId });
});

// ─── AI Suggestions Review Page ─────────────────────
router.get('/suggestions', (req, res) => {
  const db = getDb();
  const t = require('../i18n').getTranslations(req.session.lang || 'fr');

  const suggestions = db.prepare(`
    SELECT ais.*, u.full_name as reviewer_name
    FROM ai_article_suggestions ais
    LEFT JOIN users u ON ais.reviewed_by = u.id
    ORDER BY
      CASE ais.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 END,
      ais.created_at DESC
  `).all();

  // Parse source_details JSON
  suggestions.forEach(s => {
    try { s.details = JSON.parse(s.source_details || '{}'); } catch { s.details = {}; }
  });

  const categories = db.prepare('SELECT * FROM article_categories ORDER BY position ASC').all();

  res.render('admin/ai-suggestions', { user: req.session.user, t, suggestions, categories, aiConfigured: ai.isConfigured() });
});

// ─── Approve/Edit/Reject Suggestion ─────────────────
router.post('/suggestions/:id/review', (req, res) => {
  const db = getDb();
  const { action, title, content, excerpt, category_id } = req.body;
  const suggestion = db.prepare('SELECT * FROM ai_article_suggestions WHERE id=?').get(req.params.id);
  if (!suggestion) return res.redirect('/admin/articles/suggestions');

  if (action === 'approve') {
    // Create the article
    const slug = (title || suggestion.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const catId = category_id || null;
    const result = db.prepare(`INSERT INTO articles (title, slug, excerpt, content, category_id, is_published, is_public, author_id)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?)`).run(
      title || suggestion.title,
      slug,
      excerpt || suggestion.excerpt || '',
      content || suggestion.content,
      catId,
      req.session.user.id
    );

    db.prepare('UPDATE ai_article_suggestions SET status="approved", reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, published_article_id=? WHERE id=?')
      .run(req.session.user.id, result.lastInsertRowid, req.params.id);
  } else if (action === 'reject') {
    db.prepare('UPDATE ai_article_suggestions SET status="rejected", reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(req.session.user.id, req.params.id);
  }

  res.redirect('/admin/articles/suggestions');
});

module.exports = router;
