import { randomUUID } from 'node:crypto';
import { pool } from '../config/db.js';
import { catalogLeaseHours } from '../config/env.js';
import { HttpError } from '../utils/errors.js';
import { signPayload, stableJson, signedCatalog } from './catalog-signing.js';

export async function issueCatalogLease({ device, catalogVersion }, dbPool = pool) {
  if (!catalogLeaseHours)
    throw new HttpError(503, 'Catalog lease duration is not configured correctly.');
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    const active = (
      await db.query(
        `SELECT d.id FROM pos_devices d
         JOIN pos_device_credentials c ON c.device_id=d.id
         WHERE d.id=$1 AND d.revoked_at IS NULL AND c.id=$2 AND c.revoked_at IS NULL
         FOR SHARE OF d,c`,
        [device.id, device.credential_id],
      )
    ).rows[0];
    if (!active) throw new HttpError(401, 'POS device or credential is revoked.');
    const currentVersion = (
      await db.query('SELECT version FROM catalog_state WHERE id=1 FOR SHARE')
    ).rows[0]?.version;
    if (String(currentVersion) !== String(catalogVersion))
      throw new HttpError(
        409,
        'Catalog changed. Refresh and verify the latest catalog before requesting a lease.',
      );
    const catalog = await signedCatalog(db, catalogVersion);
    const id = randomUUID();
    const times = (
      await db.query(
        `SELECT now() AS issued_at, now()+($1::int * interval '1 hour') AS expires_at`,
        [catalogLeaseHours],
      )
    ).rows[0];
    const payload = {
      schema_version: 1,
      lease_id: id,
      device_id: device.id,
      credential_id: device.credential_id,
      catalog_version: catalog.version,
      issued_at: new Date(times.issued_at).toISOString(),
      expires_at: new Date(times.expires_at).toISOString(),
      capabilities: ['catalog:read', 'orders:cash:offline'],
    };
    const payloadText = stableJson(payload);
    const signature = await signPayload('lease', payloadText);
    await db.query(
      `INSERT INTO pos_offline_leases
         (id,device_id,credential_id,catalog_version,key_id,capabilities,payload_text,payload_sha256,signature,issued_at,expires_at)
       VALUES($1,$2,$3,$4,$5,'["catalog:read","orders:cash:offline"]'::jsonb,$6,$7,$8,$9,$10)`,
      [
        id,
        device.id,
        device.credential_id,
        catalog.version,
        signature.keyId,
        payloadText,
        signature.digest,
        signature.signature,
        times.issued_at,
        times.expires_at,
      ],
    );
    await db.query('COMMIT');
    return {
      type: 'lease',
      key_id: signature.keyId,
      digest: signature.digest,
      signature: signature.signature,
      payload_text: payloadText,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
