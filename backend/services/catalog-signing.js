import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../utils/errors.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const cachedSigningMaterials = new Map();

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

export function projectPublicCatalog(snapshot, version, createdAt = null) {
  const settings = snapshot.settings || {};
  return {
    schema_version: 1,
    catalog_version: String(version),
    created_at: createdAt ? new Date(createdAt).toISOString() : null,
    settings: {
      cafe_name: settings.cafe_name ?? '',
      address: settings.address ?? '',
      phone: settings.phone ?? '',
      currency: settings.currency ?? 'USD',
      tax_percentage: Number(settings.tax_percentage || 0),
      logo_url: settings.logo_url ?? null,
    },
    categories: (snapshot.categories || []).map((category) => ({
      id: Number(category.id),
      name: String(category.name),
    })),
    products: (snapshot.products || []).map((product) => ({
      id: Number(product.id),
      name: String(product.name),
      price: Number(product.price),
      category_id: Number(product.category_id),
      category: String(product.category || ''),
      available: Boolean(product.available),
      image_url: product.image_url || '/images/coffee.svg',
      updated_at: product.updated_at ? new Date(product.updated_at).toISOString() : null,
      deleted_at: product.deleted_at ? new Date(product.deleted_at).toISOString() : null,
    })),
  };
}

export function digestPayload(payloadText) {
  return createHash('sha256').update(payloadText, 'utf8').digest('hex');
}

export function signatureInput(type, keyId, digest, payloadText) {
  return Buffer.from(`${type}\n${keyId}\n${digest}\n${payloadText}`, 'utf8');
}

async function signingMaterial() {
  const keyId = process.env.POS_CATALOG_SIGNING_KEY_ID || '';
  const privateKeyPath = process.env.POS_CATALOG_SIGNING_PRIVATE_KEY_PATH || '';
  if (!keyId || !privateKeyPath)
    throw new HttpError(503, 'Signed POS catalog service is not configured.');
  const cacheKey = `${keyId}\n${privateKeyPath}`;
  if (cachedSigningMaterials.has(cacheKey)) return cachedSigningMaterials.get(cacheKey);
  try {
    const keyPath = resolve(projectRoot, privateKeyPath);
    const privateKey = createPrivateKey(await readFile(keyPath));
    if (
      privateKey.asymmetricKeyType !== 'ec' ||
      privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw new Error('Signing key must use ECDSA P-256.');
    const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const material = {
      keyId,
      privateKey,
      publicKeySha256: createHash('sha256').update(publicDer).digest('hex'),
    };
    cachedSigningMaterials.set(cacheKey, material);
    return material;
  } catch {
    throw new HttpError(503, 'Signed POS catalog signing key is unavailable or invalid.');
  }
}

export function clearSigningKeyCache() {
  cachedSigningMaterials.clear();
}

export async function signPayload(type, payloadText) {
  const material = await signingMaterial();
  const digest = digestPayload(payloadText);
  const signature = sign('sha256', signatureInput(type, material.keyId, digest, payloadText), {
    key: material.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return { keyId: material.keyId, digest, signature, publicKeySha256: material.publicKeySha256 };
}

export async function signedCatalog(db, version) {
  const { rows } = await db.query(
    'SELECT snapshot,created_at FROM catalog_snapshots WHERE version=$1',
    [version],
  );
  if (!rows[0]) throw new HttpError(404, 'Catalog version not found.');
  const payloadText = stableJson(
    projectPublicCatalog(rows[0].snapshot, version, rows[0].created_at),
  );
  const signed = await signPayload('catalog', payloadText);
  const existing = (
    await db.query(
      `SELECT public_key_sha256,payload_text,payload_sha256,signature
       FROM catalog_snapshot_signatures WHERE version=$1 AND key_id=$2`,
      [version, signed.keyId],
    )
  ).rows[0];
  if (existing) {
    if (
      existing.public_key_sha256 !== signed.publicKeySha256 ||
      existing.payload_text !== payloadText ||
      existing.payload_sha256 !== signed.digest
    )
      throw new HttpError(
        503,
        'Catalog signing key or catalog version conflicts with its stored signature.',
      );
    return {
      type: 'catalog',
      version: String(version),
      key_id: signed.keyId,
      digest: existing.payload_sha256,
      signature: existing.signature,
      payload_text: existing.payload_text,
    };
  }
  await db.query(
    `INSERT INTO catalog_snapshot_signatures
       (version,key_id,public_key_sha256,payload_text,payload_sha256,signature)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(version,key_id) DO NOTHING`,
    [version, signed.keyId, signed.publicKeySha256, payloadText, signed.digest, signed.signature],
  );
  return signedCatalog(db, version);
}

export async function signingKeyFingerprint() {
  const material = await signingMaterial();
  return { keyId: material.keyId, publicKeySha256: material.publicKeySha256 };
}
