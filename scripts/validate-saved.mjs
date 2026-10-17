import 'dotenv/config';
import { register } from 'node:module';
import pg from 'pg';

// src/ uses extensionless relative imports — resolve them for plain node.
register(new URL('./ext-loader.mjs', import.meta.url));
const { validateDesign } = await import('../src/design/designValidator.js');

// Revalidates every saved design in local Postgres with the CURRENT
// validator. Save never validates (persist path), open always does — so a
// design can save fine and then refuse to open. This catches that drift.
const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'oovi',
});

const { rows } = await pool.query('SELECT id, title FROM designs ORDER BY updated_at DESC');
console.log(`designs: ${rows.length}`);
let bad = 0;
for (const row of rows) {
  const full = await pool.query('SELECT design FROM designs WHERE id = $1', [row.id]);
  const saved = full.rows[0]?.design;
  // Mirrors App.loadProject: empty designs skip validation and open blank.
  if (saved && Array.isArray(saved.elements) && saved.elements.length === 0) {
    console.log(`ok (empty): "${row.title}"`);
    continue;
  }
  const check = validateDesign(saved);
  if (!check.ok) {
    bad++;
    console.log(`FAIL "${row.title}" (${row.id}): ${check.errors.slice(0, 3).join('; ')}`);
  } else {
    console.log(`ok: "${row.title}"`);
  }
}
await pool.end();
console.log(bad === 0 ? 'VALIDATE-SAVED DONE' : `VALIDATE-SAVED: ${bad} UNOPENABLE`);
process.exit(bad === 0 ? 0 : 1);
