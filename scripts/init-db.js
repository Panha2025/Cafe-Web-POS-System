import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { applyMigrations } from './migrations.js';
import { publishCatalogSnapshot } from '../backend/utils/catalog.js';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(await readFile('database/schema.sql', 'utf8'));
  await applyMigrations(pool);
  await pool.query(await readFile('database/seed.sql', 'utf8'));
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
  console.log('Schema and demo data ready. Existing products and settings preserved.');
} finally {
  await pool.end();
}
