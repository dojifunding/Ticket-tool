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

  // ─── Help Center Tables ─────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS article_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    name_en TEXT, icon TEXT DEFAULT '📄', position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    title_en TEXT, content TEXT NOT NULL, content_en TEXT, excerpt TEXT, excerpt_en TEXT,
    category_id INTEGER REFERENCES article_categories(id),
    is_public INTEGER DEFAULT 1, is_published INTEGER DEFAULT 1,
    author_id INTEGER REFERENCES users(id), views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_public ON articles(is_public, is_published)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug)');

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

    // ─── Help Center Seed Data ──────────────────────
    const cats = [
      ['Démarrage', 'getting-started', 'Getting Started', '🚀', 1],
      ['Compte', 'account', 'Account', '👤', 2],
      ['Facturation', 'billing', 'Billing', '💳', 3],
      ['Fonctionnalités', 'features', 'Features', '✨', 4],
      ['Dépannage', 'troubleshooting', 'Troubleshooting', '🔧', 5],
      ['Intégrations', 'integrations', 'Integrations', '🔗', 6]
    ];
    cats.forEach(c => db.prepare('INSERT INTO article_categories (name,slug,name_en,icon,position) VALUES (?,?,?,?,?)').run(...c));

    const articles = [
      ['Comment créer un compte ?', 'comment-creer-un-compte', 'How to create an account?',
       '## Créer votre compte\n\nPour créer un compte sur notre plateforme, suivez ces étapes simples :\n\n1. Rendez-vous sur notre page d\'inscription\n2. Remplissez le formulaire avec vos informations\n3. Vérifiez votre email\n4. Connectez-vous avec vos identifiants\n\n**Astuce :** Utilisez une adresse email que vous consultez régulièrement.\n\n## Besoin d\'aide ?\n\nSi vous rencontrez des difficultés, contactez notre support.',
       '## Create your account\n\nTo create an account on our platform, follow these simple steps:\n\n1. Go to our registration page\n2. Fill in the form with your information\n3. Verify your email\n4. Log in with your credentials\n\n**Tip:** Use an email address you check regularly.\n\n## Need help?\n\nIf you encounter difficulties, contact our support.',
       'Guide étape par étape pour créer votre compte.', 'Step-by-step guide to create your account.',
       1, 1, 1, 1],
      ['Comment réinitialiser mon mot de passe ?', 'reinitialiser-mot-de-passe', 'How to reset my password?',
       '## Réinitialiser votre mot de passe\n\n1. Cliquez sur \"Mot de passe oublié\" sur la page de connexion\n2. Entrez votre adresse email\n3. Consultez votre boîte de réception\n4. Cliquez sur le lien de réinitialisation\n5. Choisissez un nouveau mot de passe sécurisé\n\n**Important :** Le lien expire après 24 heures.\n\n## Conseils sécurité\n\n- Utilisez au moins 8 caractères\n- Mélangez lettres, chiffres et symboles\n- Ne réutilisez pas d\'anciens mots de passe',
       '## Reset your password\n\n1. Click "Forgot password" on the login page\n2. Enter your email address\n3. Check your inbox\n4. Click the reset link\n5. Choose a new secure password\n\n**Important:** The link expires after 24 hours.\n\n## Security tips\n\n- Use at least 8 characters\n- Mix letters, numbers and symbols\n- Don\'t reuse old passwords',
       'Procédure pour réinitialiser votre mot de passe.', 'Steps to reset your password.',
       2, 1, 1, 1],
      ['Comprendre les plans et tarifs', 'plans-et-tarifs', 'Understanding plans and pricing',
       '## Nos offres\n\n### Plan Basic — Gratuit\n- 1 utilisateur\n- 10 tickets/mois\n- Support par email\n\n### Plan Pro — 29€/mois\n- 5 utilisateurs\n- Tickets illimités\n- Support prioritaire\n- Rapports avancés\n\n### Plan Enterprise — Sur devis\n- Utilisateurs illimités\n- SLA garanti\n- Manager dédié\n- API complète\n\n## Changer de plan\n\nAllez dans **Paramètres > Abonnement** pour modifier votre plan à tout moment.',
       '## Our plans\n\n### Basic Plan — Free\n- 1 user\n- 10 tickets/month\n- Email support\n\n### Pro Plan — $29/month\n- 5 users\n- Unlimited tickets\n- Priority support\n- Advanced reports\n\n### Enterprise Plan — Custom pricing\n- Unlimited users\n- Guaranteed SLA\n- Dedicated manager\n- Full API\n\n## Change plan\n\nGo to **Settings > Subscription** to change your plan anytime.',
       'Détail de nos plans Basic, Pro et Enterprise.', 'Details of our Basic, Pro and Enterprise plans.',
       3, 1, 1, 1],
      ['Guide de résolution des erreurs courantes', 'erreurs-courantes', 'Common error troubleshooting guide',
       '## Erreurs courantes\n\n### Erreur 500 — Erreur serveur\n**Cause :** Problème temporaire sur nos serveurs.\n**Solution :** Attendez quelques minutes et réessayez. Si le problème persiste, contactez le support.\n\n### Erreur 403 — Accès refusé\n**Cause :** Vous n\'avez pas les droits nécessaires.\n**Solution :** Vérifiez que votre compte a les permissions requises.\n\n### Page blanche\n**Cause :** Problème de cache navigateur.\n**Solution :** Videz le cache (Ctrl+Shift+Suppr) et rechargez la page.\n\n## Toujours bloqué ?\n\nOuvrez un ticket de support avec une capture d\'écran de l\'erreur.',
       '## Common errors\n\n### Error 500 — Server error\n**Cause:** Temporary server issue.\n**Solution:** Wait a few minutes and try again. If the problem persists, contact support.\n\n### Error 403 — Access denied\n**Cause:** You don\'t have the required permissions.\n**Solution:** Check that your account has the required permissions.\n\n### Blank page\n**Cause:** Browser cache issue.\n**Solution:** Clear cache (Ctrl+Shift+Delete) and reload.\n\n## Still stuck?\n\nOpen a support ticket with a screenshot of the error.',
       'Solutions aux erreurs 500, 403 et pages blanches.', 'Solutions for 500, 403 errors and blank pages.',
       5, 1, 1, 1],
      ['Procédure interne : Gestion des escalades', 'procedure-escalades', 'Internal: Escalation procedure',
       '## Procédure d\'escalade — Staff uniquement\n\n### Quand escalader ?\n- Bug critique affectant plusieurs utilisateurs\n- Problème nécessitant une modification du code\n- Demande de fonctionnalité urgente d\'un client Enterprise\n\n### Comment escalader ?\n1. Ouvrir le ticket concerné\n2. Cliquer sur \"Escalader aux développeurs\"\n3. Choisir le projet cible\n4. Définir la priorité\n5. Ajouter un commentaire expliquant le contexte\n\n### Suivi\n- Vous recevrez une notification quand le dev change le statut\n- Un message automatique apparaît dans le ticket\n- Informer le client que le problème est pris en charge',
       '## Escalation procedure — Staff only\n\n### When to escalate?\n- Critical bug affecting multiple users\n- Issue requiring code changes\n- Urgent feature request from Enterprise client\n\n### How to escalate?\n1. Open the relevant ticket\n2. Click "Escalate to developers"\n3. Choose target project\n4. Set priority\n5. Add a comment explaining context\n\n### Follow-up\n- You\'ll receive a notification when the dev changes status\n- An automatic message appears in the ticket\n- Inform the client that the issue is being handled',
       'Guide interne pour gérer les escalades support → dev.', 'Internal guide for managing support → dev escalations.',
       5, 0, 1, 1]
    ];
    articles.forEach(a => {
      db.prepare(`INSERT INTO articles (title,slug,title_en,content,content_en,excerpt,excerpt_en,category_id,is_public,is_published,author_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...a);
    });
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
