import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env')) {
  writeFileSync(
    '.env',
    readFileSync('.env.example', 'utf8').replace(
      'replace-with-a-long-random-secret-at-least-32-characters',
      randomBytes(48).toString('hex'),
    ),
  );
  console.log('Created .env with a random authentication secret.');
} else console.log('.env already exists; preserved existing configuration.');
