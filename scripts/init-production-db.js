import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { applyMigrations } from './migrations.js';
import { publishCatalogSnapshot } from '../backend/utils/catalog.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  await pool.query(await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'));
  await applyMigrations(pool);
  await pool.query(
    await readFile(new URL('../database/seed-catalog.sql', import.meta.url), 'utf8'),
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await publishCatalogSnapshot(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  console.log(
    'Production database schema, migrations, and catalog are ready. No user accounts were created.',
  );
} finally {
  await pool.end();
}
