const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'hub.db');

let db = null;

// ─── Wrapper mimicking better-sqlite3 API ─────────
class DbWrapper {
  constructor(sqlDb) { this._db = sqlDb; }

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
          console.error('[DB] get error:', e.message, 'SQL:', sql.substring(0, 80));
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
          console.error('[DB] all error:', e.message, 'SQL:', sql.substring(0, 80));
          return [];
        }
      },
      run(...params) {
        try {
          self._db.run(sql, params);
          const changes = self._db.getRowsModified();
          // Get last insert rowid safely
          let lastId = 0;
          try {
            const res = self._db.exec('SELECT last_insert_rowid() as id');
            if (res && res[0] && res[0].values && res[0].values[0]) {
              lastId = res[0].values[0][0];
            }
          } catch (e2) { /* ignore */ }
          self._save();
          return { changes, lastInsertRowid: lastId };
        } catch (e) {
          console.error('[DB] run error:', e.message, 'SQL:', sql.substring(0, 80));
          self._save();
          return { changes: 0, lastInsertRowid: 0 };
        }
      }
    };
  }

  _save() {
    try {
      const data = this._db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('[DB] Save error:', e.message);
    }
  }
}

function getDb() { return db; }

async function initDatabase() {
  const SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    sqlDb = new SQL.Database();
  }
  db = new DbWrapper(sqlDb);

  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','developer','support')),
    avatar_color TEXT DEFAULT '#6366f1', is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, description TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT UNIQUE NOT NULL,
    subject TEXT NOT NULL, description TEXT NOT NULL,
    status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','resolved','closed')),
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    category TEXT DEFAULT 'general' CHECK(category IN ('general','bug','question','feature_request','account','billing','other')),
    client_name TEXT, client_email TEXT, assigned_to INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id), escalated_to_task INTEGER, resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ticket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL, is_internal INTEGER DEFAULT 0,
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

  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(assigned_to)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id)');

  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const c = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6'];
    const ins = (u,e,p,n,r,cl) => db.prepare('INSERT INTO users (username,email,password,full_name,role,avatar_color) VALUES (?,?,?,?,?,?)').run(u,e,bcrypt.hashSync(p,10),n,r,cl);
    ins('admin','admin@company.com','admin123','Administrateur','admin',c[0]);
    ins('dev1','dev1@company.com','dev123','Alice Martin','developer',c[1]);
    ins('dev2','dev2@company.com','dev123','Bob Dupont','developer',c[2]);
    ins('support1','support1@company.com','support123','Clara Leroy','support',c[3]);
    ins('support2','support2@company.com','support123','David Moreau','support',c[4]);

    db.prepare('INSERT INTO projects (name,code,description,status,priority,color,created_by) VALUES (?,?,?,?,?,?,?)').run('Site Web Corporate','SWC','Refonte du site web corporate','active','high','#6366f1',1);
    db.prepare('INSERT INTO projects (name,code,description,status,priority,color,created_by) VALUES (?,?,?,?,?,?,?)').run('App Mobile Client','AMC','Application mobile pour les clients','active','critical','#ec4899',1);

    [[1,'Maquette page accueil','Créer la maquette Figma','done','high','task',2],
     [1,'Intégration header/footer','Développer le header responsive','in_progress','high','task',2],
     [1,'Formulaire de contact','Développer le formulaire avec validation','todo','medium','feature',3],
     [1,'Bug affichage menu mobile','Le menu burger ne se ferme pas','todo','high','bug',null],
     [2,'Architecture React Native','Définir architecture de app','in_progress','critical','task',3],
     [2,'Écran de login','Développer écran de connexion','todo','high','feature',2]
    ].forEach(t => db.prepare('INSERT INTO tasks (project_id,title,description,status,priority,type,assigned_to,created_by) VALUES (?,?,?,?,?,?,?,1)').run(...t));

    [['TK-001','Impossible de se connecter','Utilisateur ne peut plus se connecter.','open','high','bug','Jean Petit','jean@example.com',4],
     ['TK-002','Question sur abonnement','Client souhaite passer de Basic à Pro.','in_progress','medium','question','Marie Blanc','marie@example.com',5],
     ['TK-003','Erreur 500 page produits','Erreur 500 signalée par plusieurs utilisateurs.','open','urgent','bug','Pierre Durand','pierre@example.com',null]
    ].forEach(t => db.prepare('INSERT INTO tickets (reference,subject,description,status,priority,category,client_name,client_email,assigned_to,created_by) VALUES (?,?,?,?,?,?,?,?,?,4)').run(...t));

    console.log('✅ Base de données initialisée avec les données de démo');
  } else {
    console.log('✅ Base de données chargée');
  }
}

function generateTicketRef() {
  const last = db.prepare('SELECT reference FROM tickets ORDER BY id DESC LIMIT 1').get();
  if (!last) return 'TK-001';
  return 'TK-' + String(parseInt(last.reference.split('-')[1]) + 1).padStart(3, '0');
}

function createNotification(userId, type, title, message, link) {
  try {
    return db.prepare('INSERT INTO notifications (user_id,type,title,message,link) VALUES (?,?,?,?,?)').run(userId, type, title, message, link || null);
  } catch (e) {
    console.error('[DB] createNotification error:', e.message);
    return { changes: 0, lastInsertRowid: 0 };
  }
}

function logActivity(userId, action, entityType, entityId, details) {
  try {
    db.prepare('INSERT INTO activity_log (user_id,action,entity_type,entity_id,details) VALUES (?,?,?,?,?)').run(userId, action, entityType, entityId, details || null);
  } catch (e) {
    console.error('[DB] logActivity error:', e.message);
  }
}

module.exports = { getDb, initDatabase, generateTicketRef, createNotification, logActivity };
