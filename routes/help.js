const router = require('express').Router();
const { getDb, generateTicketRef } = require('../database');
const { getTranslations, getDateLocale } = require('../i18n');
const { marked } = require('marked');

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(md) {
  if (!md) return '<p><em>Contenu non disponible.</em></p>';
  try { return marked.parse(md); }
  catch (e) { return '<pre>' + md.replace(/</g, '&lt;') + '</pre>'; }
}

function locField(row, field, lang) {
  if (lang !== 'fr' && row[field + '_' + lang]) return row[field + '_' + lang];
  return row[field];
}

// ─── Middleware: Load company from slug ──────────────
function loadCompany(req, res, next) {
  const db = getDb();
  const slug = req.params.companySlug;
  const company = db.prepare('SELECT * FROM companies WHERE slug = ? AND is_active = 1').get(slug);
  if (!company) {
    const lang = req.session?.lang || 'fr';
    const t = getTranslations(lang);
    return res.status(404).render('error', { user: null, title: 'Not found', message: 'Help center introuvable.', code: 404, t, dateLocale: getDateLocale(lang), currentPath: '/help' });
  }
  req.company = company;
  next();
}

// Helper: build base URL for this company's help center
function helpBase(company) { return '/help/c/' + company.slug; }

// Common locals for help center views
function helpLocals(req, extra = {}) {
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  return {
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null,
    currentPath: '/help',
    company: req.company,
    helpBase: helpBase(req.company),
    brandColor: req.company.brand_color || '#6366f1',
    ...extra
  };
}

// ═══════════════════════════════════════════════════════
//  HELP CENTER HUB — lists companies or redirects
// ═══════════════════════════════════════════════════════
router.get('/', (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const companies = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM articles WHERE company_id = c.id AND is_published = 1 AND is_public = 1) as article_count
    FROM companies c WHERE c.is_active = 1 AND c.help_center_enabled = 1 ORDER BY c.name
  `).all();

  // If single company, redirect directly
  if (companies.length === 1) return res.redirect(helpBase(companies[0]));

  // If no companies, show empty
  if (companies.length === 0) {
    // Fallback: show old-style help center with all articles (backward compat)
    return showLegacyHelp(req, res);
  }

  res.render('help/hub', {
    companies, title: t.help_title,
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
});

// Legacy fallback for tenants with no companies yet
function showLegacyHelp(req, res) {
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
    FROM articles a LEFT JOIN article_categories c ON a.category_id = c.id
    WHERE a.is_public = 1 AND a.is_published = 1
    ORDER BY a.views DESC LIMIT 6
  `).all();

  res.render('help/index', {
    categories: categories.map(c => ({ ...c, displayName: locField(c, 'name', lang) })),
    popular: popular.map(a => ({ ...a, displayTitle: locField(a, 'title', lang), displayExcerpt: locField(a, 'excerpt', lang), displayCategory: locField(a, 'category_name', lang) })),
    title: t.help_title, helpBase: '/help', company: null, brandColor: '#6366f1',
    t, dateLocale: getDateLocale(lang), lang,
    user: req.session?.user || null, currentPath: '/help'
  });
}

// ═══════════════════════════════════════════════════════
//  COMPANY-SCOPED HELP CENTER
// ═══════════════════════════════════════════════════════

// ─── Home ───────────────────────────────────────────
router.get('/c/:companySlug', loadCompany, (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const cid = req.company.id;

  const categories = db.prepare(`
    SELECT c.*, COUNT(a.id) as article_count
    FROM article_categories c
    LEFT JOIN articles a ON a.category_id = c.id AND a.is_public = 1 AND a.is_published = 1
    WHERE c.company_id = ?
    GROUP BY c.id ORDER BY c.position ASC
  `).all(cid);

  const popular = db.prepare(`
    SELECT a.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug
    FROM articles a LEFT JOIN article_categories c ON a.category_id = c.id
    WHERE a.company_id = ? AND a.is_public = 1 AND a.is_published = 1
    ORDER BY a.views DESC LIMIT 6
  `).all(cid);

  res.render('help/index', helpLocals(req, {
    categories: categories.map(c => ({ ...c, displayName: locField(c, 'name', lang) })),
    popular: popular.map(a => ({ ...a, displayTitle: locField(a, 'title', lang), displayExcerpt: locField(a, 'excerpt', lang), displayCategory: locField(a, 'category_name', lang) })),
    title: req.company.name + ' — Centre d\'aide'
  }));
});

// ─── Search ─────────────────────────────────────────
router.get('/c/:companySlug/search', loadCompany, (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  const q = req.query.q || '';
  const cid = req.company.id;

  let articles = [];
  if (q.length >= 2) {
    const isStaff = req.session?.user;
    const publicFilter = isStaff ? '' : 'AND a.is_public = 1';
    articles = db.prepare(`
      SELECT a.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug
      FROM articles a LEFT JOIN article_categories c ON a.category_id = c.id
      WHERE a.company_id = ? AND a.is_published = 1 ${publicFilter}
        AND (a.title LIKE ? OR a.content LIKE ? OR a.title_en LIKE ? OR a.content_en LIKE ?)
      ORDER BY a.views DESC LIMIT 20
    `).all(cid, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  res.render('help/search', helpLocals(req, {
    query: q,
    articles: articles.map(a => ({ ...a, displayTitle: locField(a, 'title', lang), displayExcerpt: locField(a, 'excerpt', lang), displayCategory: locField(a, 'category_name', lang) })),
    title: t.help_search + ': ' + q
  }));
});

// ─── Category ───────────────────────────────────────
router.get('/c/:companySlug/category/:slug', loadCompany, (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const category = db.prepare('SELECT * FROM article_categories WHERE slug = ? AND company_id = ?').get(req.params.slug, req.company.id);
  if (!category) return res.status(404).render('error', { user: null, title: 'Not found', message: '', code: 404, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  const isStaff = req.session?.user;
  const publicFilter = isStaff ? '' : 'AND a.is_public = 1';
  const articles = db.prepare(`SELECT a.* FROM articles a WHERE a.category_id = ? AND a.is_published = 1 ${publicFilter} ORDER BY a.views DESC`).all(category.id);

  res.render('help/category', helpLocals(req, {
    category: { ...category, displayName: locField(category, 'name', lang) },
    articles: articles.map(a => ({ ...a, displayTitle: locField(a, 'title', lang), displayExcerpt: locField(a, 'excerpt', lang) })),
    title: locField(category, 'name', lang)
  }));
});

// ─── Article ────────────────────────────────────────
router.get('/c/:companySlug/article/:slug', loadCompany, (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);

  const article = db.prepare(`
    SELECT a.*, c.name as category_name, c.name_en as category_name_en, c.slug as category_slug,
      u.full_name as author_name
    FROM articles a LEFT JOIN article_categories c ON a.category_id = c.id LEFT JOIN users u ON a.author_id = u.id
    WHERE a.slug = ? AND a.company_id = ?
  `).get(req.params.slug, req.company.id);

  if (!article) return res.status(404).render('error', { user: null, title: 'Not found', message: '', code: 404, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  const isStaff = req.session?.user;
  if (!article.is_public && !isStaff) return res.status(403).render('error', { user: null, title: 'Forbidden', message: '', code: 403, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(article.id);

  const related = db.prepare(`SELECT a.slug, a.title, a.title_en FROM articles a WHERE a.category_id = ? AND a.id != ? AND a.is_published = 1 AND a.is_public = 1 ORDER BY a.views DESC LIMIT 4`).all(article.category_id, article.id);
  const rawContent = locField(article, 'content', lang);

  res.render('help/article', helpLocals(req, {
    article: { ...article, displayTitle: locField(article, 'title', lang), displayContent: rawContent, renderedContent: renderMarkdown(rawContent), displayExcerpt: locField(article, 'excerpt', lang), displayCategory: locField(article, 'category_name', lang) },
    related: related.map(r => ({ ...r, displayTitle: locField(r, 'title', lang) })),
    title: locField(article, 'title', lang)
  }));
});

// ─── API: Quick Search ──────────────────────────────
router.get('/api/search', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  const lang = req.query.lang || req.session?.lang || 'fr';
  const companyId = req.query.company_id;
  if (q.length < 2) return res.json([]);

  let sql = `
    SELECT a.id, a.title, a.title_en, a.title_es, a.title_de,
      a.slug, a.excerpt, a.excerpt_en, a.is_public, a.company_id,
      c.name as category_name, c.name_en as category_name_en,
      co.slug as company_slug
    FROM articles a LEFT JOIN article_categories c ON a.category_id = c.id
    LEFT JOIN companies co ON a.company_id = co.id
    WHERE a.is_published = 1
      AND (a.title LIKE ? OR a.content LIKE ? OR a.title_en LIKE ? OR a.content_en LIKE ?)
  `;
  const params = [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`];
  if (companyId) { sql += ' AND a.company_id = ?'; params.push(parseInt(companyId)); }
  sql += ' ORDER BY a.views DESC LIMIT 8';

  const articles = db.prepare(sql).all(...params);
  res.json(articles.map(a => ({ ...a, displayTitle: (lang !== 'fr' && a['title_' + lang]) ? a['title_' + lang] : a.title })));
});

// ─── Submit Ticket ──────────────────────────────────
router.get('/c/:companySlug/submit', loadCompany, (req, res) => {
  const t = getTranslations(req.session?.lang || 'fr');
  res.render('help/submit', helpLocals(req, { title: t.help_submit_title, success: false, ticketRef: null }));
});

router.post('/c/:companySlug/submit', loadCompany, (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  const { client_name, client_email, subject, description, category } = req.body;

  if (!client_name || !client_email || !subject || !description) {
    return res.render('help/submit', helpLocals(req, { title: t.help_submit_title, success: false, ticketRef: null, error: t.help_submit_error_required }));
  }

  const reference = generateTicketRef();
  const sysUser = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  db.prepare(`INSERT INTO tickets (reference, subject, description, category, client_name, client_email, company_id, created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(reference, subject, description, category || 'general', client_name, client_email, req.company.id, sysUser ? sysUser.id : 1);

  try {
    const io = req.app.get('io');
    if (io) io.to('role-support').emit('ticket:created', { reference, subject });
  } catch (e) {}

  res.render('help/submit', helpLocals(req, { title: t.help_submit_success, success: true, ticketRef: reference }));
});

// ─── My Tickets ─────────────────────────────────────
router.get('/c/:companySlug/my-tickets', loadCompany, (req, res) => {
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  const email = req.query.email || req.session?.helpEmail || '';
  let tickets = [];

  if (email) {
    const db = getDb();
    tickets = db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id AND tm.is_internal = 0) as message_count
      FROM tickets t WHERE LOWER(t.client_email) = LOWER(?) AND t.company_id = ? ORDER BY t.updated_at DESC
    `).all(email.trim(), req.company.id);
    req.session.helpEmail = email.trim();
  }

  res.render('help/my-tickets', helpLocals(req, { title: t.help_my_tickets || 'Mes demandes', tickets, email: email.trim() }));
});

router.get('/c/:companySlug/my-tickets/:reference', loadCompany, (req, res) => {
  const db = getDb();
  const lang = req.session?.lang || 'fr';
  const t = getTranslations(lang);
  const email = req.session?.helpEmail;

  if (!email) return res.redirect(helpBase(req.company) + '/my-tickets');

  const ticket = db.prepare('SELECT * FROM tickets WHERE reference = ? AND LOWER(client_email) = LOWER(?) AND company_id = ?').get(req.params.reference, email, req.company.id);
  if (!ticket) return res.status(404).render('error', { user: null, title: 'Not found', message: '', code: 404, t, dateLocale: getDateLocale(lang), currentPath: '/help' });

  const messages = db.prepare(`
    SELECT tm.*, COALESCE(u.full_name, '💬 Vous') as full_name, COALESCE(u.avatar_color, '#6366f1') as avatar_color, COALESCE(u.role, 'visitor') as user_role
    FROM ticket_messages tm LEFT JOIN users u ON tm.user_id = u.id
    WHERE tm.ticket_id = ? AND tm.is_internal = 0 ORDER BY tm.created_at ASC
  `).all(ticket.id);

  res.render('help/ticket-detail', helpLocals(req, { title: ticket.reference + ' — ' + ticket.subject, ticket, messages, email }));
});

router.post('/c/:companySlug/my-tickets/:reference/reply', loadCompany, (req, res) => {
  const db = getDb();
  const email = req.session?.helpEmail;
  const { content } = req.body;

  if (!email || !content?.trim()) return res.redirect(helpBase(req.company) + '/my-tickets');

  const ticket = db.prepare('SELECT * FROM tickets WHERE reference = ? AND LOWER(client_email) = LOWER(?) AND company_id = ?').get(req.params.reference, email, req.company.id);
  if (!ticket) return res.redirect(helpBase(req.company) + '/my-tickets');

  const sysUser = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, content, is_internal) VALUES (?,?,?,0)')
    .run(ticket.id, sysUser ? sysUser.id : 1, `💬 [${ticket.client_name || 'Client'}]: ${content.trim()}`);

  if (ticket.status === 'closed' || ticket.status === 'resolved') {
    db.prepare("UPDATE tickets SET status='in_progress', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ticket.id);
  } else {
    db.prepare("UPDATE tickets SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ticket.id);
  }

  try {
    const io = req.app.get('io');
    if (io) io.to('role-support').emit('ticket:newMessage', { ticketId: ticket.id, message: { full_name: '💬 ' + (ticket.client_name || 'Client'), avatar_color: '#6366f1', user_role: 'visitor', content: content.trim(), is_internal: false } });
  } catch (e) {}

  res.redirect(helpBase(req.company) + '/my-tickets/' + req.params.reference);
});

module.exports = router;
