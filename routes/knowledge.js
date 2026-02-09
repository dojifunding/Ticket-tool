const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb, logActivity } = require('../database');
const { isAuthenticated } = require('../middleware/auth');
const ai = require('../ai');

router.use(isAuthenticated);

// ─── Async Job Queue (avoids Render 30s timeout) ────
const kbJobs = new Map();
function createKbJob(asyncFn) {
  const jobId = crypto.randomBytes(6).toString('hex');
  kbJobs.set(jobId, { status: 'running', created: Date.now() });
  asyncFn()
    .then(result => kbJobs.set(jobId, { status: 'done', result }))
    .catch(err => kbJobs.set(jobId, { status: 'error', error: err.message }));
  // Cleanup old jobs
  for (const [id, j] of kbJobs) { if (Date.now() - j.created > 600000) kbJobs.delete(id); }
  return jobId;
}

router.get('/job/:jobId', (req, res) => {
  const job = kbJobs.get(req.params.jobId);
  if (!job) return res.json({ status: 'not_found' });
  res.json(job);
});

// File upload config
const uploadDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
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

// ─── Add Single URL ──────────────────────────────────
router.post('/add-url', (req, res) => {
  const db = getDb();
  const t = res.locals.t;
  const { title, url } = req.body;
  const userId = req.session.user.id;

  if (!url) {
    return res.json({ ok: false, error: t.kb_flash_url_required || 'URL required' });
  }

  const jobId = createKbJob(async () => {
    const result = await ai.extractFromUrl(url);
    if (!result.processed || result.processed.trim().length < 20) {
      throw new Error(t.kb_flash_url_empty || 'No content extracted');
    }
    const finalTitle = title || 'Import: ' + url.substring(0, 60);
    db.prepare('INSERT INTO knowledge_base (title, content, source_type, source_ref, added_by) VALUES (?,?,?,?,?)')
      .run(finalTitle, result.processed, 'url', url, userId);
    logActivity(userId, 'added', 'knowledge', 0, finalTitle);
    return { title: finalTitle, chars: result.processed.length, method: result.method };
  });

  res.json({ ok: true, jobId });
});

// ═══════════════════════════════════════════════════════
//  BULK URL IMPORT (AJAX with progress)
// ═══════════════════════════════════════════════════════
router.post('/import-urls', async (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  let { urls } = req.body;

  // Accept array or newline-separated string
  if (typeof urls === 'string') {
    urls = urls.split(/[\n\r]+/).map(u => u.trim()).filter(u => u && u.startsWith('http'));
  }
  if (!urls || urls.length === 0) {
    return res.json({ ok: false, error: 'No valid URLs provided' });
  }

  // Cap at 50 URLs per batch
  if (urls.length > 50) urls = urls.slice(0, 50);

  // Process URLs sequentially and stream results via SSE-like JSON array
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const result = { url, index: i, total: urls.length, status: 'pending', title: '', error: '' };

    try {
      const data = await ai.extractFromUrl(url);
      if (!data.processed || data.processed.trim().length < 20) {
        result.status = 'empty';
        result.error = 'No content extracted';
      } else {
        const title = 'Import: ' + url.replace(/https?:\/\//, '').substring(0, 60);
        db.prepare('INSERT INTO knowledge_base (title, content, source_type, source_ref, added_by) VALUES (?,?,?,?,?)')
          .run(title, data.processed, 'url', url, userId);
        logActivity(userId, 'added', 'knowledge', 0, title);
        result.status = 'success';
        result.title = title;
        result.chars = data.processed.length;
        result.method = data.method || 'unknown';
      }
    } catch (e) {
      result.status = 'error';
      result.error = e.message;
    }
    results.push(result);
  }

  res.json({ ok: true, results });
});

// ─── Import Single URL via AJAX (for bulk progress) ──
router.post('/import-single-url', (req, res) => {
  try {
    const db = getDb();
    const userId = req.session.user.id;
    const { url } = req.body;

    if (!url) return res.json({ ok: false, error: 'No URL' });

    const jobId = createKbJob(async () => {
      const data = await ai.extractFromUrl(url);
      if (!data.processed || data.processed.trim().length < 20) {
        throw new Error('Aucun contenu extrait de cette URL.');
      }
      const title = 'Import: ' + url.replace(/https?:\/\//, '').substring(0, 60);
      db.prepare('INSERT INTO knowledge_base (title, content, source_type, source_ref, added_by) VALUES (?,?,?,?,?)')
        .run(title, data.processed, 'url', url, userId);
      logActivity(userId, 'added', 'knowledge', 0, title);
      return { ok: true, title, chars: data.processed.length, method: data.method, url };
    });

    res.json({ ok: true, jobId });
  } catch (e) {
    console.error('[KB] Import URL error:', e.message);
    res.json({ ok: false, error: e.message });
  }
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
        content = `[Image: ${req.file.originalname}] — AI not configured.`;
      }
    } else if (ext === '.pdf') {
      content = `[PDF: ${req.file.originalname}] — PDF content: ` + (req.body.description || 'No description.');
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

// ─── Edit / Toggle / Delete ──────────────────────────
router.post('/:id/update', (req, res) => {
  const db = getDb();
  const { title, content } = req.body;
  db.prepare('UPDATE knowledge_base SET title=?, content=? WHERE id=?').run(title, content, req.params.id);
  req.session._kbFlash = { type: 'success', msg: '✅' };
  res.redirect('/admin/knowledge');
});

router.post('/:id/toggle', (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT is_active FROM knowledge_base WHERE id=?').get(req.params.id);
  if (entry) db.prepare('UPDATE knowledge_base SET is_active=? WHERE id=?').run(entry.is_active ? 0 : 1, req.params.id);
  res.redirect('/admin/knowledge');
});

// ─── Re-scrape URL KB Entry (async) ──────────────────
router.post('/:id/rescrape', (req, res) => {
  try {
    const db = getDb();
    const entry = db.prepare('SELECT * FROM knowledge_base WHERE id=?').get(req.params.id);
    if (!entry || entry.source_type !== 'url' || !entry.source_ref) {
      return res.json({ ok: false, error: 'Entrée non-URL ou introuvable.' });
    }

    const jobId = createKbJob(async () => {
      const data = await ai.extractFromUrl(entry.source_ref);
      const oldLen = (entry.content || '').length;
      db.prepare('UPDATE knowledge_base SET content=?, created_at=CURRENT_TIMESTAMP WHERE id=?').run(data.processed, entry.id);
      return { title: entry.title, chars: data.processed.length, oldChars: oldLen, method: data.method };
    });

    res.json({ ok: true, jobId });
  } catch (e) {
    console.error('[KB] Rescrape error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM knowledge_base WHERE id=?').run(req.params.id);
  res.redirect('/admin/knowledge');
});

module.exports = router;
