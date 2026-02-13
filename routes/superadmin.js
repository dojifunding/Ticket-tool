// ═══════════════════════════════════════════════════════
//  Super Admin Routes — Platform Owner Management
//  Access: SUPERADMIN_EMAIL + SUPERADMIN_PASSWORD env vars
// ═══════════════════════════════════════════════════════

const router = require('express').Router();
const { getMasterDb, getTenantDb, getTenantDir } = require('../database');
const path = require('path');
const fs = require('fs');

// ─── Auth Middleware ─────────────────────────────────
function requireSuperAdmin(req, res, next) {
  if (req.session?.isSuperAdmin) return next();
  res.redirect('/superadmin/login');
}

// ─── Login Page ─────────────────────────────────────
router.get('/login', (req, res) => {
  const configured = !!(process.env.SUPERADMIN_EMAIL && process.env.SUPERADMIN_PASSWORD);
  res.render('superadmin/login', { error: null, configured });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const saEmail = process.env.SUPERADMIN_EMAIL;
  const saPassword = process.env.SUPERADMIN_PASSWORD;

  if (!saEmail || !saPassword) {
    return res.render('superadmin/login', { error: 'Super admin non configuré. Définissez SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD.', configured: false });
  }

  if (email?.toLowerCase() === saEmail.toLowerCase() && password === saPassword) {
    req.session.isSuperAdmin = true;
    req.session.superAdminEmail = email;
    return res.redirect('/superadmin');
  }

  res.render('superadmin/login', { error: 'Email ou mot de passe incorrect.', configured: true });
});

router.get('/logout', (req, res) => {
  req.session.isSuperAdmin = false;
  req.session.superAdminEmail = null;
  res.redirect('/superadmin/login');
});

// ─── All routes below require superadmin ─────────────
router.use(requireSuperAdmin);

// ─── Dashboard ──────────────────────────────────────
router.get('/', (req, res) => {
  const masterDb = getMasterDb();

  // Tenants
  const tenants = masterDb.prepare(`
    SELECT t.*, p.name as plan_name, p.price_monthly,
      (SELECT COUNT(*) FROM accounts a WHERE a.tenant_id = t.id) as account_count
    FROM tenants t
    LEFT JOIN plans p ON t.plan_id = p.id
    ORDER BY t.created_at DESC
  `).all();

  // Stats
  const totalTenants = tenants.length;
  const activeTenants = tenants.filter(t => t.is_active).length;
  const trialTenants = tenants.filter(t => t.plan_id === 'trial').length;
  const paidTenants = tenants.filter(t => t.plan_id !== 'trial' && t.is_active).length;

  // Revenue
  const mrr = tenants.reduce((sum, t) => {
    if (t.plan_id !== 'trial' && t.is_active) return sum + (t.price_monthly || 0);
    return sum;
  }, 0);

  // AI usage across all tenants
  let totalAiCalls = 0, totalAiTokens = 0, totalAiCost = 0;
  const tenantAiUsage = [];

  for (const tenant of tenants) {
    try {
      const tenantDb = getTenantDb(tenant.id);
      const usage = tenantDb.prepare(`
        SELECT COUNT(*) as calls, COALESCE(SUM(tokens_estimate),0) as tokens, COALESCE(SUM(cost_estimate),0) as cost
        FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')
      `).get();

      totalAiCalls += usage.calls;
      totalAiTokens += usage.tokens;
      totalAiCost += usage.cost;

      tenantAiUsage.push({
        tenant_id: tenant.id,
        name: tenant.name,
        plan: tenant.plan_id,
        calls: usage.calls,
        tokens: usage.tokens,
        cost: parseFloat(usage.cost.toFixed(4))
      });
    } catch (e) {
      // DB might not exist yet
    }
  }

  // Sort by AI cost descending
  tenantAiUsage.sort((a, b) => b.cost - a.cost);

  // Plans distribution
  const planStats = masterDb.prepare(`
    SELECT p.name, p.id as plan_id, COUNT(t.id) as count
    FROM plans p LEFT JOIN tenants t ON t.plan_id = p.id AND t.is_active = 1
    GROUP BY p.id ORDER BY p.position
  `).all();

  res.render('superadmin/dashboard', {
    tenants, totalTenants, activeTenants, trialTenants, paidTenants,
    mrr, totalAiCalls, totalAiTokens, totalAiCost: parseFloat(totalAiCost.toFixed(4)),
    tenantAiUsage, planStats,
    email: req.session.superAdminEmail
  });
});

// ─── Tenant Detail ──────────────────────────────────
router.get('/tenant/:id', (req, res) => {
  const masterDb = getMasterDb();

  const tenant = masterDb.prepare('SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN plans p ON t.plan_id = p.id WHERE t.id = ?').get(req.params.id);
  if (!tenant) return res.redirect('/superadmin');

  const accounts = masterDb.prepare('SELECT * FROM accounts WHERE tenant_id = ? ORDER BY created_at').all(tenant.id);
  const plans = masterDb.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY position').all();

  // AI usage
  let aiUsage = { calls: 0, tokens: 0, cost: 0 };
  let aiByDay = [];
  let ticketCount = 0, articleCount = 0, kbCount = 0;

  try {
    const tenantDb = getTenantDb(tenant.id);
    aiUsage = tenantDb.prepare(`
      SELECT COUNT(*) as calls, COALESCE(SUM(tokens_estimate),0) as tokens, COALESCE(SUM(cost_estimate),0) as cost
      FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')
    `).get();

    aiByDay = tenantDb.prepare(`
      SELECT date(created_at) as day, COUNT(*) as calls, COALESCE(SUM(tokens_estimate),0) as tokens, COALESCE(ROUND(SUM(cost_estimate),4),0) as cost
      FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')
      GROUP BY date(created_at) ORDER BY day DESC LIMIT 14
    `).all();

    ticketCount = tenantDb.prepare('SELECT COUNT(*) as c FROM tickets').get().c;
    articleCount = tenantDb.prepare('SELECT COUNT(*) as c FROM articles WHERE is_published=1').get().c;
    kbCount = tenantDb.prepare('SELECT COUNT(*) as c FROM knowledge_base').get().c;
  } catch (e) { /* tenant DB might not exist */ }

  res.render('superadmin/tenant', {
    tenant, accounts, plans, aiUsage, aiByDay,
    ticketCount, articleCount, kbCount,
    email: req.session.superAdminEmail
  });
});

// ─── Update Tenant ──────────────────────────────────
router.post('/tenant/:id', (req, res) => {
  const masterDb = getMasterDb();
  const { plan_id, is_active, ai_enabled, ai_calls_limit } = req.body;

  masterDb.prepare(`
    UPDATE tenants SET plan_id=?, is_active=?, ai_enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(plan_id, is_active === 'on' ? 1 : 0, ai_enabled === 'on' ? 1 : 0, req.params.id);

  // Store AI calls limit in tenant
  if (ai_calls_limit !== undefined) {
    try {
      const cols = masterDb.pragma('table_info(tenants)').map(c => c.name);
      if (!cols.includes('ai_calls_limit')) {
        masterDb.exec('ALTER TABLE tenants ADD COLUMN ai_calls_limit INTEGER DEFAULT -1');
      }
      masterDb.prepare('UPDATE tenants SET ai_calls_limit=? WHERE id=?').run(parseInt(ai_calls_limit) || -1, req.params.id);
    } catch (e) { /* ignore */ }
  }

  res.redirect('/superadmin/tenant/' + req.params.id + '?saved=1');
});

// ─── Delete Tenant ──────────────────────────────────
router.post('/tenant/:id/delete', (req, res) => {
  const masterDb = getMasterDb();

  // Deactivate (soft delete)
  masterDb.prepare('UPDATE tenants SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  masterDb.prepare('UPDATE accounts SET is_active=0 WHERE tenant_id=?').run(req.params.id);

  res.redirect('/superadmin?deleted=1');
});

module.exports = router;
