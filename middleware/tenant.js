// ═══════════════════════════════════════════════════════
//  Tenant Middleware — resolves tenant from session
//  and sets up AsyncLocalStorage context so getDb()
//  returns the correct tenant DB transparently
// ═══════════════════════════════════════════════════════

const { requestStore, getTenantDb, getTenant, isTenantActive, getTrialDaysLeft, getTenantPlan } = require('../database');

// Paths that don't require a tenant context
const PUBLIC_PATHS = [
  '/login', '/register', '/logout', '/lang/',
  '/css/', '/js/', '/images/', '/fonts/', '/favicon',
  '/uploads/',   // uploaded logos
  '/help',       // public help center
  '/api/chat/',  // livechat uses tenant slug in body
  '/superadmin', // platform admin (no tenant context)
];

function isPublicPath(path) {
  return PUBLIC_PATHS.some(p => path.startsWith(p));
}

/**
 * Tenant middleware — wraps each request in AsyncLocalStorage
 * with the correct tenant DB based on session.tenantId
 */
function tenantMiddleware(req, res, next) {
  let tenantId = req.session?.tenantId;

  // ─── Fallback for public chat/help routes: use saved chatTenantId ───
  if (!tenantId && req.session?.chatTenantId && (req.path.startsWith('/api/chat/') || req.path.startsWith('/help'))) {
    tenantId = req.session.chatTenantId;
  }

  // No tenant in session → skip ALS (public pages handle themselves)
  if (!tenantId) {
    if (isPublicPath(req.path)) return next();
    // Authenticated paths without tenant → redirect to login
    if (req.session?.user) {
      // User session exists but no tenant → corrupted session
      req.session.destroy();
    }
    return res.redirect('/login');
  }

  // Check tenant is still active
  if (!isTenantActive(tenantId)) {
    // Trial expired or tenant deactivated
    const tenant = getTenant(tenantId);
    if (tenant && tenant.plan_id === 'trial') {
      // Don't destroy session — let them see the upgrade page
      res.locals.trialExpired = true;
    }
  }

  // Get tenant DB and wrap request in ALS context
  try {
    const db = getTenantDb(tenantId);
    requestStore.run({ db, tenantId }, () => {
      // Inject tenant info into res.locals for views
      const tenant = getTenant(tenantId);
      const plan = getTenantPlan(tenantId);
      res.locals.tenant = tenant;
      res.locals.tenantPlan = plan;
      res.locals.trialDaysLeft = getTrialDaysLeft(tenant);
      res.locals.tenantId = tenantId;
      next();
    });
  } catch (e) {
    console.error('[Tenant] DB error for tenant', tenantId, ':', e.message);
    return res.status(500).render('error', {
      user: req.session?.user, title: 'Erreur', message: 'Erreur de base de données.', code: 500
    });
  }
}

module.exports = { tenantMiddleware, isPublicPath };
