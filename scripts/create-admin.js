import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import readline from 'node:readline';
import { z } from 'zod';

const input = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(1).max(100),
});
const parsed = input.safeParse({ email: process.argv[2], name: process.argv[3] });
if (!parsed.success || !process.env.DATABASE_URL || !process.stdin.isTTY) {
  console.error('Usage: npm run user:create-admin -- admin@example.com "Cafe Admin"');
  console.error(
    'DATABASE_URL must point to the target database and an interactive terminal is required.',
  );
  process.exit(1);
}

async function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Cancelled.'));
      } else if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (key?.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (text && !key?.ctrl && !key?.meta) {
        value += text;
      }
    };
    const cleanup = () => process.stdin.off('keypress', onKeypress);
    process.stdout.write(prompt);
    process.stdin.on('keypress', onKeypress);
  });
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();

let password;
let confirmation;
let promptFailed = false;
try {
  password = await readSecret('New admin password (12–72 UTF-8 bytes): ');
  confirmation = await readSecret('Confirm password: ');
} catch (error) {
  console.error(error.message);
  promptFailed = true;
} finally {
  process.stdin.setRawMode(false);
  process.stdin.pause();
}
if (promptFailed) process.exit(1);

if (
  password !== confirmation ||
  Buffer.byteLength(password) < 12 ||
  Buffer.byteLength(password) > 72
) {
  password = '';
  confirmation = '';
  console.error('Passwords must match and be 12–72 UTF-8 bytes.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
  const existing = (await db.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1")).rowCount;
  if (existing)
    throw new Error('An administrator already exists; refusing to create another bootstrap admin.');
  const passwordHash = await bcrypt.hash(password, 12);
  await db.query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)', [
    parsed.data.name,
    parsed.data.email,
    passwordHash,
    'admin',
  ]);
  await db.query('COMMIT');
  console.log(`Initial administrator created for ${parsed.data.email}.`);
} catch (error) {
  await db.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  password = '';
  confirmation = '';
  db.release();
  await pool.end();
}
