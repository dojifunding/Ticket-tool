const router = require('express').Router();
const { getDb, logActivity } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const ai = require('../ai');

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

  res.render('admin/articles', {
    articles, categories,
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

// ═══════════════════════════════════════════════════════
//  AI ENDPOINTS
// ═══════════════════════════════════════════════════════

// ─── AI: Generate Article ────────────────────────────
router.post('/ai/generate', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY.' });

  try {
    const { title, resources } = req.body;
    const lang = req.session.lang || 'fr';
    const content = await ai.generateArticle(title, resources, lang);
    res.json({ ok: true, content });
  } catch (e) {
    console.error('[AI] Generate article error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI: Generate from Content ───────────────────────
router.post('/ai/generate-from-content', async (req, res) => {
  if (!ai.isConfigured()) return res.status(400).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY.' });

  try {
    const { content } = req.body;
    const lang = req.session.lang || 'fr';
    const articles = await ai.generateArticleFromContent(content, lang);
    res.json({ ok: true, articles });
  } catch (e) {
    console.error('[AI] Generate from content error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI: Suggest Ticket Reply ────────────────────────
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
    const keywords = ticket.subject.split(/\s+/).filter(w => w.length > 3).join('%');
    const faqArticles = keywords ? db.prepare(`
      SELECT title, excerpt, content FROM articles
      WHERE is_published = 1 AND (title LIKE ? OR content LIKE ? OR excerpt LIKE ?)
      LIMIT 3
    `).all(`%${keywords}%`, `%${keywords}%`, `%${keywords}%`) : [];

    const suggestion = await ai.suggestTicketReply(ticket, messages, faqArticles, lang);
    res.json({ ok: true, suggestion, articlesUsed: faqArticles.length });
  } catch (e) {
    console.error('[AI] Suggest reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
