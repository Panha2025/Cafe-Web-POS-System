import 'dotenv/config';
import pg from 'pg';
import { applyMigrations } from './migrations.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const migrations = await applyMigrations(pool);
  console.log(
    `Database migrations current (${migrations.length} migration${migrations.length === 1 ? '' : 's'}).`,
  );
} catch (error) {
  console.error(`Database migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
