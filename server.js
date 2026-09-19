// Caja de Obra — backend
//
// A tiny generic document store on top of PostgreSQL, exposed as a REST API.
// One table ("records") holds every "collection" (projects, categories,
// movements, providers, paymentOrders, dayCloses) as JSONB rows, which keeps
// this server simple while matching the shape the frontend already expects
// (it used to talk to Claude's built-in "db" capability, which works the
// same way: collection + document id + JSON body).
//
// On top of that there's a small login system: a table of users (username +
// hashed password + role) and a table of sessions (a random token stored in
// an HttpOnly cookie). Every /api/:collection route requires a valid
// session — this is what lets you create a separate account for a
// secretary/assistant without sharing your own password.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error(
    '\n[Caja de Obra] Falta la variable de entorno DATABASE_URL.\n' +
    'En Railway: agrega un servicio "PostgreSQL" a este proyecto — Railway conecta\n' +
    'DATABASE_URL automaticamente. En local: crea un archivo .env con DATABASE_URL=... \n' +
    '(ver .env.example) y ejecuta con `node -r dotenv/config server.js`, o exporta la\n' +
    'variable tu mismo antes de correr `npm start`.\n'
  );
}

const useSSL = process.env.PGSSL === 'true' || /sslmode=require/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// Only these six collections exist in this app — reject anything else so a
// typo or a stray request can't create a stray, unbounded table-like blob.
// Users/sessions are NOT here on purpose: they live in their own tables and
// are only ever reachable through the dedicated /api/auth/* routes below,
// never through the generic collection API (which would leak password hashes).
const ALLOWED_COLLECTIONS = new Set([
  'projects', 'categories', 'movements', 'providers', 'paymentOrders', 'dayCloses',
]);

const SESSION_DAYS = 30;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      seq SERIAL PRIMARY KEY,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      project_id TEXT,
      data JSONB NOT NULL,
      UNIQUE (collection, id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_collection ON records (collection);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_project ON records (project_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'secretaria',
      created_at BIGINT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      created_at BIGINT,
      expires_at BIGINT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON app_sessions (user_id);`);
}

// ================= password / session helpers =================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await pool.query(
    'INSERT INTO app_sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [token, userId, now, expiresAt]
  );
  return token;
}
function setSessionCookie(req, res, token) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const parts = [`session=${token}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Lax'];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}
async function getUserFromReq(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.expires_at, u.id, u.username, u.name, u.role
       FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (Number(row.expires_at) < Date.now()) {
    pool.query('DELETE FROM app_sessions WHERE token = $1', [token]).catch(() => {});
    return null;
  }
  return { id: row.id, username: row.username, name: row.name || '', role: row.role };
}
async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromReq(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    req.user = user;
    next();
  } catch (err) {
    console.error('requireAuth failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  }
  next();
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

function checkCollection(req, res, next) {
  if (!ALLOWED_COLLECTIONS.has(req.params.collection)) {
    return res.status(404).json({ error: 'Colección desconocida' });
  }
  next();
}

// ================= AUTH ROUTES =================

// Whether any account exists yet — the frontend uses this to decide between
// showing "crear cuenta" (first run) and "iniciar sesión".
app.get('/api/auth/status', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM app_users');
    res.json({ hasUsers: r.rows[0].c > 0 });
  } catch (err) {
    console.error('GET /api/auth/status failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// Bootstraps the very first (admin) account. Only works while no account
// exists yet — after that, new accounts are created from Ajustes → Usuarios.
app.post('/api/auth/register', async (req, res) => {
  try {
    const countR = await pool.query('SELECT COUNT(*)::int AS c FROM app_users');
    if (countR.rows[0].c > 0) {
      return res.status(403).json({ error: 'Ya existe una cuenta. Pide al administrador que te cree un usuario.' });
    }
    const { username, password, name } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || !password || String(password).length < 4) {
      return res.status(400).json({ error: 'Usuario y contraseña (mínimo 4 caracteres) son obligatorios' });
    }
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO app_users (id, username, password_hash, name, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, uname, hashPassword(String(password)), (name || '').trim(), 'admin', Date.now()]
    );
    const token = await createSession(id);
    setSessionCookie(req, res, token);
    res.status(201).json({ id, username: uname, name: (name || '').trim(), role: 'admin' });
  } catch (err) {
    console.error('POST /api/auth/register failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || !password) return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
    const r = await pool.query('SELECT * FROM app_users WHERE username = $1', [uname]);
    if (r.rows.length === 0 || !verifyPassword(String(password), r.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const u = r.rows[0];
    const token = await createSession(u.id);
    setSessionCookie(req, res, token);
    res.json({ id: u.id, username: u.username, name: u.name || '', role: u.role });
  } catch (err) {
    console.error('POST /api/auth/login failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    if (cookies.session) await pool.query('DELETE FROM app_sessions WHERE token = $1', [cookies.session]);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    console.error('POST /api/auth/logout failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const user = await getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  res.json(user);
});

// ---- user management (admin only) — this is the "gestor multicuenta" ----
app.get('/api/auth/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, name, role, created_at FROM app_users ORDER BY created_at ASC');
    res.json(r.rows.map((u) => ({ id: u.id, username: u.username, name: u.name || '', role: u.role, createdAt: Number(u.created_at) })));
  } catch (err) {
    console.error('GET /api/auth/users failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

app.post('/api/auth/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, name, role } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!uname || !password || String(password).length < 4) {
      return res.status(400).json({ error: 'Usuario y contraseña (mínimo 4 caracteres) son obligatorios' });
    }
    const exists = await pool.query('SELECT 1 FROM app_users WHERE username = $1', [uname]);
    if (exists.rows.length) return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
    const id = crypto.randomUUID();
    const finalRole = role === 'admin' ? 'admin' : 'secretaria';
    await pool.query(
      'INSERT INTO app_users (id, username, password_hash, name, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, uname, hashPassword(String(password)), (name || '').trim(), finalRole, Date.now()]
    );
    res.status(201).json({ id, username: uname, name: (name || '').trim(), role: finalRole });
  } catch (err) {
    console.error('POST /api/auth/users failed:', err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

app.patch('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, password } = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    if (typeof name === 'string') { sets.push(`name = $${i++}`); vals.push(name.trim()); }
    if (role === 'admin' || role === 'secretaria') { sets.push(`role = $${i++}`); vals.push(role); }
    if (password) {
      if (String(password).length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
      sets.push(`password_hash = $${i++}`); vals.push(hashPassword(String(password)));
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    vals.push(id);
    const result = await pool.query(`UPDATE app_users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.status(204).end();
  } catch (err) {
    console.error('PATCH /api/auth/users/%s failed:', req.params.id, err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

app.delete('/api/auth/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    const target = await pool.query('SELECT role FROM app_users WHERE id = $1', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.rows[0].role === 'admin') {
      const countR = await pool.query(`SELECT COUNT(*)::int AS c FROM app_users WHERE role = 'admin'`);
      if (countR.rows[0].c <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador' });
    }
    await pool.query('DELETE FROM app_users WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/auth/users/%s failed:', req.params.id, err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// ================= DATA ROUTES (all require a logged-in session) =================

// GET /api/:collection            -> all docs in that collection
// GET /api/:collection?projectId=X -> only docs belonging to that project
app.get('/api/:collection', requireAuth, checkCollection, async (req, res) => {
  try {
    const { collection } = req.params;
    const { projectId } = req.query;
    const result = projectId
      ? await pool.query(
          'SELECT id, data FROM records WHERE collection = $1 AND project_id = $2 ORDER BY seq ASC',
          [collection, projectId]
        )
      : await pool.query('SELECT id, data FROM records WHERE collection = $1 ORDER BY seq ASC', [collection]);
    const rows = result.rows.map((r) => Object.assign({}, r.data, { id: r.id }));
    res.json(rows);
  } catch (err) {
    console.error('GET /api/%s failed:', req.params.collection, err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// POST /api/:collection  body = the document's fields (no id — the server mints one)
app.post('/api/:collection', requireAuth, checkCollection, async (req, res) => {
  try {
    const { collection } = req.params;
    const data = req.body && typeof req.body === 'object' ? req.body : {};
    const id = crypto.randomUUID();
    const projectId = typeof data.projectId === 'string' ? data.projectId : null;
    await pool.query(
      'INSERT INTO records (collection, id, project_id, data) VALUES ($1, $2, $3, $4)',
      [collection, id, projectId, data]
    );
    res.status(201).json(Object.assign({}, data, { id }));
  } catch (err) {
    console.error('POST /api/%s failed:', req.params.collection, err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// PATCH /api/:collection/:id  body = fields to merge into the existing document
app.patch('/api/:collection/:id', requireAuth, checkCollection, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const projectId = typeof patch.projectId === 'string' ? patch.projectId : null;
    const result = await pool.query(
      `UPDATE records
         SET data = data || $1::jsonb,
             project_id = COALESCE($2, project_id)
       WHERE collection = $3 AND id = $4`,
      [JSON.stringify(patch), projectId, collection, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
    res.status(204).end();
  } catch (err) {
    console.error('PATCH /api/%s/%s failed:', req.params.collection, req.params.id, err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// DELETE /api/:collection/:id
app.delete('/api/:collection/:id', requireAuth, checkCollection, async (req, res) => {
  try {
    const { collection, id } = req.params;
    await pool.query('DELETE FROM records WHERE collection = $1 AND id = $2', [collection, id]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/%s/%s failed:', req.params.collection, req.params.id, err);
    res.status(500).json({ error: 'Error de servidor' });
  }
});

// Static frontend (the app itself)
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Caja de Obra] escuchando en el puerto ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[Caja de Obra] no se pudo preparar la base de datos:', err);
    process.exit(1);
  });
