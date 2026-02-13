const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb, getSetting, setSetting, getMasterDb } = require('../database');
const { isAuthenticated, isAdmin } = require('../middleware/auth');

router.use(isAuthenticated, isAdmin);

// ─── Admin Dashboard ─────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();

  const stats = {
    users: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get().c,
    projects: db.prepare('SELECT COUNT(*) as c FROM projects WHERE status = ?').get('active').c,
    activeTasks: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status NOT IN (?, ?)').get('done', 'backlog').c,
    openTickets: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status NOT IN (?, ?)').get('resolved', 'closed').c,
    urgentTickets: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE priority = ? AND status NOT IN (?, ?)').get('urgent', 'resolved', 'closed').c,
    escalations: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE type = ? AND status != ?').get('escalation', 'done').c,
    companies: db.prepare('SELECT COUNT(*) as c FROM companies WHERE is_active = 1').get().c,
  };

  const recentActivity = db.prepare(`
    SELECT al.*, u.full_name, u.avatar_color, u.role
    FROM activity_log al
    JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT 20
  `).all();

  const ticketsByStatus = {
    open: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('open').c,
    in_progress: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('in_progress').c,
    waiting: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('waiting').c,
    resolved: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('resolved').c,
    closed: db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get('closed').c,
  };

  const tasksByStatus = {
    backlog: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('backlog').c,
    todo: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('todo').c,
    in_progress: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('in_progress').c,
    review: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('review').c,
    done: db.prepare('SELECT COUNT(*) as c FROM tasks WHERE status = ?').get('done').c,
  };

  // AI usage stats (last 30 days)
  const aiStats = db.prepare(`
    SELECT COUNT(*) as calls, COALESCE(SUM(tokens_estimate),0) as tokens, COALESCE(SUM(cost_estimate),0) as cost
    FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')
  `).get();

  const aiToday = db.prepare(`
    SELECT COUNT(*) as calls, COALESCE(SUM(cost_estimate),0) as cost
    FROM ai_usage_log WHERE created_at > datetime('now', '-1 day')
  `).get();

  res.render('admin/dashboard', { stats, recentActivity, ticketsByStatus, tasksByStatus, aiStats, aiToday, title: 'Admin — Dashboard' });
});

// ─── Settings Page ──────────────────────────────────
router.get('/settings', (req, res) => {
  const { getTranslations } = require('../i18n');
  const lang = req.session.lang || 'fr';
  const t = getTranslations(lang);
  const ai = require('../ai');
  const db = getDb();

  const settings = {
    translation_languages: getSetting('translation_languages', 'en'),
    auto_translate_articles: getSetting('auto_translate_articles', '0'),
    ai_livechat_faq_first: getSetting('ai_livechat_faq_first', '1'),
    company_name: getSetting('company_name', ''),
    chatbot_context: getSetting('chatbot_context', ''),
    escalation_enabled: getSetting('escalation_enabled', '0'),
    escalation_categories: getSetting('escalation_categories', 'bug,feature_request'),
  };

  const transLangsArr = settings.translation_languages.split(',').filter(l => l.trim());
  const untranslatedConditions = transLangsArr.map(l => `(title_${l} IS NULL OR title_${l} = '')`).join(' OR ') || "(title_en IS NULL OR title_en = '')";
  const untranslatedCount = db.prepare(`
    SELECT COUNT(*) as c FROM articles WHERE is_published=1 AND (${untranslatedConditions})
  `).get().c;

  res.render('admin/settings', {
    settings, aiConfigured: ai.isAvailableForTenant(res.locals.tenant), untranslatedCount,
    saved: req.query.saved, tenant: res.locals.tenant,
    title: 'Paramètres', t, lang, user: req.session.user, currentPath: '/admin/settings'
  });
});

router.post('/settings', (req, res) => {
  // Handle translation_languages (multiple checkboxes → can be string or array)
  let transLangs = req.body.translation_languages || '';
  if (Array.isArray(transLangs)) transLangs = transLangs.join(',');
  setSetting('translation_languages', transLangs);
  setSetting('auto_translate_articles', req.body.auto_translate_articles ? '1' : '0');
  setSetting('ai_livechat_faq_first', req.body.ai_livechat_faq_first ? '1' : '0');
  setSetting('company_name', (req.body.company_name || '').trim());
  setSetting('chatbot_context', (req.body.chatbot_context || '').trim());
  setSetting('escalation_enabled', req.body.escalation_enabled ? '1' : '0');
  let escCategories = req.body.escalation_categories || '';
  if (Array.isArray(escCategories)) escCategories = escCategories.join(',');
  setSetting('escalation_categories', escCategories);

  // Also update tenant name in master DB so sidebar reflects the change
  if (req.body.company_name && req.body.company_name.trim()) {
    const { getMasterDb } = require('../database');
    const masterDb = getMasterDb();
    masterDb.prepare('UPDATE tenants SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(req.body.company_name.trim(), req.session.tenantId);
  }

  res.redirect('/admin/settings?saved=1');
});

// ─── Save AI Profile ─────────────────────────────────
router.post('/settings/ai-profile', (req, res) => {
  const { ai_profile, custom_ai_context } = req.body;
  const tenantId = req.session.tenantId;
  const { getMasterDb } = require('../database');
  const masterDb = getMasterDb();

  masterDb.prepare('UPDATE tenants SET ai_profile=?, custom_ai_context=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(ai_profile || 'generic', custom_ai_context || '', tenantId);

  // Also update chatbot_context setting for backward compat
  setSetting('chatbot_context', custom_ai_context || '');

  res.json({ ok: true });
});

// ─── Save Branding ──────────────────────────────────
router.post('/settings/branding', (req, res) => {
  const { brand_color, custom_domain } = req.body;
  const tenantId = req.session.tenantId;
  const { getMasterDb } = require('../database');
  const masterDb = getMasterDb();

  // Auto-generate dark variant (lighten the color)
  const darkColor = lightenColor(brand_color || '#6366f1', 20);

  masterDb.prepare('UPDATE tenants SET brand_color=?, brand_color_dark=?, custom_domain=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(brand_color || '#6366f1', darkColor, (custom_domain || '').trim().toLowerCase(), tenantId);

  res.json({ ok: true });
});

function lightenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (num >> 16) + Math.round(2.55 * percent));
  const g = Math.min(255, ((num >> 8) & 0x00FF) + Math.round(2.55 * percent));
  const b = Math.min(255, (num & 0x0000FF) + Math.round(2.55 * percent));
  return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}

// ─── Upload Logo ────────────────────────────────────
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'public', 'uploads', req.session.tenantId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, 'logo' + ext);
    }
  }),
  limits: { fileSize: 512 * 1024 }, // 512 KB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

router.post('/settings/logo', logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const logoUrl = '/uploads/' + req.session.tenantId + '/' + req.file.filename;
  const { getMasterDb } = require('../database');
  const masterDb = getMasterDb();

  masterDb.prepare('UPDATE tenants SET logo_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(logoUrl, req.session.tenantId);

  res.json({ ok: true, url: logoUrl });
});

router.delete('/settings/logo', (req, res) => {
  const { getMasterDb } = require('../database');
  const masterDb = getMasterDb();
  const tenant = masterDb.prepare('SELECT logo_url FROM tenants WHERE id=?').get(req.session.tenantId);

  if (tenant && tenant.logo_url) {
    const filePath = path.join(__dirname, '..', 'public', tenant.logo_url);
    try { fs.unlinkSync(filePath); } catch (e) { /* file may not exist */ }
  }

  masterDb.prepare('UPDATE tenants SET logo_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run('', req.session.tenantId);

  res.json({ ok: true });
});

// ─── User Management ─────────────────────────────────
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM tasks WHERE assigned_to = u.id AND status != 'done') as active_tasks,
      (SELECT COUNT(*) FROM tickets WHERE assigned_to = u.id AND status NOT IN ('resolved','closed')) as active_tickets
    FROM users u ORDER BY u.role, u.full_name
  `).all();

  const companies = db.prepare('SELECT * FROM companies WHERE is_active = 1 ORDER BY name').all();

  // For each user, get assigned companies
  users.forEach(u => {
    u.companies = db.prepare(`
      SELECT c.id, c.name FROM user_companies uc 
      JOIN companies c ON uc.company_id = c.id 
      WHERE uc.user_id = ?
    `).all(u.id);
  });

  res.render('admin/users', { users, companies, query: req.query, title: 'Gestion des utilisateurs' });
});

// ─── Create User ─────────────────────────────────────
router.post('/users/create', (req, res) => {
  const db = getDb();
  const masterDb = getMasterDb();
  const { username, email, password, full_name, role } = req.body;
  const companyIds = req.body.company_ids || [];
  const colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  try {
    const hash = bcrypt.hashSync(password, 10);

    // Insert into tenant DB (users table)
    const result = db.prepare(`
      INSERT INTO users (username, email, password, full_name, role, avatar_color)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, email.toLowerCase().trim(), hash, full_name, role, color);

    // Insert into master DB (accounts table) so login works
    const tenantId = req.session.tenantId;
    try {
      masterDb.prepare(`
        INSERT INTO accounts (email, password, full_name, tenant_id, is_owner)
        VALUES (?, ?, ?, ?, 0)
      `).run(email.toLowerCase().trim(), hash, full_name, tenantId);
    } catch (e) {
      // Account might already exist in master (e.g. previously deleted)
      console.warn('[Admin] Account insert warning:', e.message);
    }

    // Assign companies
    const userId = result.lastInsertRowid;
    const cIds = Array.isArray(companyIds) ? companyIds : (companyIds ? [companyIds] : []);
    for (const cid of cIds) {
      try { db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)').run(userId, parseInt(cid)); } catch (e) { /* skip */ }
    }

    res.redirect('/admin/users');
  } catch (err) {
    console.error('[Admin] User create error:', err.message);
    res.redirect('/admin/users?error=duplicate');
  }
});

// ─── Edit User (GET) ────────────────────────────────
router.get('/users/:id/edit', (req, res) => {
  const db = getDb();
  const editUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!editUser) return res.redirect('/admin/users');

  const companies = db.prepare('SELECT * FROM companies WHERE is_active = 1 ORDER BY name').all();
  const userCompanyIds = db.prepare('SELECT company_id FROM user_companies WHERE user_id = ?').all(editUser.id).map(r => r.company_id);

  res.render('admin/user-edit', { editUser, companies, userCompanyIds, title: 'Modifier ' + editUser.full_name });
});

// ─── Edit User (POST) ───────────────────────────────
router.post('/users/:id/edit', (req, res) => {
  const db = getDb();
  const masterDb = getMasterDb();
  const editUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!editUser) return res.redirect('/admin/users');

  const { full_name, role, new_password } = req.body;
  const companyIds = req.body.company_ids || [];

  // Update name & role in tenant DB
  db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?')
    .run(full_name.trim(), role, editUser.id);

  // Update name in master DB
  masterDb.prepare('UPDATE accounts SET full_name = ? WHERE email = ? AND tenant_id = ?')
    .run(full_name.trim(), editUser.email, req.session.tenantId);

  // Update password if provided
  if (new_password && new_password.trim().length >= 4) {
    const hash = bcrypt.hashSync(new_password.trim(), 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, editUser.id);
    masterDb.prepare('UPDATE accounts SET password = ? WHERE email = ? AND tenant_id = ?')
      .run(hash, editUser.email, req.session.tenantId);
  }

  // Update company assignments
  db.prepare('DELETE FROM user_companies WHERE user_id = ?').run(editUser.id);
  const cIds = Array.isArray(companyIds) ? companyIds : (companyIds ? [companyIds] : []);
  for (const cid of cIds) {
    try { db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)').run(editUser.id, parseInt(cid)); } catch (e) { /* skip */ }
  }

  // Update session if editing self
  if (editUser.id === req.session.user.id) {
    req.session.user.full_name = full_name.trim();
    req.session.user.role = role;
  }

  res.redirect('/admin/users');
});

// ─── Toggle User Active ──────────────────────────────
router.post('/users/:id/toggle', (req, res) => {
  const db = getDb();
  const masterDb = getMasterDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (user && user.id !== req.session.user.id) {
    const newState = user.is_active ? 0 : 1;
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newState, req.params.id);
    // Sync to master DB
    masterDb.prepare('UPDATE accounts SET is_active = ? WHERE email = ? AND tenant_id = ?')
      .run(newState, user.email, req.session.tenantId);
  }
  res.redirect('/admin/users');
});

// ═══════════════════════════════════════════════════════
//  COMPANY / WORKSPACE MANAGEMENT
// ═══════════════════════════════════════════════════════

router.get('/companies', (req, res) => {
  const db = getDb();
  const companies = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM user_companies WHERE company_id = c.id) as user_count,
      (SELECT COUNT(*) FROM tickets WHERE company_id = c.id) as ticket_count,
      (SELECT COUNT(*) FROM articles WHERE company_id = c.id AND is_published = 1) as article_count
    FROM companies c ORDER BY c.name
  `).all();

  res.render('admin/companies', { companies, query: req.query, title: 'Gestion des entreprises' });
});

router.post('/companies/create', (req, res) => {
  const db = getDb();
  const { createDefaultCategories } = require('../database');
  const { name, contact_email, website, description } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);

  try {
    const result = db.prepare(`
      INSERT INTO companies (name, slug, contact_email, website, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), slug || 'company-' + Date.now(), (contact_email || '').trim(), (website || '').trim(), (description || '').trim());

    // Create default FAQ categories for this company
    createDefaultCategories(db, result.lastInsertRowid);

    res.redirect('/admin/companies/' + result.lastInsertRowid + '/workspace');
  } catch (err) {
    res.redirect('/admin/companies?error=duplicate');
  }
});

// ─── Company Workspace (full settings page) ─────────
router.get('/companies/:id/workspace', (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!company) return res.redirect('/admin/companies');

  const assignedUsers = db.prepare(`
    SELECT u.id, u.full_name, u.email, u.role FROM user_companies uc
    JOIN users u ON uc.user_id = u.id WHERE uc.company_id = ?
  `).all(company.id);

  const allUsers = db.prepare('SELECT id, full_name, email, role FROM users WHERE is_active = 1 ORDER BY full_name').all();

  const categories = db.prepare('SELECT * FROM article_categories WHERE company_id = ? ORDER BY position').all(company.id);
  const articleCount = db.prepare('SELECT COUNT(*) as c FROM articles WHERE company_id = ? AND is_published = 1').get(company.id).c;
  const kbCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_base WHERE company_id = ?').get(company.id).c;
  const ticketCount = db.prepare('SELECT COUNT(*) as c FROM tickets WHERE company_id = ?').get(company.id).c;

  const aiProfiles = require('../ai-profiles').profiles;

  res.render('admin/company-workspace', {
    company, assignedUsers, allUsers, categories,
    articleCount, kbCount, ticketCount, aiProfiles,
    saved: req.query.saved === '1',
    tab: req.query.tab || 'general',
    title: company.name + ' — Workspace'
  });
});

router.post('/companies/:id/workspace', (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!company) return res.redirect('/admin/companies');

  const {
    name, contact_email, website, description,
    brand_color, brand_color_dark, chatbot_name, chatbot_context,
    ai_profile, translation_languages, industry_context, tab
  } = req.body;
  const userIds = req.body.user_ids || [];

  // Update company fields
  db.prepare(`
    UPDATE companies SET
      name=?, contact_email=?, website=?, description=?,
      brand_color=?, brand_color_dark=?, chatbot_name=?,
      chatbot_context=?, ai_profile=?,
      translation_languages=?,
      auto_translate_articles=?,
      ai_livechat_faq_first=?,
      industry_context=?,
      help_center_enabled=?,
      livechat_enabled=?
    WHERE id=?
  `).run(
    (name || company.name).trim(),
    (contact_email || '').trim(),
    (website || '').trim(),
    (description || '').trim(),
    brand_color || '#6366f1',
    brand_color_dark || '#818cf8',
    (chatbot_name || 'Assistant').trim(),
    (chatbot_context || '').trim(),
    ai_profile || 'generic',
    (translation_languages || 'en').trim(),
    req.body.auto_translate_articles ? 1 : 0,
    req.body.ai_livechat_faq_first ? 1 : 0,
    (industry_context || '').trim(),
    req.body.help_center_enabled ? 1 : 0,
    req.body.livechat_enabled ? 1 : 0,
    req.params.id
  );

  // Update user assignments
  db.prepare('DELETE FROM user_companies WHERE company_id = ?').run(parseInt(req.params.id));
  const uIds = Array.isArray(userIds) ? userIds : (userIds ? [userIds] : []);
  for (const uid of uIds) {
    try { db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)').run(parseInt(uid), parseInt(req.params.id)); } catch (e) { /* skip */ }
  }

  res.redirect('/admin/companies/' + req.params.id + '/workspace?saved=1&tab=' + (tab || 'general'));
});

router.post('/companies/:id/toggle', (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (c) db.prepare('UPDATE companies SET is_active = ? WHERE id = ?').run(c.is_active ? 0 : 1, req.params.id);
  res.redirect('/admin/companies');
});

// ─── Company articles shortcut ──────────────────────
router.get('/companies/:id/articles', (req, res) => {
  res.redirect('/admin/articles?company=' + req.params.id);
});

// ─── Company Logo Upload ─────────────────────────────
router.post('/companies/:id/logo', (req, res) => {
  const multer = require('multer');
  const path = require('path');
  const upload = multer({
    dest: path.join(__dirname, '..', 'public', 'uploads', 'logos'),
    limits: { fileSize: 512 * 1024 },
    fileFilter: (req, file, cb) => {
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) cb(null, true);
      else cb(new Error('Invalid file type'));
    }
  }).single('logo');

  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const fs = require('fs');
    const ext = path.extname(req.file.originalname) || '.png';
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);
    const logoUrl = '/uploads/logos/' + path.basename(newPath);

    const db = getDb();
    db.prepare('UPDATE companies SET logo_url = ? WHERE id = ?').run(logoUrl, req.params.id);
    res.json({ ok: true, url: logoUrl });
  });
});

module.exports = router;
