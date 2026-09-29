import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { projectPublicCatalog, stableJson } from '../backend/services/catalog-signing.js';
import { isLeaseUsable, verifySignedEnvelope } from '../frontend/src/offline/catalog.js';

globalThis.crypto ||= webcrypto;

function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return { privateKey, publicKey: publicKey.toString('base64') };
}

function envelope(type, keyId, key, payload, version) {
  const payloadText = stableJson(payload);
  const digest = createHash('sha256').update(payloadText).digest('hex');
  const signature = sign('sha256', Buffer.from(`${type}\n${keyId}\n${digest}\n${payloadText}`), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return {
    ...(type === 'catalog' ? { type, version: String(version) } : { type }),
    key_id: keyId,
    digest,
    signature,
    payload_text: payloadText,
  };
}

const snapshot = {
  settings: {
    cafe_name: 'Test Café',
    address: '1 Main St',
    phone: '555-0100',
    currency: 'USD',
    tax_percentage: '10.00',
    logo_url: null,
    khqr_url: '/private/payment-qr.png',
  },
  categories: [{ id: 1, name: 'Coffee', internal_note: 'must not be public' }],
  products: [
    {
      id: 5,
      name: 'Latte',
      price: '3.50',
      category_id: 1,
      category: 'Coffee',
      available: true,
      image_url: '/uploads/latte.webp',
      cost_price: '0.40',
      supplier_id: 72,
      updated_at: '2026-09-01T12:00:00Z',
      deleted_at: null,
    },
  ],
};

test('signed catalog projection includes only allowlisted public fields', () => {
  const payload = projectPublicCatalog(snapshot, 12, '2026-09-01T12:00:00Z');
  assert.deepEqual(Object.keys(payload.settings), [
    'cafe_name',
    'address',
    'phone',
    'currency',
    'tax_percentage',
    'logo_url',
  ]);
  assert.equal('khqr_url' in payload.settings, false);
  assert.equal('internal_note' in payload.categories[0], false);
  assert.equal('cost_price' in payload.products[0], false);
  assert.equal('supplier_id' in payload.products[0], false);
});

test('catalog digest and signature verify, and tampering is rejected', async () => {
  const key = signingKey();
  const payload = projectPublicCatalog(snapshot, 12, '2026-09-01T12:00:00Z');
  const signed = envelope('catalog', 'key-1', key, payload, 12);
  const trusted = { 'key-1': key.publicKey };
  assert.equal((await verifySignedEnvelope(signed, 'catalog', trusted)).catalog_version, '12');

  await assert.rejects(
    verifySignedEnvelope(
      { ...signed, payload_text: `${signed.payload_text} ` },
      'catalog',
      trusted,
    ),
    /digest verification failed/,
  );
  await assert.rejects(
    verifySignedEnvelope(
      { ...signed, signature: Buffer.alloc(64).toString('base64') },
      'catalog',
      trusted,
    ),
    /signature verification failed/,
  );
  await assert.rejects(verifySignedEnvelope(signed, 'catalog', {}), /not trusted/);
});

test('catalog signing key rotation accepts configured key IDs and rejects untrusted IDs', async () => {
  const oldKey = signingKey();
  const newKey = signingKey();
  const payload = projectPublicCatalog(snapshot, 13, '2026-09-02T12:00:00Z');
  const previous = envelope('catalog', 'old-key', oldKey, payload, 13);
  const rotated = envelope('catalog', 'new-key', newKey, payload, 13);
  const ring = { 'old-key': oldKey.publicKey, 'new-key': newKey.publicKey };
  assert.equal((await verifySignedEnvelope(previous, 'catalog', ring)).catalog_version, '13');
  assert.equal((await verifySignedEnvelope(rotated, 'catalog', ring)).catalog_version, '13');
  await assert.rejects(
    verifySignedEnvelope(rotated, 'catalog', { 'old-key': oldKey.publicKey }),
    /not trusted/,
  );
});

test('catalog rejects signed payloads with fields outside the public schema', async () => {
  const key = signingKey();
  const payload = { ...projectPublicCatalog(snapshot, 12), private_flag: true };
  const signed = envelope('catalog', 'key-1', key, payload, 12);
  await assert.rejects(
    verifySignedEnvelope(signed, 'catalog', { 'key-1': key.publicKey }),
    /unsupported format/,
  );
});

test('leases are signed, capability-scoped, and bound to device/catalog/version and expiry', async () => {
  const key = signingKey();
  const now = Date.now();
  const lease = {
    schema_version: 1,
    lease_id: 'lease-1',
    device_id: 'device-1',
    credential_id: 'credential-1',
    catalog_version: '12',
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    capabilities: ['catalog:read'],
  };
  const signed = envelope('lease', 'key-1', key, lease);
  const parsed = await verifySignedEnvelope(signed, 'lease', { 'key-1': key.publicKey });
  assert.equal(
    isLeaseUsable(parsed, {
      deviceId: 'device-1',
      credentialId: 'credential-1',
      catalogVersion: '12',
      now,
    }).valid,
    true,
  );
  assert.equal(
    isLeaseUsable(parsed, {
      deviceId: 'device-1',
      credentialId: 'credential-1',
      catalogVersion: '12',
      now,
      requiredCapabilities: ['catalog:read', 'orders:cash:offline'],
    }).valid,
    false,
    'legacy catalog-only leases cannot authorize offline sales',
  );
  const cashLease = { ...lease, capabilities: ['catalog:read', 'orders:cash:offline'] };
  const signedCashLease = envelope('lease', 'key-1', key, cashLease);
  const parsedCashLease = await verifySignedEnvelope(signedCashLease, 'lease', {
    'key-1': key.publicKey,
  });
  assert.equal(
    isLeaseUsable(parsedCashLease, {
      deviceId: 'device-1',
      credentialId: 'credential-1',
      catalogVersion: '12',
      now,
      requiredCapabilities: ['catalog:read', 'orders:cash:offline'],
    }).valid,
    true,
  );
  assert.equal(
    isLeaseUsable(parsed, {
      deviceId: 'device-2',
      credentialId: 'credential-1',
      catalogVersion: '12',
      now,
    }).valid,
    false,
  );
  assert.equal(
    isLeaseUsable(parsed, {
      deviceId: 'device-1',
      credentialId: 'credential-1',
      catalogVersion: '13',
      now,
    }).valid,
    false,
  );
  assert.equal(
    isLeaseUsable(parsed, {
      deviceId: 'device-1',
      credentialId: 'credential-1',
      catalogVersion: '12',
      now: now + 120_000,
    }).reason,
    'expired',
  );

  const unsafe = { ...lease, capabilities: ['catalog:read', 'order:create'] };
  const unsafeSigned = envelope('lease', 'key-1', key, unsafe);
  await assert.rejects(
    verifySignedEnvelope(unsafeSigned, 'lease', { 'key-1': key.publicKey }),
    /lease claims are invalid/,
  );
});
