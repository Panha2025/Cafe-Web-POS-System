import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = fileURLToPath(new URL('../database/migrations/', import.meta.url));
const lockName = 'cafe-pos-schema-migrations';

export async function applyMigrations(pool) {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
    locked = true;
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    for (const name of names) {
      const sql = await readFile(
        new URL(`../database/migrations/${name}`, import.meta.url),
        'utf8',
      );
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = (
        await db.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name])
      ).rows[0];
      if (prior) {
        if (prior.checksum !== checksum)
          throw new Error(`Applied migration ${name} has changed. Add a new migration instead.`);
        continue;
      }

      await db.query('BEGIN');
      try {
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
    return names;
  } finally {
    if (locked) {
      try {
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      } catch {
        // Releasing the connection also releases any remaining session lock.
      }
    }
    db.release();
  }
}
