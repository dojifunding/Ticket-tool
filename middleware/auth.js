const { getDb } = require('../database');
const { getTranslations, getDateLocale } = require('../i18n');

function injectUser(req, res, next) {
  if (req.session && req.session.user) {
    res.locals.user = req.session.user;
  } else {
    res.locals.user = null;
  }
  res.locals.currentPath = req.path;

  // Inject translations
  const lang = req.session?.lang || 'fr';
  res.locals.t = getTranslations(lang);
  res.locals.dateLocale = getDateLocale(lang);

  next();
}

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
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

module.exports = { injectUser, isAuthenticated, isDeveloper, isSupport, isAdmin };
