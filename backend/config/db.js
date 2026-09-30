import './env.js';
import pg from 'pg';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.VERCEL ? 3 : 10,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (error) => console.error('Database pool error:', error.message));
