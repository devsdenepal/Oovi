import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'oovi',
});
const id = process.argv[2] || 'cc1ca114-805f-40fc-b7fb-7993fc3e749b';
const { rows } = await pool.query('SELECT design FROM designs WHERE id = $1', [id]);
const walk = (els, prefix) => {
  for (const el of els || []) {
    if (!el || typeof el !== 'object') continue;
    console.log(`${prefix}${el.id} [${el.type}] x=${el.x} y=${el.y} w=${el.width} h=${el.height} r=${el.radius} fill=${el.fill}`);
    if (el.gradient) console.log(`  gradient: ${JSON.stringify(el.gradient)}`);
    if (el.children) walk(el.children, `${prefix}${el.id}/`);
  }
};
walk(rows[0]?.design?.elements, '');
await pool.end();
