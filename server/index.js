import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import assetHandler from '../api/asset.js';
import photosHandler from '../api/photos.js';
import groqHandler from '../api/groq.js';

// NOTE: stdlib http, not Express — the environment's npm tree cannot
// materialize express's transitive deps (see DECISIONS). 8 JSON routes
// don't justify fighting that; pg + dotenv load fine.

const PORT = Number(process.env.API_PORT || 3001);
const BODY_LIMIT = 25 * 1024 * 1024;

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'oovi',
});
pool.on('error', (error) => console.error('[db] pool error:', error.message));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS designs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL DEFAULT 'Untitled design',
    design JSONB NOT NULL DEFAULT '{"canvas":null,"elements":[]}',
    thumbnail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS designs_updated_idx ON designs (updated_at DESC);
  ALTER TABLE designs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS designs_deleted_idx ON designs (deleted_at);
`;

let dbReady = false;
try {
  await pool.query(SCHEMA);
  dbReady = true;
  console.log('[db] schema ready');
} catch (error) {
  console.error('[db] unavailable at boot:', error.message);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Adapt stdlib req/res to the (req, res) shape api/*.js handlers expect
// (same shape Vercel provides: query/body + status().json()/.end()).
function adapt(req, res, query, body) {
  const shimReq = { method: req.method, query, body };
  const shimRes = {
    status: (code) => ({
      json: (obj) => sendJson(res, code, obj),
      end: () => {
        res.writeHead(code);
        res.end();
      },
    }),
  };
  return [shimReq, shimRes];
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const done = (code) => console.log(`${req.method} ${req.url.split('?')[0]} ${code} ${Date.now() - started}ms`);
  const finish = (code, obj) => {
    done(code);
    if (obj === undefined) {
      res.writeHead(code);
      res.end();
      return;
    }
    sendJson(res, code, obj);
  };
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    const idMatch = path.match(/^\/api\/designs\/([^/]+)(\/(duplicate|restore|permanent))?$/);

    if (req.method === 'GET' && path === '/api/health') {
      try {
        await pool.query('SELECT 1');
        return finish(200, { ok: true, db: true });
      } catch (error) {
        return finish(200, { ok: true, db: false, error: error.message });
      }
    }

    if (path === '/api/asset' || path === '/api/photos' || path === '/api/groq') {
      const handler = path === '/api/asset' ? assetHandler : path === '/api/photos' ? photosHandler : groqHandler;
      if (req.method !== 'GET' && req.method !== 'POST') return finish(405, { error: 'GET or POST only' });
      const body = req.method === 'POST' ? await readBody(req).catch(() => undefined) : undefined;
      await handler(...adapt(req, res, query, body));
      done(res.statusCode || 200);
      return;
    }

    if (!dbReady && path.startsWith('/api/designs')) {
      return finish(503, { error: 'database unavailable' });
    }

    if (req.method === 'GET' && path === '/api/designs') {
      const trashed = query.deleted === '1';
      const { rows } = await pool.query(
        trashed
          ? 'SELECT id, title, thumbnail, created_at, updated_at FROM designs WHERE deleted_at IS NOT NULL ORDER BY updated_at DESC LIMIT 100'
          : 'SELECT id, title, thumbnail, created_at, updated_at FROM designs WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100',
      );
      console.log(`[designs] list rows=${rows.length} trashed=${trashed}`);
      return finish(200, { designs: rows });
    }

    if (req.method === 'POST' && path === '/api/designs') {
      const body = (await readBody(req)) || {};
      const title = String(body.title || 'Untitled design').slice(0, 120);
      const design = body.design || { canvas: body.canvas || null, elements: [] };
      const { rows } = await pool.query(
        'INSERT INTO designs (title, design) VALUES ($1, $2) RETURNING id, title, created_at, updated_at',
        [title, design],
      );
      console.log(`[designs] created ${rows[0].id} "${title}"`);
      return finish(201, { design: rows[0] });
    }

    if (idMatch && req.method === 'GET' && !idMatch[2]) {
      const { rows } = await pool.query('SELECT * FROM designs WHERE id = $1', [idMatch[1]]);
      if (!rows.length) return finish(404, { error: 'not found' });
      return finish(200, { design: rows[0] });
    }

    if (idMatch && req.method === 'PUT' && !idMatch[2]) {
      const body = (await readBody(req)) || {};
      const { rows } = await pool.query(
        `UPDATE designs SET
           title = COALESCE($2, title),
           design = COALESCE($3, design),
           thumbnail = COALESCE($4, thumbnail),
           updated_at = now()
         WHERE id = $1
         RETURNING id, title, updated_at`,
        [idMatch[1], body.title ?? null, body.design ?? null, body.thumbnail ?? null],
      );
      if (!rows.length) return finish(404, { error: 'not found' });
      return finish(200, { design: rows[0] });
    }

    if (req.method === 'POST' && path === '/api/designs/empty-trash') {
      const { rowCount } = await pool.query('DELETE FROM designs WHERE deleted_at IS NOT NULL');
      console.log(`[designs] empty-trash n=${rowCount}`);
      return finish(200, { deleted: rowCount });
    }

    if (idMatch && req.method === 'POST' && idMatch[2] === '/duplicate') {
      const { rows } = await pool.query(
        `INSERT INTO designs (title, design, thumbnail)
         SELECT title || ' copy', design, thumbnail FROM designs WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, title, thumbnail, created_at, updated_at`,
        [idMatch[1]],
      );
      if (!rows.length) return finish(404, { error: 'not found' });
      console.log(`[designs] duplicated ${idMatch[1]} -> ${rows[0].id}`);
      return finish(201, { design: rows[0] });
    }

    if (idMatch && req.method === 'POST' && idMatch[2] === '/restore') {
      const { rows } = await pool.query(
        'UPDATE designs SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, title, updated_at',
        [idMatch[1]],
      );
      if (!rows.length) return finish(404, { error: 'not found' });
      console.log(`[designs] restored ${idMatch[1]}`);
      return finish(200, { design: rows[0] });
    }

    if (idMatch && req.method === 'DELETE' && !idMatch[2]) {
      const { rowCount } = await pool.query(
        'UPDATE designs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
        [idMatch[1]],
      );
      if (!rowCount) return finish(404, { error: 'not found' });
      console.log(`[designs] trashed ${idMatch[1]}`);
      return finish(204);
    }

    if (idMatch && req.method === 'DELETE' && idMatch[2] === '/permanent') {
      const { rowCount } = await pool.query('DELETE FROM designs WHERE id = $1', [idMatch[1]]);
      if (!rowCount) return finish(404, { error: 'not found' });
      console.log(`[designs] destroyed ${idMatch[1]}`);
      return finish(204);
    }

    return finish(404, { error: 'not found' });
  } catch (error) {
    console.error(`[api] ${req.method} ${req.url} crashed:`, error.message);
    if (!res.headersSent) return finish(500, { error: 'server error' });
    try {
      res.end();
    } catch {
      // already closing
    }
  }
});

server.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
