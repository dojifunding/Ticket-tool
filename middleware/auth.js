// ═══════════════════════════════════════════════════════
//  Auth Middleware — tenant-aware
// ═══════════════════════════════════════════════════════

const { getTranslations, getDateLocale } = require('../i18n');

function injectUser(req, res, next) {
  // User from session
  res.locals.user = req.session?.user || null;
  res.locals.currentPath = req.path;

  // Translations
  const lang = req.session?.lang || 'fr';
  res.locals.t = getTranslations(lang);
  res.locals.dateLocale = getDateLocale(lang);

  // Defaults for templates (prevent undefined errors)
  if (!res.locals.tenant) res.locals.tenant = null;
  if (!res.locals.tenantPlan) res.locals.tenantPlan = null;
  if (res.locals.trialDaysLeft === undefined) res.locals.trialDaysLeft = -1;
  if (!res.locals.tenantId) res.locals.tenantId = null;
  if (res.locals.trialExpired === undefined) res.locals.trialExpired = false;

  next();
}

function isAuthenticated(req, res, next) {
  if (req.session?.user) return next();
  res.redirect('/login');
}

function isDeveloper(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (['admin', 'developer'].includes(req.session.user.role)) return next();
  res.status(403).render('error', { user: req.session.user, title: 'Forbidden', message: '', code: 403 });
}

function isSupport(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (['admin', 'support'].includes(req.session.user.role)) return next();
  res.status(403).render('error', { user: req.session.user, title: 'Forbidden', message: '', code: 403 });
}

function isAdmin(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (req.session.user.role === 'admin') return next();
  res.status(403).render('error', { user: req.session.user, title: 'Forbidden', message: '', code: 403 });
}

// Check if onboarding is completed, redirect if not
function requireOnboarding(req, res, next) {
  if (!req.session?.tenantId) return next();
  const tenant = res.locals.tenant;
  if (tenant && !tenant.onboarding_completed) {
    // Allow access to onboarding routes
    if (req.path.startsWith('/onboarding') || req.path.startsWith('/lang/')) return next();
    return res.redirect('/onboarding');
  }
  next();
}

// Check trial expiration — block access if expired (except upgrade page)
function requireActiveTenant(req, res, next) {
  if (res.locals.trialExpired && !req.path.startsWith('/account')) {
    return res.redirect('/account/upgrade');
  }
  next();
}

module.exports = { injectUser, isAuthenticated, isDeveloper, isSupport, isAdmin, requireOnboarding, requireActiveTenant };
