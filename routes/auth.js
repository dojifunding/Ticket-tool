// ═══════════════════════════════════════════════════════
//  Auth Routes — Login, Register, Logout
//  Multi-tenant aware
// ═══════════════════════════════════════════════════════

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getMasterDb, getTenantDb, createTenant, getTenant, isTenantActive, requestStore } = require('../database');
const { isAuthenticated, requireOnboarding, requireActiveTenant } = require('../middleware/auth');
const { getTranslations } = require('../i18n');

// ─── Language Switch ────────────────────────────────
router.get('/lang/:code', (req, res) => {
  const lang = ['fr','en','es','de'].includes(req.params.code) ? req.params.code : 'fr';
  req.session.lang = lang;
  res.redirect(req.headers.referer || '/');
});

// ─── Register Page ──────────────────────────────────
router.get('/register', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const t = getTranslations(req.session?.lang || 'fr');
  res.render('register', { error: null, user: null, t, values: {} });
});

// ─── Register Action ────────────────────────────────
router.post('/register', (req, res) => {
  const { full_name, email, password, password_confirm, company_name } = req.body;
  const t = getTranslations(req.session?.lang || 'fr');
  const values = { full_name, email, company_name };

  // Validation
  if (!full_name || !email || !password || !company_name) {
    return res.render('register', { error: t.register_error_required || 'Tous les champs sont obligatoires.', user: null, t, values });
  }
  if (password.length < 6) {
    return res.render('register', { error: t.register_error_password_length || 'Le mot de passe doit contenir au moins 6 caractères.', user: null, t, values });
  }
  if (password !== password_confirm) {
    return res.render('register', { error: t.register_error_password_match || 'Les mots de passe ne correspondent pas.', user: null, t, values });
  }

  const masterDb = getMasterDb();

  // Check email uniqueness
  const existingAccount = masterDb.prepare('SELECT id FROM accounts WHERE email = ?').get(email.toLowerCase().trim());
  if (existingAccount) {
    return res.render('register', { error: t.register_error_email_exists || 'Cet email est déjà utilisé.', user: null, t, values });
  }

  // Generate slug from company name
  let slug = company_name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .substring(0, 40);

  // Ensure unique slug
  let finalSlug = slug;
  let counter = 1;
  while (masterDb.prepare('SELECT id FROM tenants WHERE slug = ?').get(finalSlug)) {
    finalSlug = slug + '-' + counter++;
  }

  try {
    // Create tenant + account + tenant DB
    const { tenantId, trialEnd } = createTenant(company_name.trim(), finalSlug, email.toLowerCase().trim(), password, full_name.trim());

    // Log in immediately
    const tenantDb = getTenantDb(tenantId);
    const user = tenantDb.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

    req.session.tenantId = tenantId;
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      avatar_color: user.avatar_color
    };

    // Update last login
    masterDb.prepare('UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE email = ?').run(email.toLowerCase().trim());

    // Redirect to onboarding
    res.redirect('/onboarding');
  } catch (e) {
    console.error('[Register] Error:', e.message);
    return res.render('register', { error: t.register_error_generic || 'Une erreur est survenue. Veuillez réessayer.', user: null, t, values });
  }
});

// ─── Login Page ─────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.user && req.session?.tenantId) return res.redirect('/');
  const t = getTranslations(req.session?.lang || 'fr');
  res.render('login', { error: null, user: null, t });
});

// ─── Login Action ───────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const t = getTranslations(req.session?.lang || 'fr');

  if (!email || !password) {
    return res.render('login', { error: t.login_error || 'Identifiants incorrects.', user: null, t });
  }

  const masterDb = getMasterDb();

  // Find account in master DB
  const account = masterDb.prepare('SELECT * FROM accounts WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
  if (!account || !bcrypt.compareSync(password, account.password)) {
    return res.render('login', { error: t.login_error || 'Email ou mot de passe incorrect.', user: null, t });
  }

  // Check tenant is active
  if (!account.tenant_id || !isTenantActive(account.tenant_id)) {
    const tenant = getTenant(account.tenant_id);
    if (tenant && tenant.plan_id === 'trial') {
      // Allow login but mark trial expired — they'll be redirected to upgrade
      // Don't block login entirely
    } else {
      return res.render('login', { error: t.login_error_tenant_inactive || 'Votre compte est désactivé. Contactez le support.', user: null, t });
    }
  }

  // Find user in tenant DB
  const tenantDb = getTenantDb(account.tenant_id);
  const user = tenantDb.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());
  if (!user) {
    return res.render('login', { error: t.login_error || 'Compte non trouvé dans cet espace.', user: null, t });
  }

  // Update last seen
  tenantDb.prepare('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  masterDb.prepare('UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(account.id);

  // Set session
  req.session.tenantId = account.tenant_id;
  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    avatar_color: user.avatar_color
  };

  res.redirect('/');
});

// ─── Logout ─────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─── Dashboard Redirect ─────────────────────────────
router.get('/', isAuthenticated, (req, res, next) => {
  // Check onboarding
  const tenant = res.locals.tenant;
  if (tenant && !tenant.onboarding_completed) {
    return res.redirect('/onboarding');
  }

  const role = req.session.user.role;
  if (role === 'admin') return res.redirect('/admin');
  if (role === 'developer') return res.redirect('/projects');
  if (role === 'support') return res.redirect('/tickets');
  res.redirect('/admin');
});

module.exports = router;
