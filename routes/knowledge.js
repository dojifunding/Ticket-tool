const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, logActivity } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const ai = require('../ai');

router.use(isAuthenticated);

// File upload config
const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.md', '.csv', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ─── Helper: render KB page with flash ───────────────
function renderKB(req, res, flash) {
  const db = getDb();
  const entries = db.prepare(`
    SELECT kb.*, u.full_name as author_name
    FROM knowledge_base kb
    LEFT JOIN users u ON kb.added_by = u.id
    ORDER BY kb.created_at DESC
  `).all();

  res.render('admin/knowledge', {
    entries,
    aiConfigured: ai.isConfigured(),
    title: res.locals.t.kb_title,
    flash: flash || req.session._kbFlash || null
  });
  delete req.session._kbFlash;
}

// ─── Knowledge Base List ─────────────────────────────
router.get('/', (req, res) => renderKB(req, res));

// ─── Add Text Entry ──────────────────────────────────
router.post('/add-text', (req, res) => {
  const db = getDb();
  const t = res.locals.t;
  const { title, content } = req.body;

  if (!title || !content) {
    req.session._kbFlash = { type: 'error', msg: t.kb_flash_required };
    return res.redirect('/admin/knowledge');
  }

  db.prepare('INSERT INTO knowledge_base (title, content, source_type, added_by) VALUES (?,?,?,?)')
    .run(title, content, 'text', req.session.user.id);

  logActivity(req.session.user.id, 'added', 'knowledge', 0, title);
  req.session._kbFlash = { type: 'success', msg: t.kb_flash_added.replace('{title}', title) };
  res.redirect('/admin/knowledge');
});

// ─── Add from URL ────────────────────────────────────
router.post('/add-url', async (req, res) => {
  const db = getDb();
  const t = res.locals.t;
  const { title, url } = req.body;

  if (!url) {
    req.session._kbFlash = { type: 'error', msg: t.kb_flash_url_required };
    return res.redirect('/admin/knowledge');
  }

  try {
    console.log('[KB] Fetching URL:', url);
    const result = await ai.extractFromUrl(url);

    if (!result.processed || result.processed.trim().length < 20) {
      req.session._kbFlash = { type: 'error', msg: t.kb_flash_url_empty };
      return res.redirect('/admin/knowledge');
    }

    const finalTitle = title || 'Import: ' + url.substring(0, 60);
    db.prepare('INSERT INTO knowledge_base (title, content, source_type, source_ref, added_by) VALUES (?,?,?,?,?)')
      .run(finalTitle, result.processed, 'url', url, req.session.user.id);

    logActivity(req.session.user.id, 'added', 'knowledge', 0, finalTitle);
    req.session._kbFlash = { type: 'success', msg: t.kb_flash_url_ok.replace('{title}', finalTitle) };
  } catch (e) {
    console.error('[KB] URL import error:', e.message);
    req.session._kbFlash = { type: 'error', msg: t.kb_flash_url_error + ' ' + e.message };
  }

  res.redirect('/admin/knowledge');
});

// ─── Add from File ───────────────────────────────────
router.post('/add-file', upload.single('file'), async (req, res) => {
  const db = getDb();
  const t = res.locals.t;

  if (!req.file) {
    req.session._kbFlash = { type: 'error', msg: t.kb_flash_file_required };
    return res.redirect('/admin/knowledge');
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const title = req.body.title || req.file.originalname;
  let content = '';

  try {
    if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
      content = fs.readFileSync(req.file.path, 'utf-8');
      if (content.length > 20000) content = content.substring(0, 20000) + '\n...(truncated)';
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      if (ai.isConfigured()) {
        const imgData = fs.readFileSync(req.file.path);
        const base64 = imgData.toString('base64');
        const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
        content = await ai.analyzeImage(base64, mimeMap[ext] || 'image/png', req.body.instruction || null);
      } else {
        content = `[Image: ${req.file.originalname}] — AI not configured for image analysis.`;
      }
    } else if (ext === '.pdf') {
      content = `[PDF: ${req.file.originalname}] — PDF content: ` + (req.body.description || 'No description provided.');
    }

    if (!content || content.trim().length < 5) {
      req.session._kbFlash = { type: 'error', msg: t.kb_flash_file_empty };
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/admin/knowledge');
    }

    db.prepare('INSERT INTO knowledge_base (title, content, source_type, source_ref, added_by) VALUES (?,?,?,?,?)')
      .run(title, content, ext.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? 'image' : 'file', req.file.originalname, req.session.user.id);

    logActivity(req.session.user.id, 'added', 'knowledge', 0, title);
    req.session._kbFlash = { type: 'success', msg: t.kb_flash_added.replace('{title}', title) };
  } catch (e) {
    console.error('[KB] File import error:', e.message);
    req.session._kbFlash = { type: 'error', msg: t.kb_flash_file_error + ' ' + e.message };
  }

  try { fs.unlinkSync(req.file.path); } catch (e) {}
  res.redirect('/admin/knowledge');
});

// ─── Edit Entry ──────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const db = getDb();
  const { title, content } = req.body;
  db.prepare('UPDATE knowledge_base SET title=?, content=? WHERE id=?').run(title, content, req.params.id);
  req.session._kbFlash = { type: 'success', msg: '✅' };
  res.redirect('/admin/knowledge');
});

// ─── Toggle Active ───────────────────────────────────
router.post('/:id/toggle', (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT is_active FROM knowledge_base WHERE id=?').get(req.params.id);
  if (entry) {
    db.prepare('UPDATE knowledge_base SET is_active=? WHERE id=?').run(entry.is_active ? 0 : 1, req.params.id);
  }
  res.redirect('/admin/knowledge');
});

// ─── Delete Entry ────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM knowledge_base WHERE id=?').run(req.params.id);
  res.redirect('/admin/knowledge');
});

module.exports = router;
