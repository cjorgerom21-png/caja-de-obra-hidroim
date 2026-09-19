// Caja de Obra — backend
//
// A tiny generic document store on top of PostgreSQL, exposed as a REST API.
// One table ("records") holds every "collection" (projects, categories,
// movements, providers, paymentOrders, dayCloses) as JSONB rows, which keeps
// this server simple while matching the shape the frontend already expects
// (it used to talk to Claude's built-in "db" capability, which works the
// same way: collection + document id + JSON body).

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
const ALLOWED_COLLECTIONS = new Set([
  'projects', 'categories', 'movements', 'providers', 'paymentOrders', 'dayCloses',
]);

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
}

const app = express();
app.use(express.json({ limit: '2mb' }));

function checkCollection(req, res, next) {
  if (!ALLOWED_COLLECTIONS.has(req.params.collection)) {
    return res.status(404).json({ error: 'Colección desconocida' });
  }
  next();
}

// GET /api/:collection            -> all docs in that collection
// GET /api/:collection?projectId=X -> only docs belonging to that project
app.get('/api/:collection', checkCollection, async (req, res) => {
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
app.post('/api/:collection', checkCollection, async (req, res) => {
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
app.patch('/api/:collection/:id', checkCollection, async (req, res) => {
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
app.delete('/api/:collection/:id', checkCollection, async (req, res) => {
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
