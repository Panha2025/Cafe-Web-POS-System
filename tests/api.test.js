import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { applyMigrations } from '../scripts/migrations.js';
import { publishCatalogSnapshot } from '../backend/utils/catalog.js';
import {
  projectPublicCatalog,
  signatureInput,
  stableJson,
} from '../backend/services/catalog-signing.js';
const apiPort = Number(process.env.TEST_API_PORT || 4000);
const base = `http://127.0.0.1:${apiPort}/api`;
let cookie = '';
async function request(path, options = {}, session = cookie) {
  const res = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(session ? { Cookie: session } : {}),
      ...options.headers,
    },
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
const json = (body) => ({ method: 'POST', body: JSON.stringify(body) });
test('PostgreSQL API integration: authentication, authorization, products, uploads, checkout, reports, settings', async (t) => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let productId, oldSettings, deviceId, syncDeviceId, syncCredentialId, syncCatalogKeyId;
  const orderIds = [];
  const offlineOrderIds = [];
  const image = await sharp({
    create: { width: 80, height: 80, channels: 3, background: '#426a3a' },
  })
    .png()
    .toBuffer();
  const productForm = (name, price, file = image) => {
    const f = new FormData();
    f.set('name', name);
    f.set('price', price);
    f.set('category_id', '1');
    f.set('available', 'true');
    f.set('image', new Blob([file], { type: 'image/png' }), 'test.png');
    return f;
  };
  try {
    await t.test('versioned migrations are repeatable and sync foundation exists', async () => {
      const first = await applyMigrations(db);
      const second = await applyMigrations(db);
      assert.deepEqual(second, first);
      assert.ok(first.includes('0001_pos_sync_foundation.sql'));
      assert.ok(first.includes('0003_offline_cash_sync.sql'));
      const tables = (
        await db.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema='public' AND table_name=ANY($1::text[])`,
          [
            [
              'schema_migrations',
              'pos_devices',
              'catalog_state',
              'catalog_snapshots',
              'order_sync_receipts',
              'pos_device_enrollment_codes',
              'pos_device_credentials',
              'pos_device_challenges',
              'catalog_snapshot_signatures',
              'pos_offline_leases',
            ],
          ],
        )
      ).rows.map((row) => row.table_name);
      assert.equal(tables.length, 10);
      const orderColumns = (
        await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='orders'`,
        )
      ).rows.map((row) => row.column_name);
      for (const column of [
        'source',
        'device_id',
        'device_sequence',
        'catalog_version',
        'client_created_at',
      ])
        assert.ok(orderColumns.includes(column));
      const currentVersion = (await db.query('SELECT version FROM catalog_state WHERE id=1'))
        .rows[0].version;
      const latestSnapshot = (
        await db.query('SELECT version FROM catalog_snapshots ORDER BY version DESC LIMIT 1')
      ).rows[0].version;
      assert.equal(String(currentVersion), String(latestSnapshot));
    });
    await t.test('health confirms real PostgreSQL and UTF8', async () => {
      assert.equal((await request('/health')).data.database, 'PostgreSQL');
      assert.equal((await db.query('SHOW server_encoding')).rows[0].server_encoding, 'UTF8');
    });
    await t.test('incorrect credentials and anonymous access denied', async () => {
      assert.equal(
        (await request('/auth/login', json({ email: 'admin@cafepos.local', password: 'wrong' })))
          .status,
        401,
      );
      assert.equal((await request('/products')).status, 401);
    });
    await t.test('admin login uses secure httpOnly cookie and bcrypt hash', async () => {
      const r = await request(
        '/auth/login',
        json({ email: 'admin@cafepos.local', password: 'Admin123!' }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.data.role, 'admin');
      assert.match(r.headers.get('set-cookie'), /HttpOnly/);
      assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
      cookie = r.headers.get('set-cookie').split(';')[0];
      const u = (
        await db.query("SELECT password_hash FROM users WHERE email='admin@cafepos.local'")
      ).rows[0];
      assert.match(u.password_hash, /^\$2b\$12\$/);
    });
    oldSettings = (await request('/settings')).data;
    await t.test('cashier is denied all admin mutation and report routes', async () => {
      const r = await request(
        '/auth/login',
        json({ email: 'cashier@cafepos.local', password: 'Cashier123!' }),
      );
      const c = r.headers.get('set-cookie').split(';')[0];
      for (const [path, method] of [
        ['/products', 'POST'],
        ['/products/1', 'PUT'],
        ['/products/1', 'DELETE'],
        ['/settings', 'PUT'],
        ['/reports/summary', 'GET'],
      ])
        assert.equal((await request(path, { method }, c)).status, 403);
      assert.equal((await request('/orders', {}, c)).status, 200);
      assert.equal((await request('/devices', {}, c)).status, 403);
      assert.equal(
        (
          await request(
            '/devices',
            { method: 'POST', body: JSON.stringify({ name: 'Cashier device' }) },
            c,
          )
        ).status,
        403,
      );
    });
    await t.test(
      'admin can enroll, authenticate, rotate, and revoke a POS device securely',
      async () => {
        const created = await request('/devices', {
          method: 'POST',
          body: JSON.stringify({ name: 'API test till' }),
        });
        assert.equal(created.status, 201);
        deviceId = created.data.id;
        assert.match(deviceId, /^[0-9a-f-]{36}$/i);
        assert.equal(created.data.revoked_at, null);
        assert.ok((await request('/devices')).data.some((device) => device.id === deviceId));

        const makeDeviceKey = () =>
          generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'der' },
          });
        const signMessage = (key, message) =>
          sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString(
            'base64',
          );
        const expiredKey = makeDeviceKey();
        await db.query(
          "UPDATE pos_device_enrollment_codes SET created_at=now()-interval '20 minutes', expires_at=now()-interval '1 minute' WHERE device_id=$1 AND consumed_at IS NULL",
          [deviceId],
        );
        assert.equal(
          (
            await request(
              '/pos/enroll',
              json({
                pairing_code: created.data.pairing_code,
                credential_id: randomUUID(),
                public_key_spki: expiredKey.publicKey.toString('base64'),
              }),
              '',
            )
          ).status,
          410,
        );

        const newPairing = await request(`/devices/${deviceId}/pairing-codes`, { method: 'POST' });
        assert.equal(newPairing.status, 201);
        const firstKey = makeDeviceKey();
        const firstCredentialId = randomUUID();
        const enrolled = await request(
          '/pos/enroll',
          json({
            pairing_code: newPairing.data.pairing_code,
            credential_id: firstCredentialId,
            public_key_spki: firstKey.publicKey.toString('base64'),
          }),
          '',
        );
        assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));
        assert.equal(enrolled.data.device_id, deviceId);
        assert.equal(enrolled.data.credential_id, firstCredentialId);
        assert.equal(
          (
            await request(
              '/pos/enroll',
              json({
                pairing_code: newPairing.data.pairing_code,
                credential_id: randomUUID(),
                public_key_spki: firstKey.publicKey.toString('base64'),
              }),
              '',
            )
          ).status,
          401,
          'pairing codes can be used only once',
        );

        const firstChallenge = (
          await request(
            '/pos/challenge',
            json({
              device_id: deviceId,
              credential_id: firstCredentialId,
            }),
            '',
          )
        ).data.challenge;
        const firstAuth = await request(
          '/pos/session',
          json({
            device_id: deviceId,
            credential_id: firstCredentialId,
            challenge: firstChallenge,
            signature: signMessage(
              firstKey.privateKey,
              `pos-device-auth-v1\n${deviceId}\n${firstCredentialId}\n${firstChallenge}`,
            ),
          }),
          '',
        );
        assert.equal(firstAuth.status, 200);
        const firstToken = firstAuth.data.access_token;
        assert.equal(
          (
            await request(
              '/pos/session',
              json({
                device_id: deviceId,
                credential_id: firstCredentialId,
                challenge: firstChallenge,
                signature: signMessage(
                  firstKey.privateKey,
                  `pos-device-auth-v1\n${deviceId}\n${firstCredentialId}\n${firstChallenge}`,
                ),
              }),
              '',
            )
          ).status,
          409,
          'authentication challenges cannot be replayed',
        );
        assert.equal(
          (await request('/orders', { headers: { Authorization: `Bearer ${firstToken}` } }, ''))
            .status,
          401,
        );
        assert.equal((await request('/devices', {}, `cafe_session=${firstToken}`)).status, 401);

        const bootstrap = await request(
          '/pos/bootstrap',
          {
            headers: { Authorization: `Bearer ${firstToken}` },
          },
          '',
        );
        if (
          !process.env.POS_CATALOG_SIGNING_KEY_ID ||
          !process.env.POS_CATALOG_SIGNING_PRIVATE_KEY_PATH
        ) {
          assert.equal(
            bootstrap.status,
            503,
            'signed catalog bootstrap fails closed without server signing keys',
          );
        } else {
          assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.data));
          const envelope = bootstrap.data.catalog;
          const payload = JSON.parse(envelope.payload_text);
          assert.equal(payload.catalog_version, envelope.version);
          assert.equal('khqr_url' in payload.settings, false);
          assert.equal('password_hash' in payload.settings, false);
          assert.equal('supplier_id' in (payload.products[0] || {}), false);
          assert.equal(
            createHash('sha256').update(envelope.payload_text).digest('hex'),
            envelope.digest,
          );
          const publicRing = JSON.parse(process.env.VITE_POS_CATALOG_PUBLIC_KEYS || '{}');
          const publicKeyDer = publicRing[envelope.key_id]
            ? Buffer.from(publicRing[envelope.key_id], 'base64')
            : createPublicKey(
                createPrivateKey(
                  await readFile(resolve(process.env.POS_CATALOG_SIGNING_PRIVATE_KEY_PATH)),
                ),
              ).export({ type: 'spki', format: 'der' });
          const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
          assert.equal(
            verify(
              'sha256',
              Buffer.from(
                `catalog\n${envelope.key_id}\n${envelope.digest}\n${envelope.payload_text}`,
              ),
              { key: publicKey, dsaEncoding: 'ieee-p1363' },
              Buffer.from(envelope.signature, 'base64'),
            ),
            true,
          );

          const issued = await request(
            '/pos/lease',
            {
              ...json({ catalog_version: payload.catalog_version }),
              headers: { Authorization: `Bearer ${firstToken}` },
            },
            '',
          );
          assert.equal(issued.status, 201, JSON.stringify(issued.data));
          const lease = JSON.parse(issued.data.payload_text);
          assert.equal(lease.device_id, deviceId);
          assert.equal(lease.credential_id, firstCredentialId);
          assert.equal(lease.catalog_version, payload.catalog_version);
          assert.deepEqual(lease.capabilities, ['catalog:read', 'orders:cash:offline']);
          assert.ok(Date.parse(lease.expires_at) > Date.now());
          assert.equal(
            (
              await request(
                '/pos/lease',
                {
                  ...json({ catalog_version: String(BigInt(payload.catalog_version) + 1n) }),
                  headers: { Authorization: `Bearer ${firstToken}` },
                },
                '',
              )
            ).status,
            409,
            'leases cannot be requested for a different catalog version',
          );
        }

        const nextKey = makeDeviceKey();
        const nextCredentialId = randomUUID();
        const keyDigest = createHash('sha256').update(nextKey.publicKey).digest('hex');
        const rotationChallenge = (
          await request(
            '/pos/challenge',
            json({
              device_id: deviceId,
              credential_id: firstCredentialId,
            }),
            '',
          )
        ).data.challenge;
        const rotationMessage = `pos-device-key-rotation-v1\n${deviceId}\n${firstCredentialId}\n${rotationChallenge}\n${keyDigest}`;
        const rotated = await request(
          '/pos/rotate-key',
          {
            ...json({
              challenge: rotationChallenge,
              signature: signMessage(firstKey.privateKey, rotationMessage),
              new_credential_id: nextCredentialId,
              new_public_key_spki: nextKey.publicKey.toString('base64'),
            }),
            headers: { Authorization: `Bearer ${firstToken}` },
          },
          '',
        );
        assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
        assert.equal(rotated.data.credential_id, nextCredentialId);
        assert.ok(
          (
            await db.query(
              'SELECT id FROM pos_offline_leases WHERE device_id=$1 AND revoked_at IS NOT NULL',
              [deviceId],
            )
          ).rowCount > 0,
        );
        assert.equal(
          (
            await request(
              '/pos/bootstrap',
              {
                headers: { Authorization: `Bearer ${firstToken}` },
              },
              '',
            )
          ).status,
          401,
          'the previous device credential is revoked on rotation',
        );

        const nextChallenge = (
          await request(
            '/pos/challenge',
            json({
              device_id: deviceId,
              credential_id: nextCredentialId,
            }),
            '',
          )
        ).data.challenge;
        const nextAuth = await request(
          '/pos/session',
          json({
            device_id: deviceId,
            credential_id: nextCredentialId,
            challenge: nextChallenge,
            signature: signMessage(
              nextKey.privateKey,
              `pos-device-auth-v1\n${deviceId}\n${nextCredentialId}\n${nextChallenge}`,
            ),
          }),
          '',
        );
        assert.equal(nextAuth.status, 200);

        const revoked = await request(`/devices/${deviceId}`, { method: 'DELETE' });
        assert.equal(revoked.status, 200);
        assert.ok(revoked.data.revoked_at);
        assert.equal(
          (
            await request(
              '/pos/challenge',
              json({
                device_id: deviceId,
                credential_id: nextCredentialId,
              }),
              '',
            )
          ).status,
          401,
        );
        assert.ok((await request('/devices')).data.some((device) => device.id === deviceId));
      },
    );
    await t.test('origin protection rejects cross-site writes', async () => {
      assert.equal(
        (
          await request('/products', {
            method: 'POST',
            headers: { Origin: 'https://untrusted.example' },
          })
        ).status,
        403,
      );
    });
    await t.test('product creation stores path and valid image', async () => {
      const beforeVersion = (await db.query('SELECT version FROM catalog_state WHERE id=1')).rows[0]
        .version;
      const r = await request('/products', {
        method: 'POST',
        body: productForm('API Integration Latte', '3.00'),
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      productId = r.data.id;
      assert.match(r.data.image_url, /^\/uploads\/.*\.webp$/);
      const snapshot = (
        await db.query(
          'SELECT version,snapshot FROM catalog_snapshots ORDER BY version DESC LIMIT 1',
        )
      ).rows[0];
      assert.ok(BigInt(snapshot.version) > BigInt(beforeVersion));
      assert.ok(snapshot.snapshot.products.some((product) => product.id === productId));
      const photo = await fetch(`http://127.0.0.1:${apiPort}` + r.data.image_url);
      assert.equal(photo.status, 200);
      assert.match(photo.headers.get('content-type'), /image\/webp/);
    });
    await t.test(
      'invalid price, category, content, type, and oversized images rejected',
      async () => {
        assert.equal(
          (await request('/products', { method: 'POST', body: productForm('Invalid', '-1') }))
            .status,
          400,
        );
        const badCategory = productForm('Invalid', '3');
        badCategory.set('category_id', '999999');
        assert.equal(
          (await request('/products', { method: 'POST', body: badCategory })).status,
          400,
        );
        assert.equal(
          (
            await request('/products', {
              method: 'POST',
              body: productForm('Invalid', '3', Buffer.from('not an image')),
            })
          ).status,
          400,
        );
        const svg = productForm('Invalid', '3');
        svg.set('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'bad.svg');
        assert.equal((await request('/products', { method: 'POST', body: svg })).status, 400);
        assert.equal(
          (
            await request('/products', {
              method: 'POST',
              body: productForm('Invalid', '3', Buffer.alloc(5 * 1024 * 1024 + 1)),
            })
          ).status,
          400,
        );
      },
    );
    await t.test('settings, tax, logo and KHQR upload persist', async () => {
      const beforeVersion = (await db.query('SELECT version FROM catalog_state WHERE id=1')).rows[0]
        .version;
      const f = new FormData();
      for (const key of ['cafe_name', 'address', 'phone', 'currency']) f.set(key, oldSettings[key]);
      f.set('tax_percentage', '10');
      f.set('logo', new Blob([image], { type: 'image/png' }), 'logo.png');
      f.set('khqr', new Blob([image], { type: 'image/png' }), 'qr.png');
      const r = await request('/settings', { method: 'PUT', body: f });
      assert.equal(r.status, 200);
      assert.equal(Number(r.data.tax_percentage), 10);
      assert.match(r.data.khqr_url, /uploads/);
      const snapshot = (
        await db.query(
          'SELECT version,snapshot FROM catalog_snapshots ORDER BY version DESC LIMIT 1',
        )
      ).rows[0];
      assert.ok(BigInt(snapshot.version) > BigInt(beforeVersion));
      assert.equal(Number(snapshot.snapshot.settings.tax_percentage), 10);
    });
    const checkout = (method = 'cash') => ({
      request_id: randomUUID(),
      items: [{ product_id: productId, quantity: 2, expected_price: 3 }],
      discount: 1,
      expected_total: 5.5,
      payment_method: method,
      cash_received: 10,
      confirmed: true,
      // These client-supplied sync and identity fields must be ignored by online checkout.
      source: 'offline',
      device_id: randomUUID(),
      device_sequence: -1,
      catalog_version: 999999999,
      client_created_at: '1970-01-01T00:00:00.000Z',
      cashier_id: 999999,
    });
    await t.test(
      'empty cart, invalid quantities, insufficient cash and stale totals rejected',
      async () => {
        for (const patch of [
          { items: [] },
          { items: [{ product_id: productId, quantity: 0, expected_price: 3 }] },
          { cash_received: 5 },
          { discount: 7 },
          { payment_method: 'bank' },
          { confirmed: false },
        ])
          assert.equal((await request('/orders', json({ ...checkout(), ...patch }))).status, 400);
        assert.equal(
          (await request('/orders', json({ ...checkout(), expected_total: 1 }))).status,
          409,
        );
      },
    );
    await t.test(
      'cash transaction saves exact discount, tax, change and price snapshots',
      async () => {
        const r = await request('/orders', json(checkout()));
        assert.equal(r.status, 201, JSON.stringify(r.data));
        orderIds.push(r.data.id);
        assert.equal(Number(r.data.subtotal), 6);
        assert.equal(Number(r.data.discount), 1);
        assert.equal(Number(r.data.tax), 0.5);
        assert.equal(Number(r.data.total), 5.5);
        assert.equal(Number(r.data.change_amount), 4.5);
        assert.equal(r.data.items[0].quantity, 2);
        assert.equal(r.data.source, 'online');
        assert.equal(r.data.device_id, null);
        assert.equal(r.data.device_sequence, null);
        assert.equal(r.data.client_created_at, null);
        assert.ok(Number(r.data.catalog_version) >= 0);
        const receipt = (
          await db.query(
            'SELECT payload_hash,outcome,order_id FROM order_sync_receipts WHERE request_id=$1',
            [r.data.request_id],
          )
        ).rows[0];
        assert.match(receipt.payload_hash, /^[0-9a-f]{64}$/);
        assert.equal(receipt.outcome, 'accepted');
        assert.equal(String(receipt.order_id), String(r.data.id));
      },
    );
    await t.test('concurrent retries cannot create duplicate orders', async () => {
      const body = checkout('card');
      const results = await Promise.all([
        request('/orders', json(body)),
        request('/orders', json(body)),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
      assert.equal(results[0].data.id, results[1].data.id);
      orderIds.push(results[0].data.id);
      const altered = { ...body, discount: 0.5 };
      const mismatch = await request('/orders', json(altered));
      assert.equal(mismatch.status, 409);
      assert.match(mismatch.data.error, /different order details/);
      assert.equal(
        Number(
          (await db.query('SELECT count(*) FROM orders WHERE request_id=$1', [body.request_id]))
            .rows[0].count,
        ),
        1,
      );
    });
    await t.test('manual KHQR and card payments save successfully', async () => {
      for (const method of ['khqr', 'card']) {
        const r = await request('/orders', json(checkout(method)));
        assert.equal(r.status, 201);
        orderIds.push(r.data.id);
        assert.equal(r.data.payment_method, method);
        assert.equal(r.data.cash_received, null);
      }
    });
    await t.test(
      'offline cash batches are durable, idempotent, authoritative, and reviewable',
      async () => {
        const offlineOrderCountBefore = Number(
          (await db.query("SELECT count(*) FROM orders WHERE source='offline'")).rows[0].count,
        );
        syncDeviceId = randomUUID();
        syncCredentialId = randomUUID();
        const deviceKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const devicePublicKey = deviceKey.publicKey.export({ type: 'spki', format: 'der' });
        await db.query('INSERT INTO pos_devices(id,name,enrolled_at) VALUES($1,$2,now())', [
          syncDeviceId,
          'Offline sync test till',
        ]);
        await db.query(
          `INSERT INTO pos_device_credentials(id,device_id,algorithm,public_key_spki,public_key_sha256)
         VALUES($1,$2,'ECDSA-P256-SHA256',$3,$4)`,
          [
            syncCredentialId,
            syncDeviceId,
            devicePublicKey.toString('base64'),
            createHash('sha256').update(devicePublicKey).digest('hex'),
          ],
        );
        const token = jwt.sign(
          {
            token_use: 'pos_device',
            credential_id: syncCredentialId,
            scope: ['catalog:read', 'lease:issue', 'orders:sync'],
          },
          process.env.JWT_SECRET,
          {
            subject: syncDeviceId,
            expiresIn: '15m',
            algorithm: 'HS256',
            audience: 'cafe-pos-device',
          },
        );
        assert.equal(
          (await request('/reports/summary', { headers: { Authorization: `Bearer ${token}` } }, ''))
            .status,
          401,
          'order-sync credentials do not grant admin report access',
        );
        assert.equal(
          (
            await request(
              '/orders',
              { ...json({}), headers: { Authorization: `Bearer ${token}` } },
              '',
            )
          ).status,
          401,
          'order-sync credentials do not grant cashier checkout access',
        );
        const signingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const signingPublicKey = signingKey.publicKey.export({ type: 'spki', format: 'der' });
        const signingPublicHash = createHash('sha256').update(signingPublicKey).digest('hex');
        const { rows: snapshots } = await db.query(
          'SELECT version,snapshot,created_at FROM catalog_snapshots ORDER BY version DESC LIMIT 1',
        );
        const version = String(snapshots[0].version);
        const catalog = projectPublicCatalog(
          snapshots[0].snapshot,
          version,
          snapshots[0].created_at,
        );
        const catalogText = stableJson(catalog);
        const catalogDigest = createHash('sha256').update(catalogText).digest('hex');
        const catalogKeyId = (syncCatalogKeyId = `api-test-${randomUUID()}`);
        const catalogSignature = sign(
          'sha256',
          signatureInput('catalog', catalogKeyId, catalogDigest, catalogText),
          { key: signingKey.privateKey, dsaEncoding: 'ieee-p1363' },
        ).toString('base64');
        await db.query(
          `INSERT INTO catalog_snapshot_signatures
           (version,key_id,public_key_sha256,payload_text,payload_sha256,signature)
         VALUES($1,$2,$3,$4,$5,$6)`,
          [version, catalogKeyId, signingPublicHash, catalogText, catalogDigest, catalogSignature],
        );
        const issueLease = async ({
          catalogVersion = version,
          capabilities = ['catalog:read', 'orders:cash:offline'],
          expired = false,
        } = {}) => {
          const leaseId = randomUUID();
          const issuedAt = new Date(Date.now() - (expired ? 25 * 60 * 60_000 : 60_000));
          const expiresAt = new Date(Date.now() + (expired ? -60_000 : 24 * 60 * 60_000));
          const payload = {
            schema_version: 1,
            lease_id: leaseId,
            device_id: syncDeviceId,
            credential_id: syncCredentialId,
            catalog_version: String(catalogVersion),
            issued_at: issuedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            capabilities,
          };
          const payloadText = stableJson(payload);
          const payloadDigest = createHash('sha256').update(payloadText).digest('hex');
          const signature = sign(
            'sha256',
            signatureInput('lease', catalogKeyId, payloadDigest, payloadText),
            { key: signingKey.privateKey, dsaEncoding: 'ieee-p1363' },
          ).toString('base64');
          await db.query(
            `INSERT INTO pos_offline_leases
             (id,device_id,credential_id,catalog_version,key_id,capabilities,payload_text,
              payload_sha256,signature,issued_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
            [
              leaseId,
              syncDeviceId,
              syncCredentialId,
              catalogVersion,
              catalogKeyId,
              JSON.stringify(capabilities),
              payloadText,
              payloadDigest,
              signature,
              issuedAt.toISOString(),
              expiresAt.toISOString(),
            ],
          );
          return leaseId;
        };
        const activeLeaseId = await issueLease();
        const oldLeaseId = await issueLease({ catalogVersion: '0' });
        const expiredLeaseId = await issueLease({ expired: true });
        const catalogOnlyLeaseId = await issueLease({ capabilities: ['catalog:read'] });
        const product = catalog.products.find((item) => item.id === productId);
        assert.ok(product, 'test product is present in the signed catalog');
        const makeSale = (sequence, overrides = {}) => {
          const quantity = 2;
          const subtotal = Math.round(product.price * 100) * quantity;
          const tax = Math.round((subtotal * Number(catalog.settings.tax_percentage)) / 100);
          const total = subtotal + tax;
          return {
            request_id: randomUUID(),
            device_id: syncDeviceId,
            lease_id: activeLeaseId,
            device_sequence: sequence,
            catalog_version: version,
            catalog_digest: catalogDigest,
            catalog_key_id: catalogKeyId,
            catalog_signature: catalogSignature,
            client_created_at: new Date().toISOString(),
            currency: catalog.settings.currency,
            items: [
              {
                product_id: product.id,
                name: product.name,
                category: product.category,
                image_url: product.image_url,
                quantity,
                unit_price: product.price,
                subtotal: subtotal / 100,
              },
            ],
            subtotal: subtotal / 100,
            discount: 0,
            tax_percentage: Number(catalog.settings.tax_percentage),
            tax: tax / 100,
            expected_total: total / 100,
            cash_received: (total + 500) / 100,
            change_amount: 5,
            ...overrides,
          };
        };
        const sync = (orders) =>
          request(
            '/pos/orders/sync',
            { ...json({ orders }), headers: { Authorization: `Bearer ${token}` } },
            '',
          );

        const firstSale = makeSale(1);
        const first = await sync([firstSale]);
        assert.equal(first.status, 200, JSON.stringify(first.data));
        assert.equal(first.data.results[0].state, 'synced');
        assert.equal(first.data.results[0].durable, true);
        orderIds.push(first.data.results[0].order_id);
        const finalized = await db.query(
          `SELECT source,cashier_id,device_id,device_sequence,total FROM orders WHERE request_id=$1`,
          [firstSale.request_id],
        );
        assert.equal(finalized.rows[0].source, 'offline');
        assert.equal(finalized.rows[0].cashier_id, null);
        assert.equal(finalized.rows[0].device_id, syncDeviceId);
        assert.equal(Number(finalized.rows[0].total), firstSale.expected_total);
        assert.equal(
          (
            await db.query('SELECT method FROM payments WHERE order_id=$1', [
              first.data.results[0].order_id,
            ])
          ).rows[0].method,
          'cash',
        );
        offlineOrderIds.push(first.data.results[0].order_id);
        const retry = await sync([firstSale]);
        assert.deepEqual(retry.data.results[0], first.data.results[0]);
        const altered = {
          ...firstSale,
          cash_received: firstSale.cash_received + 1,
          change_amount: firstSale.change_amount + 1,
        };
        const mismatch = await sync([altered]);
        assert.equal(mismatch.data.results[0].state, 'needs_review');
        assert.equal(mismatch.data.results[0].code, 'idempotency_conflict');
        assert.equal(
          Number(
            (
              await db.query('SELECT count(*) FROM orders WHERE request_id=$1', [
                firstSale.request_id,
              ])
            ).rows[0].count,
          ),
          1,
        );

        const secondSale = makeSale(2);
        const badCash = makeSale(3);
        badCash.cash_received = 0;
        badCash.change_amount = 0;
        const partial = await sync([secondSale, badCash]);
        assert.deepEqual(
          partial.data.results.map((result) => result.state),
          ['synced', 'rejected'],
        );
        orderIds.push(partial.data.results[0].order_id);
        offlineOrderIds.push(partial.data.results[0].order_id);

        const expiredSale = makeSale(4, { lease_id: expiredLeaseId });
        const expired = await sync([expiredSale]);
        assert.equal(expired.data.results[0].state, 'needs_review');
        assert.equal(expired.data.results[0].code, 'lease_expired');
        const oldCatalogSale = makeSale(5, { catalog_version: '0', lease_id: oldLeaseId });
        const stale = await sync([oldCatalogSale]);
        assert.equal(stale.data.results[0].state, 'needs_review');
        assert.equal(stale.data.results[0].code, 'stale_catalog');
        const readOnlySale = makeSale(6, { lease_id: catalogOnlyLeaseId });
        const readOnly = await sync([readOnlySale]);
        assert.equal(readOnly.data.results[0].state, 'needs_review');
        assert.equal(readOnly.data.results[0].code, 'lease_not_authorized');

        const oldPrice = Number(
          (await db.query('SELECT price FROM products WHERE id=$1', [productId])).rows[0].price,
        );
        await db.query('UPDATE products SET price=$2 WHERE id=$1', [productId, oldPrice + 1]);
        const changedPrice = await sync([makeSale(7)]);
        assert.equal(changedPrice.data.results[0].state, 'needs_review');
        assert.equal(changedPrice.data.results[0].code, 'price_or_product_changed');
        await db.query('UPDATE products SET price=$2 WHERE id=$1', [productId, oldPrice]);
        await db.query('UPDATE products SET available=false WHERE id=$1', [productId]);
        const unavailable = await sync([makeSale(8)]);
        assert.equal(unavailable.data.results[0].state, 'needs_review');
        await db.query('UPDATE products SET available=true WHERE id=$1', [productId]);

        const badQuantity = makeSale(9);
        badQuantity.items[0].quantity = 0;
        const invalidQuantity = await sync([badQuantity]);
        assert.equal(invalidQuantity.data.results[0].state, 'rejected');
        const badTax = makeSale(10, {
          tax_percentage: Number(catalog.settings.tax_percentage) + 1,
        });
        const invalidTax = await sync([badTax]);
        assert.equal(invalidTax.data.results[0].state, 'rejected');
        const digitalPayment = makeSale(11, { payment_method: 'card' });
        const noDigital = await sync([digitalPayment]);
        assert.equal(noDigital.data.results[0].state, 'rejected');
        const badChange = makeSale(12, { change_amount: 4 });
        const invalidChange = await sync([badChange]);
        assert.equal(invalidChange.data.results[0].state, 'rejected');
        const sequenceGapSale = makeSale(14);
        const sequenceGap = await sync([sequenceGapSale]);
        assert.equal(sequenceGap.data.results[0].state, 'needs_review');
        assert.equal(sequenceGap.data.results[0].code, 'device_sequence_conflict');
        const nextExpected = await sync([makeSale(13)]);
        assert.equal(nextExpected.data.results[0].state, 'synced');
        orderIds.push(nextExpected.data.results[0].order_id);
        offlineOrderIds.push(nextExpected.data.results[0].order_id);
        const afterGap = await sync([makeSale(14)]);
        assert.equal(afterGap.data.results[0].state, 'synced');
        orderIds.push(afterGap.data.results[0].order_id);
        offlineOrderIds.push(afterGap.data.results[0].order_id);
        const invalidProduct = makeSale(15, {
          items: [
            {
              ...makeSale(15).items[0],
              product_id: 2_147_483_647,
            },
          ],
        });
        const invalidProductResult = await sync([invalidProduct]);
        assert.equal(invalidProductResult.data.results[0].state, 'rejected');
        const sequenceConflict = await sync([makeSale(1)]);
        assert.equal(sequenceConflict.data.results[0].state, 'needs_review');
        assert.equal(sequenceConflict.data.results[0].code, 'device_sequence_conflict');

        const report = (await request('/reports/summary')).data;
        assert.ok(report.offlineReview.some((item) => item.outcome === 'needs_review'));
        assert.ok(report.offlineReview.some((item) => item.outcome === 'rejected'));
        assert.equal(
          Number(
            (await db.query("SELECT count(*) FROM orders WHERE source='offline'")).rows[0].count,
          ) - offlineOrderCountBefore,
          offlineOrderIds.length,
          'only durably accepted offline orders are present in finalized order history',
        );
      },
    );
    await t.test('order history filters, details, and reports query database', async () => {
      const order = (await request(`/orders/${orderIds[0]}`)).data;
      const r = await request(`/orders?number=${order.order_number}&method=cash`);
      assert.equal(r.data.total, 1);
      assert.equal(r.data.orders[0].item_count, 2);
      assert.equal((await request('/orders?date=not-a-date')).status, 400);
      const report = (await request('/reports/summary')).data;
      assert.ok(report.metrics.find((m) => m.currency === 'USD').today_orders >= 4);
      assert.ok(report.best.some((p) => p.product_id === productId));
      assert.ok(report.payments.some((p) => p.method === 'khqr'));
    });
    await t.test(
      'editing product price and photo updates menu, preserving old receipts',
      async () => {
        const prior = (await request('/products')).data.find((p) => p.id === productId);
        const red = await sharp({
          create: { width: 70, height: 70, channels: 3, background: '#ab6245' },
        })
          .png()
          .toBuffer();
        const r = await request(`/products/${productId}`, {
          method: 'PUT',
          body: productForm('API Integration Latte', '4.00', red),
        });
        assert.equal(r.status, 200);
        assert.equal(Number(r.data.price), 4);
        assert.notEqual(r.data.image_url, prior.image_url);
        const snapshot = (
          await db.query('SELECT snapshot FROM catalog_snapshots ORDER BY version DESC LIMIT 1')
        ).rows[0].snapshot;
        assert.equal(
          Number(snapshot.products.find((product) => product.id === productId).price),
          4,
        );
        assert.equal(Number((await request(`/orders/${orderIds[0]}`)).data.items[0].unit_price), 3);
        assert.equal((await request('/orders', json(checkout()))).status, 409);
      },
    );
    await t.test('availability and deletion remove products without losing receipts', async () => {
      const f = productForm('API Integration Latte', '4');
      f.set('available', 'false');
      assert.equal(
        (await request(`/products/${productId}`, { method: 'PUT', body: f })).status,
        200,
      );
      assert.equal(
        (
          await request(
            '/orders',
            json({
              ...checkout(),
              items: [{ product_id: productId, quantity: 2, expected_price: 4 }],
              expected_total: 7.7,
            }),
          )
        ).status,
        409,
      );
      assert.equal((await request(`/products/${productId}`, { method: 'DELETE' })).status, 200);
      assert.ok(!(await request('/products')).data.some((p) => p.id === productId));
      const deletedSnapshot = (
        await db.query('SELECT snapshot FROM catalog_snapshots ORDER BY version DESC LIMIT 1')
      ).rows[0].snapshot;
      assert.ok(deletedSnapshot.products.find((product) => product.id === productId).deleted_at);
      assert.equal((await request(`/orders/${orderIds[0]}`)).status, 200);
    });
    await t.test('logout clears authentication cookie', async () => {
      const r = await request('/auth/logout', { method: 'POST' });
      assert.match(r.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    });
  } finally {
    if (orderIds.length) {
      await db.query('DELETE FROM order_sync_receipts WHERE order_id=ANY($1::bigint[])', [
        orderIds,
      ]);
      await db.query('DELETE FROM payments WHERE order_id=ANY($1::bigint[])', [orderIds]);
      await db.query('DELETE FROM order_items WHERE order_id=ANY($1::bigint[])', [orderIds]);
      await db.query('DELETE FROM orders WHERE id=ANY($1::bigint[])', [orderIds]);
    }
    if (syncDeviceId) {
      await db.query('DELETE FROM order_sync_receipts WHERE device_id=$1', [syncDeviceId]);
      await db.query('DELETE FROM pos_offline_leases WHERE device_id=$1', [syncDeviceId]);
      await db.query('DELETE FROM pos_device_credentials WHERE device_id=$1', [syncDeviceId]);
      await db.query('DELETE FROM pos_devices WHERE id=$1', [syncDeviceId]);
    }
    if (syncCatalogKeyId)
      await db.query('DELETE FROM catalog_snapshot_signatures WHERE key_id=$1', [syncCatalogKeyId]);
    if (productId) await db.query('DELETE FROM products WHERE id=$1', [productId]);
    if (deviceId) {
      await db.query('DELETE FROM pos_offline_leases WHERE device_id=$1', [deviceId]);
      await db.query('DELETE FROM pos_device_challenges WHERE device_id=$1', [deviceId]);
      await db.query('DELETE FROM pos_device_enrollment_codes WHERE device_id=$1', [deviceId]);
      await db.query('DELETE FROM pos_device_credentials WHERE device_id=$1', [deviceId]);
      await db.query('DELETE FROM pos_devices WHERE id=$1', [deviceId]);
    }
    if (oldSettings)
      await db.query(
        'UPDATE settings SET cafe_name=$1,address=$2,phone=$3,currency=$4,tax_percentage=$5,logo_url=$6,khqr_url=$7 WHERE id=1',
        [
          oldSettings.cafe_name,
          oldSettings.address,
          oldSettings.phone,
          oldSettings.currency,
          oldSettings.tax_percentage,
          oldSettings.logo_url,
          oldSettings.khqr_url,
        ],
      );
    const catalogDb = await db.connect();
    try {
      await catalogDb.query('BEGIN');
      await publishCatalogSnapshot(catalogDb);
      await catalogDb.query('COMMIT');
    } catch (error) {
      await catalogDb.query('ROLLBACK');
      throw error;
    } finally {
      catalogDb.release();
    }
    await db.end();
  }
});
