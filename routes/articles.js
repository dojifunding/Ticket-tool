const router = require('express').Router();
const { getDb, logActivity, getSetting, requestStore, getTenantDb } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const ai = require('../ai');
const crypto = require('crypto');

router.use(isAuthenticated);

// ─── Async AI Job Queue (avoids Render 30s HTTP timeout) ───
const aiJobs = new Map(); // jobId → { status, result, error, created }

function createJob(fn, tenantId) {
  const jobId = crypto.randomBytes(8).toString('hex');
  aiJobs.set(jobId, { status: 'processing', result: null, error: null, created: Date.now() });
  console.log('[AI Job] Created:', jobId, '— tenant:', tenantId || 'unknown', '— active jobs:', aiJobs.size);

  // Capture tenant DB now (while ALS context still active)
  const db = tenantId ? getTenantDb(tenantId) : getDb();

  // Run in background — re-wrap in ALS so getDb() works inside AI calls
  const wrappedFn = () => requestStore.run({ db, tenantId }, fn);

  wrappedFn().then(result => {
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
  const jobId = (req.params.jobId || '').trim();
  const job = aiJobs.get(jobId);
  if (!job) {
    console.log('[AI Job] Poll not_found:', jobId, '— active jobs:', [...aiJobs.keys()].join(', ') || 'none');
    return res.json({ status: 'not_found' });
  }
  // Prevent caching
  res.set('Cache-Control', 'no-store');
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
  const companyId = req.query.company ? parseInt(req.query.company) : null;

  let articlesSQL = `
    SELECT a.*, c.name as category_name, c.icon as category_icon,
      u.full_name as author_name, co.name as company_name, co.slug as company_slug
    FROM articles a
    LEFT JOIN article_categories c ON a.category_id = c.id
    LEFT JOIN users u ON a.author_id = u.id
    LEFT JOIN companies co ON a.company_id = co.id
  `;
  if (companyId) articlesSQL += ' WHERE a.company_id = ' + companyId;
  articlesSQL += ' ORDER BY a.updated_at DESC';
  const articles = db.prepare(articlesSQL).all();

  let catSQL = 'SELECT * FROM article_categories';
  if (companyId) catSQL += ' WHERE company_id = ' + companyId;
  catSQL += ' ORDER BY position ASC';
  const categories = db.prepare(catSQL).all();

  let kbSQL = 'SELECT id, title, content FROM knowledge_base WHERE is_active=1';
  if (companyId) kbSQL += ' AND company_id = ' + companyId;
  const kbEntries = db.prepare(kbSQL).all();

  let pendingSuggestions = 0;
  try {
    let sugSQL = 'SELECT COUNT(*) as c FROM ai_article_suggestions WHERE status="pending"';
    if (companyId) sugSQL += ' AND company_id = ' + companyId;
    pendingSuggestions = db.prepare(sugSQL).get().c;
  } catch {}

  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();
  const selectedCompany = companyId ? db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) : null;

  res.render('admin/articles', {
    articles, categories, kbEntries, pendingSuggestions, companies,
    selectedCompany, companyId,
    aiConfigured: ai.isAvailableForTenant(res.locals.tenant),
    title: selectedCompany ? selectedCompany.name + ' — Articles' : res.locals.t.articles_title
  });
});

// ─── New Article Form ────────────────────────────────
router.get('/new', (req, res) => {
  const db = getDb();
  const companyId = req.query.company ? parseInt(req.query.company) : null;
  let catSQL = 'SELECT * FROM article_categories';
  if (companyId) catSQL += ' WHERE company_id = ' + companyId;
  catSQL += ' ORDER BY position ASC';
  const categories = db.prepare(catSQL).all();
  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();
  res.render('admin/article-form', {
    article: null, categories, companies, companyId,
    aiConfigured: ai.isAvailableForTenant(res.locals.tenant),
    title: res.locals.t.articles_new
  });
});

// ─── Create Article ──────────────────────────────────
router.post('/new', (req, res) => {
  const db = getDb();
  const { title, title_fr, content, content_fr, excerpt, excerpt_fr, category_id, is_public, is_published, company_id } = req.body;
  const user = req.session.user;
  let slug = slugify(title);

  // Ensure unique slug
  const existing = db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug);
  if (existing) slug = slug + '-' + Date.now().toString(36);

  db.prepare(`
    INSERT INTO articles (title, slug, title_fr, content, content_fr, excerpt, excerpt_fr, category_id, company_id, is_public, is_published, author_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, title_fr || null, content, content_fr || null, excerpt || null, excerpt_fr || null,
    category_id || null, company_id || null, is_public ? 1 : 0, is_published ? 1 : 0, user.id);

  logActivity(user.id, 'created', 'article', 0, title);
  res.redirect('/admin/articles' + (company_id ? '?company=' + company_id : ''));
});

// ═══════════════════════════════════════════════════════
//  BULK CATEGORY CHANGE (must be before /:id routes)
// ═══════════════════════════════════════════════════════
router.post('/bulk-category', (req, res) => {
  const db = getDb();
  const { article_ids, category_id } = req.body;
  if (!article_ids || !category_id) return res.status(400).json({ error: 'Missing data' });

  const ids = Array.isArray(article_ids) ? article_ids : [article_ids];
  const catId = parseInt(category_id);
  const cat = db.prepare('SELECT id FROM article_categories WHERE id = ?').get(catId);
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  const stmt = db.prepare('UPDATE articles SET category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  let count = 0;
  for (const id of ids) {
    stmt.run(catId, parseInt(id));
    count++;
  }
  console.log('[Articles] Bulk category change:', count, 'articles → category', catId);
  res.json({ ok: true, count });
});

// ═══════════════════════════════════════════════════════
//  CATEGORY CRUD (must be before /:id routes)
// ═══════════════════════════════════════════════════════
router.get('/categories', (req, res) => {
  const db = getDb();
  const companyId = req.query.company ? parseInt(req.query.company) : null;

  let sql = `SELECT c.*, co.name as company_name, 
    (SELECT COUNT(*) FROM articles WHERE category_id = c.id) as article_count
    FROM article_categories c LEFT JOIN companies co ON c.company_id = co.id`;
  if (companyId) sql += ' WHERE c.company_id = ' + companyId;
  sql += ' ORDER BY c.position ASC, c.name ASC';
  const categories = db.prepare(sql).all();

  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();

  res.render('admin/categories', {
    categories, companies, companyId,
    title: res.locals.t.categories_title || 'Catégories'
  });
});

router.post('/categories', (req, res) => {
  const db = getDb();
  const { name, name_fr, name_en, name_es, name_de, slug, icon, company_id, position } = req.body;
  if (!name) return res.redirect('/admin/articles/categories?error=name');

  const catSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const maxPos = db.prepare('SELECT MAX(position) as m FROM article_categories').get();
  const pos = position ? parseInt(position) : ((maxPos?.m || 0) + 1);

  db.prepare('INSERT INTO article_categories (name, name_fr, name_en, name_es, name_de, slug, icon, company_id, position) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(name, name_fr || null, name_en || null, name_es || null, name_de || null, catSlug, icon || '📁', company_id ? parseInt(company_id) : null, pos);

  res.redirect('/admin/articles/categories' + (company_id ? '?company=' + company_id : ''));
});

router.post('/categories/:id/update', (req, res) => {
  const db = getDb();
  const { name, name_fr, name_en, name_es, name_de, slug, icon, position } = req.body;
  if (!name) return res.redirect('/admin/articles/categories');

  db.prepare('UPDATE article_categories SET name=?, name_fr=?, name_en=?, name_es=?, name_de=?, slug=?, icon=?, position=? WHERE id=?')
    .run(name, name_fr || null, name_en || null, name_es || null, name_de || null, slug || null, icon || '📁', position ? parseInt(position) : 0, req.params.id);

  res.redirect('/admin/articles/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);

  // Move articles to uncategorized (null)
  db.prepare('UPDATE articles SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM article_categories WHERE id = ?').run(id);

  res.redirect('/admin/articles/categories');
});

// ─── Edit Article Form ───────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.redirect('/admin/articles');

  let catSQL = 'SELECT * FROM article_categories';
  if (article.company_id) catSQL += ' WHERE company_id = ' + article.company_id;
  catSQL += ' ORDER BY position ASC';
  const categories = db.prepare(catSQL).all();
  const companies = db.prepare('SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name').all();
  res.render('admin/article-form', {
    article, categories, companies, companyId: article.company_id,
    aiConfigured: ai.isAvailableForTenant(res.locals.tenant),
    title: article.title
  });
});

// ─── Update Article ──────────────────────────────────
router.post('/:id/update', (req, res) => {
  const db = getDb();
  const { title, title_fr, content, content_fr, excerpt, excerpt_fr, category_id, is_public, is_published, company_id } = req.body;

  db.prepare(`
    UPDATE articles SET title=?, title_fr=?, content=?, content_fr=?, excerpt=?, excerpt_fr=?,
      category_id=?, company_id=?, is_public=?, is_published=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(title, title_fr || null, content, content_fr || null, excerpt || null, excerpt_fr || null,
    category_id || null, company_id || null, is_public ? 1 : 0, is_published ? 1 : 0, req.params.id);

  res.redirect('/admin/articles' + (company_id ? '?company=' + company_id : ''));
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
  const { articles, company_id } = req.body;
  if (!articles || !Array.isArray(articles)) return res.status(400).json({ error: 'Invalid data' });
  const cid = company_id ? parseInt(company_id) : null;

  const publishedIds = [];
  for (const a of articles) {
    if (!a.publish || !a.title || !a.content) continue;
    const slug = a.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 80);
    const existing = db.prepare('SELECT id FROM articles WHERE slug=?').get(slug);
    const finalSlug = existing ? slug + '-' + Date.now().toString(36) : slug;

    const result = db.prepare(`INSERT INTO articles (title, slug, excerpt, content, category_id, company_id, is_published, is_public, author_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`).run(
      a.title, finalSlug, a.excerpt || '', a.content, a.category_id || null, cid, req.session.user.id
    );
    publishedIds.push(result.lastInsertRowid);
  }

  // Auto-translate in background if enabled
  const autoTranslate = getSetting('auto_translate_articles', '0') === '1';
  const transLangs = getSetting('translation_languages', '').split(',').filter(l => l.trim() && l.trim() !== 'en');
  if (autoTranslate && transLangs.length > 0 && publishedIds.length > 0 && ai.isAvailableForTenant(res.locals.tenant)) {
    // Get company context for domain-specific vocabulary
    let companyContext = '';
    if (cid) {
      const comp = db.prepare('SELECT industry_context FROM companies WHERE id = ?').get(cid);
      if (comp && comp.industry_context) companyContext = comp.industry_context;
    }
    (async () => {
      try {
        const toTranslate = db.prepare(`SELECT id, title, content, excerpt FROM articles WHERE id IN (${publishedIds.join(',')})`).all();
        const results = await ai.batchTranslateArticles(toTranslate, transLangs, companyContext);
        for (const r of results) {
          if (!r.translations) continue;
          for (const [lang, t] of Object.entries(r.translations)) {
            if (t.title) {
              const cols = { en: ['title_en','content_en','excerpt_en'], fr: ['title_fr','content_fr','excerpt_fr'], es: ['title_es','content_es','excerpt_es'], de: ['title_de','content_de','excerpt_de'] };
              const c = cols[lang];
              if (c) db.prepare(`UPDATE articles SET ${c[0]}=?, ${c[1]}=?, ${c[2]}=? WHERE id=?`).run(t.title, t.content || '', t.excerpt || '', r.id);
            }
          }
        }
        console.log('[AI] Auto-translated', results.length, 'articles into', transLangs.join(','));
      } catch (e) { console.error('[AI] Auto-translate error:', e.message); }
    })();
  }

  res.json({ ok: true, published: publishedIds.length, autoTranslating: autoTranslate && transLangs.length > 0 });
});

// ─── Translate Single Article ────────────────────────
router.post('/:id/translate', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });
  const db = getDb();
  const article = db.prepare('SELECT * FROM articles WHERE id=?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const transLangs = getSetting('translation_languages', '').split(',').filter(l => l.trim() && l.trim() !== 'en');
  if (!transLangs.length) return res.json({ ok: true, message: 'No languages configured' });

  // Get company context for domain-specific vocabulary
  let companyContext = '';
  if (article.company_id) {
    const comp = db.prepare('SELECT name, description, industry_context FROM companies WHERE id = ?').get(article.company_id);
    if (comp && comp.industry_context) companyContext = comp.industry_context;
  }

  const jobId = createJob(async () => {
    const translations = await ai.translateArticle(article.title, article.content, article.excerpt, transLangs, companyContext);
    for (const [lang, t] of Object.entries(translations)) {
      if (!t.title) continue;
      const cols = { en: ['title_en','content_en','excerpt_en'], fr: ['title_fr','content_fr','excerpt_fr'], es: ['title_es','content_es','excerpt_es'], de: ['title_de','content_de','excerpt_de'] };
      const c = cols[lang];
      if (c) db.prepare(`UPDATE articles SET ${c[0]}=?, ${c[1]}=?, ${c[2]}=? WHERE id=?`).run(t.title, t.content || '', t.excerpt || '', article.id);
    }
    return { translated: Object.keys(translations) };
  }, req.session.tenantId);
  res.json({ ok: true, jobId });
});

// ─── Bulk Translate All Untranslated ─────────────────
router.post('/ai/bulk-translate', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });
  const db = getDb();
  const transLangs = getSetting('translation_languages', '').split(',').filter(l => l.trim() && l.trim() !== 'en');
  if (!transLangs.length) return res.json({ ok: true, message: 'No languages configured' });

  // Find articles missing translations for ANY configured language
  const conditions = transLangs.map(l => `(title_${l} IS NULL OR title_${l} = '')`).join(' OR ');
  const articles = db.prepare(`SELECT id, title, content, excerpt, company_id FROM articles WHERE is_published=1 AND (${conditions})`).all();

  if (!articles.length) return res.json({ ok: true, message: 'All articles already translated' });

  // Get company contexts for all involved companies
  const companyContexts = {};
  const companyIds = [...new Set(articles.filter(a => a.company_id).map(a => a.company_id))];
  for (const cid of companyIds) {
    const comp = db.prepare('SELECT industry_context FROM companies WHERE id = ?').get(cid);
    if (comp && comp.industry_context) companyContexts[cid] = comp.industry_context;
  }

  const jobId = createJob(async () => {
    // Group articles by company for context-aware translation
    let translated = 0;
    const CONCURRENCY = 3;
    for (let i = 0; i < articles.length; i += CONCURRENCY) {
      const batch = articles.slice(i, i + CONCURRENCY);
      const promises = batch.map(a => {
        const ctx = a.company_id ? (companyContexts[a.company_id] || '') : '';
        return ai.translateArticle(a.title, a.content, a.excerpt || '', transLangs, ctx)
          .then(translations => ({ id: a.id, translations }))
          .catch(e => ({ id: a.id, translations: {}, error: e.message }));
      });
      const results = await Promise.all(promises);
      for (const r of results) {
        if (!r.translations) continue;
        for (const [lang, t] of Object.entries(r.translations)) {
          if (!t.title) continue;
          const cols = { en: ['title_en','content_en','excerpt_en'], fr: ['title_fr','content_fr','excerpt_fr'], es: ['title_es','content_es','excerpt_es'], de: ['title_de','content_de','excerpt_de'] };
          const c = cols[lang];
          if (c) { db.prepare(`UPDATE articles SET ${c[0]}=?, ${c[1]}=?, ${c[2]}=? WHERE id=?`).run(t.title, t.content || '', t.excerpt || '', r.id); translated++; }
        }
      }
    }
    return { translated, total: articles.length, languages: transLangs };
  }, req.session.tenantId);
  res.json({ ok: true, jobId, count: articles.length });
});

// ═══════════════════════════════════════════════════════
//  AI ENDPOINTS
// ═══════════════════════════════════════════════════════

// ─── AI: Generate Article ────────────────────────────
router.post('/ai/generate', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });

  const { title, resources } = req.body;
  const lang = req.session.lang || 'fr';
  const jobId = createJob(async () => {
    const content = await ai.generateArticle(title, resources, lang, res.locals.tenant);
    return { articles: [{ title, content, excerpt: '', category_suggestion: '' }] };
  }, req.session.tenantId);
  res.json({ ok: true, jobId });
});

// ─── AI: Generate from Content ───────────────────────
router.post('/ai/generate-from-content', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });

  const { content, company_id, output_lang } = req.body;
  const lang = req.session.lang || 'fr';
  const db = getDb();

  // Get company context
  let companyContext = '';
  const cid = company_id ? parseInt(company_id) : null;
  if (cid) {
    const comp = db.prepare('SELECT name, description, industry_context FROM companies WHERE id = ?').get(cid);
    if (comp) {
      const parts = [];
      if (comp.name) parts.push('Company: ' + comp.name);
      if (comp.description) parts.push('Description: ' + comp.description);
      if (comp.industry_context) parts.push('Industry/Vocabulary: ' + comp.industry_context);
      companyContext = parts.join('\n');
    }
  }

  const jobId = createJob(async () => {
    const articles = await ai.generateArticleFromContent(content, lang, { outputLang: output_lang || 'source', companyContext });
    return { articles };
  }, req.session.tenantId);
  res.json({ ok: true, jobId });
});

// ─── AI: Suggest Ticket Reply (Enhanced with KB + Staff Learning) ────
router.post('/ai/suggest-reply', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });

  try {
    const db = getDb();
    const { ticketId } = req.body;
    let lang = req.session.lang || 'fr';

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Detect language from linked livechat session (visitor's language)
    const linkedChat = db.prepare('SELECT lang FROM chat_sessions WHERE ticket_id = ?').get(ticketId);
    if (linkedChat && linkedChat.lang) {
      lang = linkedChat.lang;
      console.log('[AI] Suggest reply — using livechat visitor language:', lang);
    }

    const messages = db.prepare(`
      SELECT tm.*, u.full_name, u.role as user_role
      FROM ticket_messages tm JOIN users u ON tm.user_id = u.id
      WHERE tm.ticket_id = ? ORDER BY tm.created_at ASC
    `).all(ticketId);

    // ─── Extract meaningful keywords from ALL sources ───
    const stopWords = new Set(['le','la','les','de','du','des','un','une','est','sont','dans','pour','avec','sur','que','qui','comment','quelle','quels','quelles','quel','cette','ces','mon','mes','son','ses','nous','vous','ils','elles','the','is','are','was','were','how','what','which','from','with','for','and','but','not','this','that','can','will','pas','plus','tout','aussi','ete','faire','fait','bonjour','merci','oui','non','bien','aide','aider','assistant','conversation','livechat','transferee','historique','humain','agent','projecthub']);

    let searchText = ticket.subject + ' ' + (ticket.description || '');

    // Add ALL messages (not just visitor — livechat forwards use admin user_id)
    const recentMsgs = messages.slice(-5);
    recentMsgs.forEach(m => { searchText += ' ' + m.content; });

    // Extract embedded livechat visitor questions: "💬 [Name]: actual question"
    const allText = (ticket.description || '') + ' ' + messages.map(m => m.content).join(' ');
    const embeddedQuestions = allText.match(/💬?\s*\[[^\]]*\]:\s*([^\n]+)/g);
    if (embeddedQuestions) {
      embeddedQuestions.forEach(q => {
        const cleaned = q.replace(/💬?\s*\[[^\]]*\]:\s*/, '');
        searchText += ' ' + cleaned + ' ' + cleaned; // double weight
      });
    }

    // Also extract visitor questions from history pattern: [Visitor]: question, [Name]: question
    const historyQuestions = allText.match(/\[(?!Assistant)[^\]]*\]:\s*([^\n]+)/g);
    if (historyQuestions) {
      historyQuestions.forEach(q => {
        const cleaned = q.replace(/\[[^\]]*\]:\s*/, '');
        if (cleaned.length > 5 && !cleaned.includes('Bonjour') && !cleaned.includes('assistant')) {
          searchText += ' ' + cleaned;
        }
      });
    }

    const keywords = searchText
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[💬🔗👋🧑]/g, '') // remove emojis
      .split(/[\s,;:.!?()[\]{}'"\/\-—]+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .filter((w, i, arr) => arr.indexOf(w) === i)
      .slice(0, 20);

    console.log('[AI] Suggest reply — keywords:', keywords.join(', '));

    // ─── Detect company_id from chat session if ticket doesn't have one ───
    let effectiveCompanyId = ticket.company_id;
    if (!effectiveCompanyId) {
      // Check if this ticket was created from a livechat with a company
      const linkedSession = db.prepare('SELECT company_id FROM chat_sessions WHERE ticket_id = ?').get(ticketId);
      if (linkedSession && linkedSession.company_id) {
        effectiveCompanyId = linkedSession.company_id;
        console.log('[AI] Suggest reply — detected company from chat session:', effectiveCompanyId);
      }
    }

    // ─── Find ALL FAQ articles (same approach as livechat — let AI find the right one) ───
    let faqArticles = [];
    {
      let faqSQL = `SELECT a.id, a.title, a.slug, a.excerpt, a.content, co.slug as company_slug
        FROM articles a LEFT JOIN companies co ON a.company_id = co.id
        WHERE a.is_published = 1`;
      if (effectiveCompanyId) faqSQL += ' AND (a.company_id = ' + effectiveCompanyId + ' OR a.company_id IS NULL)';
      faqArticles = db.prepare(faqSQL).all();
      console.log('[AI] Suggest reply — ALL FAQ articles:', faqArticles.length);
    }

    // ─── KB Context (smart keyword search, scoped to company) ───
    let kbSQL = 'SELECT title, content FROM knowledge_base WHERE is_active=1';
    if (effectiveCompanyId) kbSQL += ' AND (company_id = ' + effectiveCompanyId + ' OR company_id IS NULL)';
    const kbEntries = db.prepare(kbSQL).all();
    let kbContext = '';
    if (kbEntries.length > 0 && keywords.length > 0) {
      const { splitKbIntoSections } = require('../database');
      const scoredChunks = [];
      for (const kb of kbEntries) {
        const sections = splitKbIntoSections(kb.content);
        for (const section of sections) {
          const lower = (kb.title + ' ' + section).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          let score = 0;
          const heading = lower.substring(0, 200);
          for (const kw of keywords) {
            if (heading.includes(kw)) score += 3;
            else if (lower.includes(kw)) score += 1;
          }
          if (score > 0) scoredChunks.push({ text: section.trim(), score, len: section.length });
        }
      }
      scoredChunks.sort((a, b) => b.score - a.score);
      let totalLen = 0;
      for (const chunk of scoredChunks.slice(0, 8)) {
        if (totalLen + chunk.len > 6000) break;
        kbContext += chunk.text + '\n\n';
        totalLen += chunk.len;
      }
    }

    // ─── Staff Learning: find past responses to similar tickets ───
    const staffResponses = [];
    if (keywords.length > 0) {
      const kwSlice = keywords.slice(0, 5);
      const similarTickets = db.prepare(`
        SELECT t.id, t.subject FROM tickets t
        WHERE t.id != ? AND t.status IN ('resolved', 'closed')
        AND (${kwSlice.map(() => 't.subject LIKE ?').join(' OR ')})
        ORDER BY t.updated_at DESC LIMIT 5
      `).all(ticketId, ...kwSlice.map(k => `%${k}%`));

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
    const suggestion = await ai.suggestTicketReply(ticket, messages, faqArticles, lang, kbContext, staffResponses, res.locals.tenant);
    res.json({ ok: true, suggestion, articlesUsed: faqArticles.length, kbUsed: kbContext.length > 0, staffLearned: staffResponses.length });
  } catch (e) {
    console.error('[AI] Suggest reply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI: Generate Articles from Knowledge Base ──────
// ─── AI: Diagnose KB Splitting (shows how content will be split) ─────
// ─── KB Splitting Diagnostic (no AI cost) ────────────
router.post('/ai/diagnose-kb', async (req, res) => {
  const db = getDb();
  const { kbIds } = req.body;

  let kbEntries;
  if (kbIds === 'all' || !kbIds) {
    kbEntries = db.prepare('SELECT id, title, content FROM knowledge_base WHERE is_active=1').all();
  } else {
    const ids = Array.isArray(kbIds) ? kbIds : [kbIds];
    kbEntries = db.prepare(`SELECT id, title, content FROM knowledge_base WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active=1`).all(...ids);
  }

  const results = [];
  for (const kb of kbEntries) {
    let content = kb.content
      .replace(/^Title:.*\n/i, '').replace(/^URL Source:.*\n/i, '')
      .replace(/^Markdown Content:\s*\n/i, '').trim();

    // Regex strategies (for info only)
    const strategies = {
      'md_h2': content.split(/\n(?=##\s+)/).filter(s => s.trim().length > 30),
      'md_any': content.split(/\n(?=#{1,4}\s+)/).filter(s => s.trim().length > 30),
      'numbered': content.split(/\n(?=\s*\u200B?\d{1,2}\.[\s]*[A-Za-zÀ-ÿ])/).filter(s => s.trim().length > 30),
      'md_numbered': content.split(/\n(?=#{1,3}\s*\d{1,2}\.)/).filter(s => s.trim().length > 30),
      'bold': content.split(/\n(?=\*\*[^*]{3,}\*\*)/).filter(s => s.trim().length > 30),
      'bold_numbered': content.split(/\n(?=\*\*\s*\d{1,2}\.)/).filter(s => s.trim().length > 30),
      'numbered_unicode': content.split(/\n(?=[\s\u00A0\u200B\u200C\u200D\uFEFF]*\d{1,2}\.\s*[A-Za-zÀ-ÿ])/).filter(s => s.trim().length > 30),
      'paragraphs': content.split(/\n\n+/).filter(s => s.trim().length > 50),
    };

    const best = Object.entries(strategies).sort((a, b) => b[1].length - a[1].length)[0];

    results.push({
      id: kb.id, title: kb.title, chars: kb.content.length,
      preview: content.substring(0, 300),
      hasMarkdownHeaders: /(^|\n)##\s/.test(content),
      hasNumberedSections: /(^|\n)\d{1,2}\.\s*[A-Za-zÀ-ÿ]/.test(content),
      hasBoldHeaders: /(^|\n)\*\*[^*]+\*\*/.test(content),
      strategies: Object.fromEntries(Object.entries(strategies).map(([k, v]) => [k, v.length])),
      bestRegexStrategy: best[0],
      bestRegexSections: best[1].length,
      method: kb.content.length > 800 ? '🤖 AI structure analysis (primary)' : '📝 Direct (short content)',
      sectionPreviews: best[1].slice(0, 12).map(s => s.substring(0, 100).replace(/\n/g, ' ')),
      estimatedArticles: best[1].length + '-' + Math.round(best[1].length * 1.5),
    });
  }

  res.json({ ok: true, diagnosis: results });
});

router.post('/ai/generate-from-kb', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });

  const db = getDb();
  const { kbIds, company_id, output_lang } = req.body;
  const lang = req.session.lang || 'fr';
  const cid = company_id ? parseInt(company_id) : null;

  let kbEntries;
  if (kbIds === 'all' || !kbIds) {
    let sql = 'SELECT id, title, content FROM knowledge_base WHERE is_active=1';
    if (cid) sql += ' AND (company_id = ' + cid + ' OR company_id IS NULL)';
    kbEntries = db.prepare(sql).all();
  } else {
    const ids = Array.isArray(kbIds) ? kbIds : [kbIds];
    kbEntries = db.prepare(`SELECT id, title, content FROM knowledge_base WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active=1`).all(...ids);
  }

  if (!kbEntries.length) return res.status(400).json({ error: 'No KB entries found' });

  // Get real categories from DB, scoped to company if applicable
  let catSQL = 'SELECT slug, name, name_en FROM article_categories';
  if (cid) catSQL += ' WHERE company_id = ' + cid;
  catSQL += ' ORDER BY position';
  const categories = db.prepare(catSQL).all();
  const catList = categories.map(c => `${c.slug} (${lang === 'fr' ? c.name : (c.name_en || c.name)})`).join(', ');

  // Get company context for vocabulary/industry
  let companyContext = '';
  if (cid) {
    const comp = db.prepare('SELECT name, description, industry_context, chatbot_context FROM companies WHERE id = ?').get(cid);
    if (comp) {
      const parts = [];
      if (comp.name) parts.push('Company: ' + comp.name);
      if (comp.description) parts.push('Description: ' + comp.description);
      if (comp.industry_context) parts.push('Industry/Vocabulary: ' + comp.industry_context);
      companyContext = parts.join('\n');
    }
  }

  // output_lang: 'source' (default) keeps original language, 'fr'/'en' etc. translates
  const effectiveOutputLang = output_lang || 'source';

  const jobId = createJob(async () => {
    const articles = await ai.generateFromKB(kbEntries, lang, catList, { outputLang: effectiveOutputLang, companyContext });
    return { articles };
  }, req.session.tenantId);
  res.json({ ok: true, jobId });
});

// ─── AI: Analyze Patterns → Suggest FAQ Articles ────
router.post('/ai/analyze-patterns', async (req, res) => {
  if (!ai.isAvailableForTenant(res.locals.tenant)) return res.status(400).json({ error: 'Service IA indisponible.' });

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
  }, req.session.tenantId);
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

  res.render('admin/ai-suggestions', { user: req.session.user, t, suggestions, categories, aiConfigured: ai.isAvailableForTenant(res.locals.tenant) });
});

// ─── Approve/Edit/Reject Suggestion ─────────────────
router.post('/suggestions/:id/review', (req, res) => {
  const db = getDb();
  const { action, title, content, excerpt, category_id, company_id } = req.body;
  const suggestion = db.prepare('SELECT * FROM ai_article_suggestions WHERE id=?').get(req.params.id);
  if (!suggestion) return res.redirect('/admin/articles/suggestions');

  if (action === 'approve') {
    // Create the article
    const slug = (title || suggestion.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const catId = category_id || null;
    const cid = company_id ? parseInt(company_id) : (suggestion.company_id || null);
    const result = db.prepare(`INSERT INTO articles (title, slug, excerpt, content, category_id, company_id, is_published, is_public, author_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`).run(
      title || suggestion.title,
      slug,
      excerpt || suggestion.excerpt || '',
      content || suggestion.content,
      catId,
      cid,
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
