const router = require('express').Router();
const { getDb, generateTicketRef } = require('../database');
const { getTranslations, getDateLocale } = require('../i18n');

// Helper: get lang-aware field
function locField(row, field, lang) {
  if (lang === 'en' && row[field + '_en']) return row[field + '_en'];
  return row[field];
}

// ─── Help Center Home ────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const categories = db.prepare(`
    SELECT c.*, COUNT(a.id) as article_count
    FROM article_categories c
    LEFT JOIN articles a ON a.category_id = c.id AND a.is_public = 1 AND a.is_published = 1
    GROUP BY c.id ORDER BY c.position ASC
  `).all();

  const popular = db.prepare(`
    SELECT a.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug
    FROM articles a
    LEFT JOIN article_categories c ON a.category_id = c.id
    WHERE a.is_public = 1 AND a.is_published = 1
    ORDER BY a.views DESC LIMIT 6
  `).all();

  res.render('help/index', {
    categories: categories.map(c => ({ ...c, displayName: locField(c, 'name', lang) })),
    popular: popular.map(a => ({
      ...a,
      displayTitle: locField(a, 'title', lang),
      displayExcerpt: locField(a, 'excerpt', lang),
      displayCategory: locField(a, 'category_name', lang)
    })),
    title: t.help_title,
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

// ─── Search ──────────────────────────────────────────
router.get('/search', (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  const q = req.query.q || '';

  let articles = [];
  if (q.length >= 2) {
    const isStaff = req.session?.user;
    const publicFilter = isStaff ? '' : 'AND a.is_public = 1';
    articles = db.prepare(`
      SELECT a.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug
      FROM articles a
      LEFT JOIN article_categories c ON a.category_id = c.id
      WHERE a.is_published = 1 ${publicFilter}
        AND (a.title LIKE ? OR a.content LIKE ? OR a.title_en LIKE ? OR a.content_en LIKE ? OR a.excerpt LIKE ? OR a.excerpt_en LIKE ?)
      ORDER BY a.views DESC LIMIT 20
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  res.render('help/search', {
    query: q,
    articles: articles.map(a => ({
      ...a,
      displayTitle: locField(a, 'title', lang),
      displayExcerpt: locField(a, 'excerpt', lang),
      displayCategory: locField(a, 'category_name', lang)
    })),
    title: t.help_search + ': ' + q,
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

// ─── Category ────────────────────────────────────────
router.get('/category/:slug', (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const category = db.prepare('SELECT * FROM article_categories WHERE slug = ?').get(req.params.slug);
  if (!category) return res.status(404).render('error', { user: req.session?.user || null, title: 'Not found', message: '', code: 404, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  const isStaff = req.session?.user;
  const publicFilter = isStaff ? '' : 'AND a.is_public = 1';
  const articles = db.prepare(`
    SELECT a.* FROM articles a
    WHERE a.category_id = ? AND a.is_published = 1 ${publicFilter}
    ORDER BY a.views DESC
  `).all(category.id);

  res.render('help/category', {
    category: { ...category, displayName: locField(category, 'name', lang) },
    articles: articles.map(a => ({
      ...a,
      displayTitle: locField(a, 'title', lang),
      displayExcerpt: locField(a, 'excerpt', lang)
    })),
    title: locField(category, 'name', lang),
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

// ─── Article Detail ──────────────────────────────────
router.get('/article/:slug', (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const article = db.prepare(`
    SELECT a.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug,
      u.full_name as author_name
    FROM articles a
    LEFT JOIN article_categories c ON a.category_id = c.id
    LEFT JOIN users u ON a.author_id = u.id
    WHERE a.slug = ?
  `).get(req.params.slug);

  if (!article) return res.status(404).render('error', { user: req.session?.user || null, title: 'Not found', message: '', code: 404, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  // Check access: private articles only for staff
  const isStaff = req.session?.user;
  if (!article.is_public && !isStaff) return res.status(403).render('error', { user: null, title: 'Forbidden', message: '', code: 403, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  // Increment views
  db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(article.id);

  // Related articles
  const related = db.prepare(`
    SELECT a.slug, a.title, a.title_en FROM articles a
    WHERE a.category_id = ? AND a.id != ? AND a.is_published = 1 AND a.is_public = 1
    ORDER BY a.views DESC LIMIT 4
  `).all(article.category_id, article.id);

  res.render('help/article', {
    article: {
      ...article,
      displayTitle: locField(article, 'title', lang),
      displayContent: locField(article, 'content', lang),
      displayExcerpt: locField(article, 'excerpt', lang),
      displayCategory: locField(article, 'category_name', lang)
    },
    related: related.map(r => ({ ...r, displayTitle: locField(r, 'title', lang) })),
    title: locField(article, 'title', lang),
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

// ─── API: Quick Search (for ticket sidebar) ──────────
router.get('/api/search', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);

  const articles = db.prepare(`
    SELECT a.id, a.title, a.title_en, a.slug, a.excerpt, a.excerpt_en, a.is_public,
      c.name as category_name, c.name_en as category_name_en
    FROM articles a
    LEFT JOIN article_categories c ON a.category_id = c.id
    WHERE a.is_published = 1
      AND (a.title LIKE ? OR a.content LIKE ? OR a.title_en LIKE ? OR a.content_en LIKE ?)
    ORDER BY a.views DESC LIMIT 8
  `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);

  res.json(articles);
});

// ─── Submit Ticket Form ──────────────────────────────
router.get('/submit', (req, res) => {
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  res.render('help/submit', {
    title: t.help_submit_title,
    success: false,
    ticketRef: null,
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

// ─── Submit Ticket Action ────────────────────────────
router.post('/submit', (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const { client_name, client_email, subject, description, category } = req.body;

  if (!client_name || !client_email || !subject || !description) {
    return res.render('help/submit', {
      title: t.help_submit_title,
      success: false, ticketRef: null, error: t.help_submit_error_required,
      t, dateLocale: getDateLocale(lang), lang,
      user: req.session?.user || null, currentPath: '/help'
    });
  }

  const reference = generateTicketRef();
  db.prepare(`
    INSERT INTO tickets (reference, subject, description, category, client_name, client_email, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 4)
  `).run(reference, subject, description, category || 'general', client_name, client_email);

  res.render('help/submit', {
    title: t.help_submit_success,
    success: true, ticketRef: reference,
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

module.exports = router;
