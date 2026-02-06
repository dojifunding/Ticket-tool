// ─── Authentication & Authorization Middleware ────

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') {
    return next();
  }
  res.status(403).render('error', {
    user: req.session?.user,
    title: 'Accès refusé',
    message: 'Vous n\'avez pas les permissions nécessaires.',
    code: 403
  });
}

function isDeveloper(req, res, next) {
  const role = req.session?.user?.role;
  if (role === 'admin' || role === 'developer') {
    return next();
  }
  res.status(403).render('error', {
    user: req.session?.user,
    title: 'Accès refusé',
    message: 'Cette section est réservée aux développeurs.',
    code: 403
  });
}

function isSupport(req, res, next) {
  const role = req.session?.user?.role;
  if (role === 'admin' || role === 'support') {
    return next();
  }
  res.status(403).render('error', {
    user: req.session?.user,
    title: 'Accès refusé',
    message: 'Cette section est réservée à l\'équipe support.',
    code: 403
  });
}

function injectUser(req, res, next) {
  res.locals.user = req.session?.user || null;
  res.locals.currentPath = req.path;
  next();
}

module.exports = { isAuthenticated, isAdmin, isDeveloper, isSupport, injectUser };
