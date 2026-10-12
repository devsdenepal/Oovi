import 'dotenv/config';
import pg from 'pg';

// Probe: connect, ensure database + table, report. Never prints secrets.
const admin = new pg.Client({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: 'postgres',
});

try {
  await admin.connect();
  console.log('DB-CONNECT ok as ' + (process.env.PGUSER || 'postgres'));
} catch (e) {
  console.log('DB-CONNECT-FAIL ' + e.message);
  process.exit(1);
}

const dbName = process.env.PGDATABASE || 'oovi';
try {
  await admin.query(`CREATE DATABASE ${dbName}`);
  console.log('DB-CREATED ' + dbName);
} catch (e) {
  if (e.code === '42P04') console.log('DB-EXISTS ' + dbName);
  else throw e;
}
await admin.end();

const app = new pg.Client({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: dbName,
});
await app.connect();
await app.query(`
  CREATE TABLE IF NOT EXISTS designs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL DEFAULT 'Untitled design',
    design JSONB NOT NULL DEFAULT '{"canvas":null,"elements":[]}',
    thumbnail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS designs_updated_idx ON designs (updated_at DESC);
`);
const count = await app.query('SELECT COUNT(*)::int AS n FROM designs');
console.log('TABLE-OK designs=' + count.rows[0].n);
await app.end();
console.log('DB-PROBE DONE');
