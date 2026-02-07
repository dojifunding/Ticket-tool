const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const { getTranslations } = require('../i18n');

// ─── Language Switch ────────────────────────────────
router.get('/lang/:code', (req, res) => {
  const lang = ['fr', 'en'].includes(req.params.code) ? req.params.code : 'fr';
  req.session.lang = lang;
  res.redirect(req.headers.referer || '/');
});

// ─── Login Page ──────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const t = getTranslations(req.session?.lang || 'fr');
  res.render('login', { error: null, user: null, t });
});

// ─── Login Action ────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const t = getTranslations(req.session?.lang || 'fr');

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: t.login_error, user: null, t });
  }

  // Update last seen
  db.prepare('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

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

// ─── Logout ──────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─── Dashboard Redirect ─────────────────────────────
router.get('/', isAuthenticated, (req, res) => {
  const role = req.session.user.role;
  if (role === 'admin') return res.redirect('/admin');
  if (role === 'developer') return res.redirect('/projects');
  if (role === 'support') return res.redirect('/tickets');
  res.redirect('/login');
});

module.exports = router;
