// ═══════════════════════════════════════════════════════
//  Onboarding Wizard — Setup new tenant
//  Steps: Company → AI Config → Import KB → Done
// ═══════════════════════════════════════════════════════

const router = require('express').Router();
const { isAuthenticated } = require('../middleware/auth');
const { getMasterDb, getDb, getSetting, setSetting } = require('../database');
const { getTranslations } = require('../i18n');

router.use(isAuthenticated);

// ─── Main Onboarding Page ───────────────────────────
router.get('/', (req, res) => {
  const t = res.locals.t;
  const tenant = res.locals.tenant;

  // Already completed? Go to dashboard
  if (tenant && tenant.onboarding_completed) {
    return res.redirect('/');
  }

  res.render('onboarding', { t, tenant });
});

// ─── Save Step 1: Company Info ──────────────────────
router.post('/step1', (req, res) => {
  const { company_name, company_type, company_website, locale } = req.body;
  const tenantId = req.session.tenantId;
  const masterDb = getMasterDb();

  masterDb.prepare('UPDATE tenants SET company_type=?, company_website=?, locale=?, name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(company_type || '', company_website || '', locale || 'fr', company_name || res.locals.tenant.name, tenantId);

  // Also update the tenant-level setting
  const db = getDb();
  setSetting('company_name', company_name || '');

  res.json({ ok: true });
});

// ─── Save Step 2: AI Configuration ─────────────────
router.post('/step2', (req, res) => {
  const { ai_enabled, ai_tickets, ai_livechat, ai_faq, ai_profile, custom_ai_context } = req.body;
  const tenantId = req.session.tenantId;
  const masterDb = getMasterDb();

  masterDb.prepare(`UPDATE tenants SET
    ai_enabled=?, ai_tickets=?, ai_livechat=?, ai_faq=?,
    ai_profile=?, custom_ai_context=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(
      ai_enabled ? 1 : 0, ai_tickets ? 1 : 0, ai_livechat ? 1 : 0, ai_faq ? 1 : 0,
      ai_profile || 'generic', custom_ai_context || '',
      tenantId
    );

  // Also store custom context in tenant DB settings for backward compat
  setSetting('chatbot_context', custom_ai_context || '');

  res.json({ ok: true });
});

// ─── Save Step 3: KB Resources ──────────────────────
router.post('/step3', (req, res) => {
  // This step is optional — KB import happens on the KB page
  // Just mark that the user has seen this step
  res.json({ ok: true });
});

// ─── Complete Onboarding ────────────────────────────
router.post('/complete', (req, res) => {
  const tenantId = req.session.tenantId;
  const masterDb = getMasterDb();

  masterDb.prepare('UPDATE tenants SET onboarding_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(tenantId);

  res.json({ ok: true, redirect: '/' });
});

// ─── Skip Onboarding ───────────────────────────────
router.post('/skip', (req, res) => {
  const tenantId = req.session.tenantId;
  const masterDb = getMasterDb();

  masterDb.prepare('UPDATE tenants SET onboarding_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(tenantId);

  res.json({ ok: true, redirect: '/' });
});

module.exports = router;
