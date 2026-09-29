import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import readline from 'node:readline';
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !process.stdin.isTTY) {
  console.error(
    'Usage: npm run user:password -- user@example.com (run in an interactive terminal)',
  );
  process.exit(1);
}
process.stdout.write('New password (at least 12 characters): ');
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
let password = '';
process.stdin.on('keypress', async (text, key) => {
  if (key?.ctrl && key.name === 'c') {
    process.stdin.setRawMode(false);
    process.exit(1);
  }
  if (key?.name === 'backspace') {
    password = password.slice(0, -1);
    return;
  }
  if (key?.name === 'return') {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    if (password.length < 12 || Buffer.byteLength(password) > 72) {
      console.error('Use at least 12 characters and at most 72 UTF-8 bytes.');
      process.exit(1);
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const hash = await bcrypt.hash(password, 12);
      const result = await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [
        hash,
        email,
      ]);
      if (!result.rowCount) throw new Error('Account not found.');
      console.log(
        'Password updated. Existing sessions expire within 12 hours. Rotate JWT_SECRET to invalidate all sessions immediately.',
      );
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      password = '';
      await pool.end();
    }
  } else if (text && !key?.ctrl && !key?.meta) password += text;
});
