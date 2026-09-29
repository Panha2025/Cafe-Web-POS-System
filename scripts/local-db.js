import 'dotenv/config';
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
const databaseDir = path.resolve('.local-db');
const pg = new EmbeddedPostgres({
  databaseDir,
  user: process.env.LOCAL_PG_USER || 'cafepos',
  password: process.env.LOCAL_PG_PASSWORD || 'cafepos_local_dev',
  port: Number(process.env.LOCAL_PG_PORT || 54329),
  persistent: true,
  authMethod: 'scram-sha-256',
  initdbFlags: ['--encoding=UTF8'],
  postgresFlags: ['-h', '127.0.0.1'],
});
if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='cafepos'")).rowCount)
  await client.query("CREATE DATABASE cafepos ENCODING 'UTF8' TEMPLATE template0");
await client.end();
console.log('Local PostgreSQL ready. Keep this terminal running. Next: npm run db:init');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await pg.stop();
    process.exit(0);
  });
setInterval(() => {}, 60000);
