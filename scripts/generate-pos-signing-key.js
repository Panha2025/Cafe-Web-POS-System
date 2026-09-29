import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const keyId = process.argv[2] || 'pos-catalog-v1';
if (!/^[a-zA-Z0-9._-]{1,100}$/.test(keyId)) {
  console.error('Key ID may contain only letters, numbers, dot, underscore, and hyphen.');
  process.exit(1);
}

const privateKeyPath = resolve('.runtime', `${keyId}-private.pem`);
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'der' },
});
await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
try {
  await writeFile(privateKeyPath, privateKey, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(`Signing key already exists at ${privateKeyPath}; choose another key ID.`);
    process.exit(1);
  }
  throw error;
}

console.log(`Created private signing key at ${privateKeyPath}. Keep it out of source control.`);
console.log(`POS_CATALOG_SIGNING_KEY_ID=${keyId}`);
console.log(`POS_CATALOG_SIGNING_PRIVATE_KEY_PATH=${privateKeyPath}`);
console.log(`VITE_POS_CATALOG_PUBLIC_KEYS={"${keyId}":"${publicKey.toString('base64')}"}`);
