// ═══════════════════════════════════════════════════════
//  ProjectHub SaaS — Multi-Tenant Database Layer
//  Master DB (accounts, tenants, plans) + Tenant DBs
//  Uses AsyncLocalStorage for transparent tenant isolation
// ═══════════════════════════════════════════════════════

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MASTER_DB_PATH = path.join(DATA_DIR, 'master.db');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

let SQL = null;
let masterDb = null;
const tenantDbCache = new Map();

// AsyncLocalStorage → allows getDb() to return the correct tenant DB per request
const requestStore = new AsyncLocalStorage();

// ─── DB Wrapper (mimics better-sqlite3 API) ──────────
class DbWrapper {
  constructor(sqlDb, dbPath) {
    this._db = sqlDb;
    this._path = dbPath;
  }

  exec(sql) {
    this._db.run(sql);
    this._save();
  }

  prepare(sql) {
    const self = this;
    return {
      get(...params) {
        try {
          const stmt = self._db.prepare(sql);
          if (params.length) stmt.bind(params);
          let result = undefined;
          if (stmt.step()) result = stmt.getAsObject();
          stmt.free();
          return result;
        } catch (e) {
          console.error('[DB] get error:', e.message, 'SQL:', sql.substring(0, 100));
          return undefined;
        }
      },
      all(...params) {
        try {
          const results = [];
          const stmt = self._db.prepare(sql);
          if (params.length) stmt.bind(params);
          while (stmt.step()) results.push(stmt.getAsObject());
          stmt.free();
          return results;
        } catch (e) {
          console.error('[DB] all error:', e.message, 'SQL:', sql.substring(0, 100));
          return [];
        }
      },
      run(...params) {
        try {
          self._db.run(sql, params);
          const changes = self._db.getRowsModified();
          let lastId = 0;
          try {
            const res = self._db.exec('SELECT last_insert_rowid() as id');
            if (res?.[0]?.values?.[0]) lastId = res[0].values[0][0];
          } catch (_) {}
          self._save();
          return { changes, lastInsertRowid: lastId };
        } catch (e) {
          console.error('[DB] run error:', e.message, 'SQL:', sql.substring(0, 100));
          self._save();
          return { changes: 0, lastInsertRowid: 0 };
        }
      }
    };
  }

  _save() {
    try {
      const data = this._db.export();
      fs.writeFileSync(this._path, Buffer.from(data));
    } catch (e) {
      console.error('[DB] Save error:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════
//  MASTER DATABASE
// ═══════════════════════════════════════════════════════

async function initMasterDatabase() {
  SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true });

  let sqlDb;
  if (fs.existsSync(MASTER_DB_PATH)) {
    sqlDb = new SQL.Database(fs.readFileSync(MASTER_DB_PATH));
  } else {
    sqlDb = new SQL.Database();
  }
  masterDb = new DbWrapper(sqlDb, MASTER_DB_PATH);

  masterDb.exec(`CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_en TEXT,
    price_monthly REAL DEFAULT 0, price_yearly REAL DEFAULT 0,
    max_users INTEGER DEFAULT 3, max_tickets_month INTEGER DEFAULT 100,
    ai_enabled INTEGER DEFAULT 1, ai_calls_month INTEGER DEFAULT 50,
    kb_enabled INTEGER DEFAULT 1, livechat_enabled INTEGER DEFAULT 1,
    projects_enabled INTEGER DEFAULT 1, max_kb_entries INTEGER DEFAULT 20,
    max_articles INTEGER DEFAULT 50, features TEXT,
    is_active INTEGER DEFAULT 1, position INTEGER DEFAULT 0
  )`);

  masterDb.exec(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    plan_id TEXT DEFAULT 'trial' REFERENCES plans(id),
    trial_ends_at DATETIME, is_active INTEGER DEFAULT 1,
    onboarding_completed INTEGER DEFAULT 0,
    company_type TEXT, company_website TEXT,
    ai_enabled INTEGER DEFAULT 1, ai_tickets INTEGER DEFAULT 1,
    ai_livechat INTEGER DEFAULT 1, ai_faq INTEGER DEFAULT 1,
    ai_profile TEXT DEFAULT 'generic',
    custom_ai_context TEXT DEFAULT '',
    locale TEXT DEFAULT 'fr',
    brand_color TEXT DEFAULT '#6366f1',
    brand_color_dark TEXT DEFAULT '#818cf8',
    logo_url TEXT DEFAULT '',
    custom_domain TEXT DEFAULT '',
    ai_calls_limit INTEGER DEFAULT -1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrate existing tenants — add branding columns if missing
  try {
    const cols = masterDb.pragma('table_info(tenants)').map(c => c.name);
    if (!cols.includes('brand_color')) masterDb.exec("ALTER TABLE tenants ADD COLUMN brand_color TEXT DEFAULT '#6366f1'");
    if (!cols.includes('brand_color_dark')) masterDb.exec("ALTER TABLE tenants ADD COLUMN brand_color_dark TEXT DEFAULT '#818cf8'");
    if (!cols.includes('logo_url')) masterDb.exec("ALTER TABLE tenants ADD COLUMN logo_url TEXT DEFAULT ''");
    if (!cols.includes('custom_domain')) masterDb.exec("ALTER TABLE tenants ADD COLUMN custom_domain TEXT DEFAULT ''");
    if (!cols.includes('ai_calls_limit')) masterDb.exec("ALTER TABLE tenants ADD COLUMN ai_calls_limit INTEGER DEFAULT -1");
  } catch (e) { /* columns already exist */ }
  masterDb.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    full_name TEXT NOT NULL, tenant_id TEXT REFERENCES tenants(id),
    is_owner INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
    last_login DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  masterDb.exec(`CREATE TABLE IF NOT EXISTS license_keys (
    key TEXT PRIMARY KEY, plan_id TEXT REFERENCES plans(id),
    tenant_id TEXT REFERENCES tenants(id),
    valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
    valid_until DATETIME, is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  masterDb.exec('CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts(tenant_id)');
  masterDb.exec('CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email)');
  masterDb.exec('CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)');
  masterDb.exec('CREATE INDEX IF NOT EXISTS idx_license_tenant ON license_keys(tenant_id)');

  // Seed plans
  const existingPlan = masterDb.prepare('SELECT id FROM plans LIMIT 1').get();
  if (!existingPlan) {
    const plans = [
      ['trial','Essai gratuit','Free Trial',0,0,3,50,1,30,1,1,1,10,20,'{"trial":true,"duration_days":7}',1,0],
      ['starter','Starter','Starter',29,290,5,200,1,100,1,1,0,30,100,'{"support_priority":"email"}',1,1],
      ['pro','Professionnel','Professional',79,790,15,-1,1,500,1,1,1,100,-1,'{"support_priority":"priority","api_access":true}',1,2],
      ['enterprise','Entreprise','Enterprise',199,1990,-1,-1,1,-1,1,1,1,-1,-1,'{"support_priority":"dedicated","sla":true}',1,3]
    ];
    plans.forEach(p => {
      masterDb.prepare('INSERT INTO plans (id,name,name_en,price_monthly,price_yearly,max_users,max_tickets_month,ai_enabled,ai_calls_month,kb_enabled,livechat_enabled,projects_enabled,max_kb_entries,max_articles,features,is_active,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...p);
    });
    console.log('✅ Plans SaaS initialisés');
  }

  console.log('✅ Master database initialisée');
}

function getMasterDb() { return masterDb; }

// ═══════════════════════════════════════════════════════
//  TENANT DATABASE
// ═══════════════════════════════════════════════════════

function getTenantDir(tenantId) { return path.join(TENANTS_DIR, tenantId); }
function getTenantDbPath(tenantId) { return path.join(getTenantDir(tenantId), 'hub.db'); }
function getTenantUploadsDir(tenantId) { return path.join(getTenantDir(tenantId), 'uploads'); }

function getTenantDb(tenantId) {
  if (!tenantId) throw new Error('No tenant ID');
  if (tenantDbCache.has(tenantId)) return tenantDbCache.get(tenantId);

  const tenantDir = getTenantDir(tenantId);
  const dbPath = getTenantDbPath(tenantId);
  if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });

  let sqlDb;
  if (fs.existsSync(dbPath)) {
    sqlDb = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    sqlDb = new SQL.Database();
  }

  const wrapper = new DbWrapper(sqlDb, dbPath);
  initTenantSchema(wrapper);
  tenantDbCache.set(tenantId, wrapper);
  return wrapper;
}

function initTenantSchema(db) {
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','developer','support')),
    avatar_color TEXT DEFAULT '#6366f1', is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
    description TEXT, status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
    color TEXT DEFAULT '#6366f1', created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, description TEXT,
    status TEXT DEFAULT 'todo' CHECK(status IN ('backlog','todo','in_progress','review','done')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
    type TEXT DEFAULT 'task' CHECK(type IN ('task','bug','feature','improvement','escalation')),
    assigned_to INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id),
    escalated_from_ticket INTEGER, due_date DATE, estimated_hours REAL, position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT UNIQUE NOT NULL,
    subject TEXT NOT NULL, description TEXT NOT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','resolved','closed')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    category TEXT DEFAULT 'general' CHECK(category IN ('general','bug','question','feature_request','account','billing','other')),
    client_name TEXT, client_email TEXT, assigned_to INTEGER REFERENCES users(id),
    company_id INTEGER REFERENCES companies(id),
    created_by INTEGER REFERENCES users(id), escalated_to_task INTEGER, resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Companies = Workspaces — each has its own help center, FAQ, branding, AI settings
  db.exec(`CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    logo_url TEXT DEFAULT '', website TEXT DEFAULT '',
    description TEXT DEFAULT '', contact_email TEXT DEFAULT '',
    brand_color TEXT DEFAULT '#6366f1',
    brand_color_dark TEXT DEFAULT '#818cf8',
    chatbot_name TEXT DEFAULT 'Assistant',
    chatbot_context TEXT DEFAULT '',
    ai_profile TEXT DEFAULT 'generic',
    translation_languages TEXT DEFAULT 'en',
    auto_translate_articles INTEGER DEFAULT 0,
    ai_livechat_faq_first INTEGER DEFAULT 1,
    industry_context TEXT DEFAULT '',
    help_center_enabled INTEGER DEFAULT 1,
    livechat_enabled INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrate existing companies table
  try {
    const compCols = db.pragma('table_info(companies)').map(c => c.name);
    if (!compCols.includes('brand_color')) db.exec("ALTER TABLE companies ADD COLUMN brand_color TEXT DEFAULT '#6366f1'");
    if (!compCols.includes('brand_color_dark')) db.exec("ALTER TABLE companies ADD COLUMN brand_color_dark TEXT DEFAULT '#818cf8'");
    if (!compCols.includes('chatbot_name')) db.exec("ALTER TABLE companies ADD COLUMN chatbot_name TEXT DEFAULT 'Assistant'");
    if (!compCols.includes('chatbot_context')) db.exec("ALTER TABLE companies ADD COLUMN chatbot_context TEXT DEFAULT ''");
    if (!compCols.includes('ai_profile')) db.exec("ALTER TABLE companies ADD COLUMN ai_profile TEXT DEFAULT 'generic'");
    if (!compCols.includes('translation_languages')) db.exec("ALTER TABLE companies ADD COLUMN translation_languages TEXT DEFAULT 'en'");
    if (!compCols.includes('auto_translate_articles')) db.exec("ALTER TABLE companies ADD COLUMN auto_translate_articles INTEGER DEFAULT 0");
    if (!compCols.includes('ai_livechat_faq_first')) db.exec("ALTER TABLE companies ADD COLUMN ai_livechat_faq_first INTEGER DEFAULT 1");
    if (!compCols.includes('industry_context')) db.exec("ALTER TABLE companies ADD COLUMN industry_context TEXT DEFAULT ''");
    if (!compCols.includes('help_center_enabled')) db.exec("ALTER TABLE companies ADD COLUMN help_center_enabled INTEGER DEFAULT 1");
    if (!compCols.includes('livechat_enabled')) db.exec("ALTER TABLE companies ADD COLUMN livechat_enabled INTEGER DEFAULT 1");
  } catch (e) { /* columns exist */ }

  // Users assigned to companies
  db.exec(`CREATE TABLE IF NOT EXISTS user_companies (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, company_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ticket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL, is_internal INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, link TEXT,
    is_read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS article_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
    name_en TEXT, name_es TEXT, name_de TEXT, icon TEXT DEFAULT '📄', position INTEGER DEFAULT 0,
    company_id INTEGER REFERENCES companies(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL,
    title_en TEXT, content TEXT NOT NULL, content_en TEXT, excerpt TEXT, excerpt_en TEXT,
    title_es TEXT, content_es TEXT, excerpt_es TEXT, title_de TEXT, content_de TEXT, excerpt_de TEXT,
    title_fr TEXT, content_fr TEXT, excerpt_fr TEXT,
    category_id INTEGER REFERENCES article_categories(id),
    company_id INTEGER REFERENCES companies(id),
    is_public INTEGER DEFAULT 1, is_published INTEGER DEFAULT 1,
    author_id INTEGER REFERENCES users(id), views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('text','url','file','image')),
    source_ref TEXT, added_by INTEGER REFERENCES users(id),
    company_id INTEGER REFERENCES companies(id),
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_token TEXT UNIQUE NOT NULL,
    visitor_name TEXT, visitor_email TEXT,
    status TEXT DEFAULT 'ai' CHECK(status IN ('ai','human','closed')),
    ticket_id INTEGER REFERENCES tickets(id),
    company_id INTEGER REFERENCES companies(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('visitor','ai','agent')),
    sender_name TEXT, content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ai_article_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, excerpt TEXT,
    category_suggestion TEXT, source_type TEXT NOT NULL DEFAULT 'pattern', source_details TEXT,
    status TEXT NOT NULL DEFAULT 'pending', reviewed_by INTEGER REFERENCES users(id),
    reviewed_at DATETIME, published_article_id INTEGER REFERENCES articles(id),
    company_id INTEGER REFERENCES companies(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ai_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, tokens_estimate INTEGER DEFAULT 0,
    cost_estimate REAL DEFAULT 0, user_id INTEGER, details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrations for existing tenant databases
  try {
    const ticketCols = db.pragma('table_info(tickets)').map(c => c.name);
    if (!ticketCols.includes('company_id')) db.exec('ALTER TABLE tickets ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  } catch (e) { /* exists */ }
  try {
    const artCols = db.pragma('table_info(articles)').map(c => c.name);
    if (!artCols.includes('company_id')) db.exec('ALTER TABLE articles ADD COLUMN company_id INTEGER REFERENCES companies(id)');
    if (!artCols.includes('title_fr')) db.exec('ALTER TABLE articles ADD COLUMN title_fr TEXT');
    if (!artCols.includes('content_fr')) db.exec('ALTER TABLE articles ADD COLUMN content_fr TEXT');
    if (!artCols.includes('excerpt_fr')) db.exec('ALTER TABLE articles ADD COLUMN excerpt_fr TEXT');
  } catch (e) { /* exists */ }
  try {
    const catCols = db.pragma('table_info(article_categories)').map(c => c.name);
    if (!catCols.includes('company_id')) db.exec('ALTER TABLE article_categories ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  } catch (e) { /* exists */ }
  try {
    const kbCols = db.pragma('table_info(knowledge_base)').map(c => c.name);
    if (!kbCols.includes('company_id')) db.exec('ALTER TABLE knowledge_base ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  } catch (e) { /* exists */ }
  try {
    const chatCols = db.pragma('table_info(chat_sessions)').map(c => c.name);
    if (!chatCols.includes('company_id')) db.exec('ALTER TABLE chat_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  } catch (e) { /* exists */ }
  try {
    const sugCols = db.pragma('table_info(ai_article_suggestions)').map(c => c.name);
    if (!sugCols.includes('company_id')) db.exec('ALTER TABLE ai_article_suggestions ADD COLUMN company_id INTEGER REFERENCES companies(id)');
  } catch (e) { /* exists */ }

  // Drop unique constraint on article slugs (now per-company)
  // SQLite doesn't support DROP INDEX IF EXISTS easily, so just create new indexes

  // Indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)',
    'CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read)',
    'CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id)',
    'CREATE INDEX IF NOT EXISTS idx_articles_public ON articles(is_public, is_published)',
    'CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug)',
    'CREATE INDEX IF NOT EXISTS idx_articles_company ON articles(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_categories_company ON article_categories(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_kb_company ON knowledge_base(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_sessions_company ON chat_sessions(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_sessions_token ON chat_sessions(visitor_token)',
    'CREATE INDEX IF NOT EXISTS idx_chat_sessions_ticket ON chat_sessions(ticket_id)',
    'CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_ai_suggestions_status ON ai_article_suggestions(status)',
  ];
  indexes.forEach(sql => db.exec(sql));

  // Default settings
  const defaults = [
    ['translation_languages','en'], ['auto_translate_articles','0'],
    ['ai_livechat_faq_first','1'], ['company_name',''], ['chatbot_context',''],
    ['escalation_enabled','0'], ['escalation_categories','bug,feature_request'],
  ];
  for (const [k, v] of defaults) {
    db.exec(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('${k}', '${v}')`);
  }
}

// ═══════════════════════════════════════════════════════
//  TENANT MANAGEMENT
// ═══════════════════════════════════════════════════════

function createTenant(name, slug, ownerEmail, ownerPassword, ownerName) {
  const tenantId = crypto.randomUUID();
  const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  masterDb.prepare('INSERT INTO tenants (id,name,slug,plan_id,trial_ends_at) VALUES (?,?,?,?,?)')
    .run(tenantId, name, slug, 'trial', trialEnd);

  masterDb.prepare('INSERT INTO accounts (email,password,full_name,tenant_id,is_owner) VALUES (?,?,?,?,?)')
    .run(ownerEmail, bcrypt.hashSync(ownerPassword, 10), ownerName, tenantId, 1);

  // Init tenant DB with admin user + default categories
  const db = getTenantDb(tenantId);
  const colors = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const username = ownerEmail.split('@')[0].replace(/[^a-z0-9_]/gi, '').substring(0, 20) || 'admin';

  db.prepare('INSERT INTO users (username,email,password,full_name,role,avatar_color) VALUES (?,?,?,?,?,?)')
    .run(username, ownerEmail, bcrypt.hashSync(ownerPassword, 10), ownerName, 'admin', color);

  // Create uploads dir
  const uploadsDir = getTenantUploadsDir(tenantId);
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  return { tenantId, trialEnd };
}

// Create default FAQ categories for a company
function createDefaultCategories(db, companyId) {
  const cats = [
    ['Démarrage','getting-started','Getting Started','🚀',1],
    ['Compte','account','Account','👤',2],
    ['Facturation','billing','Billing','💳',3],
    ['Fonctionnalités','features','Features','✨',4],
    ['Dépannage','troubleshooting','Troubleshooting','🔧',5],
    ['Intégrations','integrations','Integrations','🔗',6]
  ];
  cats.forEach(c => {
    try {
      db.prepare('INSERT INTO article_categories (name,slug,name_en,icon,position,company_id) VALUES (?,?,?,?,?,?)')
        .run(c[0], c[1] + '-' + companyId, c[2], c[3], c[4], companyId);
    } catch (e) { /* skip duplicates */ }
  });
}

function getTenant(tenantId) {
  return masterDb.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
}

function getTenantBySlug(slug) {
  return masterDb.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

function isTenantActive(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant || !tenant.is_active) return false;
  if (tenant.plan_id === 'trial' && tenant.trial_ends_at) {
    return new Date(tenant.trial_ends_at) > new Date();
  }
  return true;
}

function getTrialDaysLeft(tenant) {
  if (!tenant || tenant.plan_id !== 'trial' || !tenant.trial_ends_at) return -1;
  return Math.max(0, Math.ceil((new Date(tenant.trial_ends_at) - new Date()) / 86400000));
}

function getTenantPlan(tenantId) {
  const tenant = getTenant(tenantId);
  if (!tenant) return null;
  return masterDb.prepare('SELECT * FROM plans WHERE id = ?').get(tenant.plan_id);
}

function getTenantUsage(tenantId) {
  const db = getTenantDb(tenantId);
  return {
    users: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active=1').get()?.c || 0,
    tickets: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE created_at >= date('now','-30 days')").get()?.c || 0,
    kbEntries: db.prepare('SELECT COUNT(*) as c FROM knowledge_base WHERE is_active=1').get()?.c || 0,
    articles: db.prepare('SELECT COUNT(*) as c FROM articles WHERE is_published=1').get()?.c || 0,
    aiCalls: db.prepare("SELECT COUNT(*) as c FROM ai_usage_log WHERE created_at >= date('now','-30 days')").get()?.c || 0,
  };
}

// ═══════════════════════════════════════════════════════
//  BACKWARD COMPAT — getDb() via AsyncLocalStorage
// ═══════════════════════════════════════════════════════

function getDb() {
  const store = requestStore.getStore();
  if (store?.db) return store.db;
  throw new Error('No tenant DB in context — ensure tenant middleware is active');
}

function runWithTenantDb(tenantId, fn) {
  const db = getTenantDb(tenantId);
  return requestStore.run({ db, tenantId }, fn);
}

// Legacy helpers — they call getDb() internally, so they work with AsyncLocalStorage
function generateTicketRef() {
  const db = getDb();
  const last = db.prepare('SELECT reference FROM tickets ORDER BY id DESC LIMIT 1').get();
  if (!last) return 'TK-001';
  return 'TK-' + String(parseInt(last.reference.split('-')[1]) + 1).padStart(3, '0');
}

function createNotification(userId, type, title, message, link) {
  try {
    const db = getDb();
    return db.prepare('INSERT INTO notifications (user_id,type,title,message,link) VALUES (?,?,?,?,?)').run(userId, type, title, message, link || null);
  } catch (e) {
    console.error('[DB] createNotification error:', e.message);
    return { changes: 0, lastInsertRowid: 0 };
  }
}

function logActivity(userId, action, entityType, entityId, details) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO activity_log (user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)').run(userId, action, entityType, entityId, details || null);
  } catch (e) {
    console.error('[DB] logActivity error:', e.message);
  }
}

function getSetting(key, defaultValue = '') {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, String(value));
}

function logAiUsage(action, tokensEstimate, userId, details) {
  const db = getDb();
  const costEstimate = (tokensEstimate / 1000) * 0.005;
  db.prepare('INSERT INTO ai_usage_log (action, tokens_estimate, cost_estimate, user_id, details) VALUES (?,?,?,?,?)').run(
    action, tokensEstimate, costEstimate, userId || null, details || null
  );
}

// ═══════════════════════════════════════════════════════
//  KB CONTENT SPLITTER — Shared utility for splitting
//  knowledge base content into searchable sections
//  Handles: ## headings, \nN. Title, wall-of-text, plain text
// ═══════════════════════════════════════════════════════
function splitKbIntoSections(content) {
  if (!content || content.length <= 2000) return [content];

  // ─── Strategy 1: Split on ## headings (new scraper format) ───
  const headingCount = (content.match(/^#{1,3}\s+.+$/gm) || []).length;
  if (headingCount >= 3) {
    const sections = content.split(/\n(?=#{1,3}\s)/).filter(s => s.trim().length > 20);
    if (sections.length >= 3) return sections;
  }

  // ─── Strategy 2: Split on \nN. Title patterns ───
  // Allow digits after section number: "19. 30% Consistency", "18. 10K DRAWDOWN"
  const nlSections = content.split(/\n(?=\s*\d{1,2}\.\s+[A-Za-zÀ-ÿ0-9★◆■])/).filter(s => s.trim().length > 20);
  if (nlSections.length >= 3) return nlSections;

  // ─── Strategy 3: Wall-of-text — detect inline section boundaries ───
  // Find "N. Title" inline (after sentence end: period/parenthesis)
  const newlineCount = (content.match(/\n/g) || []).length;
  const isWallOfText = newlineCount < content.length / 500;

  if (isWallOfText) {
    // Find all numbered candidates
    const candidates = [];
    const regex = /(\d{1,2})\.\s+([A-ZÀ-Ÿ0-9][a-zà-ÿA-ZÀ-Ÿ0-9%\s,&()\/\-:]{2,}?)(?=\s+[A-ZÀ-Ÿa-zà-ÿ])/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 30) {
        candidates.push({ num, pos: match.index });
      }
    }

    // Find ascending main sequence (1→N, skip sub-items)
    if (candidates.length >= 3) {
      const mainPositions = [];
      let expectedNext = 1;
      for (const c of candidates) {
        if (c.num === expectedNext) {
          mainPositions.push(c.pos);
          expectedNext = c.num + 1;
        } else if (c.num > expectedNext && c.num <= expectedNext + 5) {
          mainPositions.push(c.pos);
          expectedNext = c.num + 1;
        }
      }

      if (mainPositions.length >= 3) {
        const sections = [];
        for (let i = 0; i < mainPositions.length; i++) {
          const start = mainPositions[i];
          const end = i + 1 < mainPositions.length ? mainPositions[i + 1] : content.length;
          const section = content.substring(start, end).trim();
          if (section.length > 20) sections.push(section);
        }
        // Add the intro (before first section)
        if (mainPositions[0] > 50) {
          sections.unshift(content.substring(0, mainPositions[0]).trim());
        }
        return sections;
      }
    }
  }

  // ─── Strategy 4: Paragraph-based split ───
  const paraSections = content.split(/\n\n(?=[A-Z0-9#★◆■])/).filter(s => s.trim().length > 20);
  if (paraSections.length >= 3) return paraSections;

  // ─── Fallback: chunk by 2500 chars at sentence boundaries ───
  const chunks = [];
  let remaining = content;
  while (remaining.length > 3000) {
    let splitPos = remaining.lastIndexOf('. ', 2500);
    if (splitPos < 500) splitPos = 2500;
    chunks.push(remaining.substring(0, splitPos + 1).trim());
    remaining = remaining.substring(splitPos + 1).trim();
  }
  if (remaining.length > 20) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [content];
}

// ═══════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════

module.exports = {
  // Init
  initMasterDatabase,
  // Master
  getMasterDb,
  // Tenant
  getTenantDb, getTenantDir, getTenantUploadsDir,
  // Tenant management
  createTenant, getTenant, getTenantBySlug, createDefaultCategories,
  isTenantActive, getTrialDaysLeft, getTenantPlan, getTenantUsage,
  // AsyncLocalStorage
  requestStore, runWithTenantDb,
  // Legacy compat (transparent multi-tenant via ALS)
  getDb, generateTicketRef, createNotification, logActivity,
  getSetting, setSetting, logAiUsage,
  // Utilities
  splitKbIntoSections,
};
