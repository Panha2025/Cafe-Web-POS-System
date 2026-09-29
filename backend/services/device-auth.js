import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { HttpError } from '../utils/errors.js';

const pairingCodeLifetimeMinutes = 15;
const challengeLifetimeSeconds = 90;

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function requireUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new HttpError(400, `${label} is invalid.`);
  return value;
}

export function parseDevicePublicKey(publicKeySpki) {
  if (typeof publicKeySpki !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeySpki))
    throw new HttpError(400, 'Device public key is invalid.');
  const der = Buffer.from(publicKeySpki, 'base64');
  if (!der.length || der.toString('base64') !== publicKeySpki)
    throw new HttpError(400, 'Device public key is invalid.');
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error('Unsupported public key.');
    return { key, publicKeySpki, publicKeySha256: sha256(der) };
  } catch {
    throw new HttpError(400, 'Device public key must be an ECDSA P-256 SPKI key.');
  }
}

function verifyDeviceSignature(publicKeySpki, message, signatureBase64) {
  if (typeof signatureBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64))
    return false;
  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== signatureBase64) return false;
  try {
    const { key } = parseDevicePublicKey(publicKeySpki);
    return verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    return false;
  }
}

export const authenticationMessage = (deviceId, credentialId, challenge) =>
  `pos-device-auth-v1\n${deviceId}\n${credentialId}\n${challenge}`;

export const rotationMessage = (deviceId, credentialId, challenge, newPublicKeySha256) =>
  `pos-device-key-rotation-v1\n${deviceId}\n${credentialId}\n${challenge}\n${newPublicKeySha256}`;

export async function createPairingCode(db, deviceId, createdBy) {
  const code = `${deviceId}.${randomBytes(32).toString('base64url')}`;
  const codeHash = sha256(code);
  await db.query(
    `UPDATE pos_device_enrollment_codes SET consumed_at=now()
     WHERE device_id=$1 AND consumed_at IS NULL`,
    [deviceId],
  );
  const { rows } = await db.query(
    `INSERT INTO pos_device_enrollment_codes(device_id,code_hash,created_by,expires_at)
     VALUES($1,$2,$3,now()+($4::int * interval '1 minute'))
     RETURNING expires_at`,
    [deviceId, codeHash, createdBy, pairingCodeLifetimeMinutes],
  );
  return { pairing_code: code, expires_at: rows[0].expires_at };
}

export async function enrollDevice({ pairingCode, credentialId, publicKeySpki }, dbPool = pool) {
  const [deviceId, secret] = String(pairingCode || '').split('.');
  requireUuid(deviceId, 'Pairing code');
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(secret || ''))
    throw new HttpError(400, 'Pairing code is invalid.');
  credentialId = requireUuid(credentialId, 'Credential ID');
  const parsedKey = parseDevicePublicKey(publicKeySpki);
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    const enrollment = (
      await db.query(
        `SELECT *,expires_at>now() AS valid
         FROM pos_device_enrollment_codes
         WHERE device_id=$1 AND code_hash=$2 FOR UPDATE`,
        [deviceId, sha256(pairingCode)],
      )
    ).rows[0];
    if (!enrollment || enrollment.consumed_at)
      throw new HttpError(401, 'Pairing code is invalid or has already been used.');
    if (!enrollment.valid)
      throw new HttpError(410, 'Pairing code has expired. Ask an administrator for a new code.');
    const device = (
      await db.query('SELECT id,revoked_at FROM pos_devices WHERE id=$1 FOR UPDATE', [deviceId])
    ).rows[0];
    if (!device || device.revoked_at) throw new HttpError(403, 'POS device is revoked.');
    if (
      (await db.query('SELECT id FROM pos_device_credentials WHERE id=$1', [credentialId])).rowCount
    )
      throw new HttpError(409, 'Credential ID is already in use.');
    const previous = (
      await db.query(
        'SELECT id FROM pos_device_credentials WHERE device_id=$1 AND revoked_at IS NULL FOR UPDATE',
        [deviceId],
      )
    ).rows[0];
    if (previous)
      await db.query('UPDATE pos_device_credentials SET revoked_at=now() WHERE id=$1', [
        previous.id,
      ]);
    await db.query(
      `INSERT INTO pos_device_credentials(id,device_id,algorithm,public_key_spki,public_key_sha256,rotated_from)
       VALUES($1,$2,'ECDSA-P256-SHA256',$3,$4,$5)`,
      [
        credentialId,
        deviceId,
        parsedKey.publicKeySpki,
        parsedKey.publicKeySha256,
        previous?.id || null,
      ],
    );
    await db.query('UPDATE pos_device_enrollment_codes SET consumed_at=now() WHERE id=$1', [
      enrollment.id,
    ]);
    await db.query('UPDATE pos_devices SET enrolled_at=now() WHERE id=$1', [deviceId]);
    await db.query('COMMIT');
    return { device_id: deviceId, credential_id: credentialId, algorithm: 'ECDSA-P256-SHA256' };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function issueDeviceChallenge({ deviceId, credentialId }, dbPool = pool) {
  requireUuid(deviceId, 'Device ID');
  requireUuid(credentialId, 'Credential ID');
  const db = await dbPool.connect();
  try {
    const { rows } = await db.query(
      `SELECT d.id FROM pos_devices d
       JOIN pos_device_credentials c ON c.device_id=d.id
       WHERE d.id=$1 AND d.revoked_at IS NULL AND c.id=$2 AND c.revoked_at IS NULL`,
      [deviceId, credentialId],
    );
    if (!rows[0]) throw new HttpError(401, 'POS device or credential is not active.');
    const challenge = randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO pos_device_challenges(challenge_hash,device_id,credential_id,expires_at)
       VALUES($1,$2,$3,now()+($4::int * interval '1 second'))`,
      [sha256(challenge), deviceId, credentialId, challengeLifetimeSeconds],
    );
    return {
      challenge,
      expires_in_seconds: challengeLifetimeSeconds,
      server_time: new Date().toISOString(),
    };
  } finally {
    db.release();
  }
}

async function consumeChallenge(db, { deviceId, credentialId, challenge, signature, message }) {
  const challengeHash = sha256(challenge);
  const row = (
    await db.query(
      `SELECT c.challenge_hash,c.expires_at,c.expires_at>now() AS valid,c.consumed_at,d.revoked_at AS device_revoked,
              k.public_key_spki,k.revoked_at AS credential_revoked
       FROM pos_device_challenges c
       JOIN pos_devices d ON d.id=c.device_id
       JOIN pos_device_credentials k ON k.id=c.credential_id AND k.device_id=d.id
       WHERE c.challenge_hash=$1 AND c.device_id=$2 AND c.credential_id=$3 FOR UPDATE OF c,d,k`,
      [challengeHash, deviceId, credentialId],
    )
  ).rows[0];
  if (!row || row.consumed_at)
    throw new HttpError(409, 'Device challenge is invalid or has already been used.');
  if (!row.valid) throw new HttpError(410, 'Device challenge has expired.');
  if (row.device_revoked || row.credential_revoked)
    throw new HttpError(403, 'POS device or credential is revoked.');
  if (!verifyDeviceSignature(row.public_key_spki, message, signature))
    throw new HttpError(401, 'Device signature is invalid.');
  await db.query('UPDATE pos_device_challenges SET consumed_at=now() WHERE challenge_hash=$1', [
    challengeHash,
  ]);
  await db.query('UPDATE pos_devices SET last_seen_at=now() WHERE id=$1', [deviceId]);
  await db.query('UPDATE pos_device_credentials SET last_used_at=now() WHERE id=$1', [
    credentialId,
  ]);
}

export async function authenticateDeviceChallenge(
  { deviceId, credentialId, challenge, signature },
  dbPool = pool,
) {
  requireUuid(deviceId, 'Device ID');
  requireUuid(credentialId, 'Credential ID');
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(challenge))
    throw new HttpError(400, 'Device challenge is invalid.');
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    await consumeChallenge(db, {
      deviceId,
      credentialId,
      challenge,
      signature,
      message: authenticationMessage(deviceId, credentialId, challenge),
    });
    const token = jwt.sign(
      {
        token_use: 'pos_device',
        credential_id: credentialId,
        scope: ['catalog:read', 'lease:issue', 'orders:sync'],
      },
      process.env.JWT_SECRET,
      { subject: deviceId, expiresIn: '15m', algorithm: 'HS256', audience: 'cafe-pos-device' },
    );
    await db.query('COMMIT');
    return { access_token: token, token_type: 'Bearer', expires_in_seconds: 900 };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function rotateDeviceCredential(
  { deviceId, credentialId, challenge, signature, newCredentialId, newPublicKeySpki },
  dbPool = pool,
) {
  requireUuid(deviceId, 'Device ID');
  requireUuid(credentialId, 'Credential ID');
  newCredentialId = requireUuid(newCredentialId, 'New credential ID');
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(challenge))
    throw new HttpError(400, 'Device challenge is invalid.');
  const newKey = parseDevicePublicKey(newPublicKeySpki);
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    await consumeChallenge(db, {
      deviceId,
      credentialId,
      challenge,
      signature,
      message: rotationMessage(deviceId, credentialId, challenge, newKey.publicKeySha256),
    });
    await db.query('UPDATE pos_device_credentials SET revoked_at=now() WHERE id=$1', [
      credentialId,
    ]);
    await db.query(
      `INSERT INTO pos_device_credentials(id,device_id,algorithm,public_key_spki,public_key_sha256,rotated_from)
       VALUES($1,$2,'ECDSA-P256-SHA256',$3,$4,$5)`,
      [newCredentialId, deviceId, newKey.publicKeySpki, newKey.publicKeySha256, credentialId],
    );
    await db.query(
      'UPDATE pos_offline_leases SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL',
      [deviceId],
    );
    await db.query('COMMIT');
    return { device_id: deviceId, credential_id: newCredentialId, algorithm: 'ECDSA-P256-SHA256' };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function revokeDevice(deviceId, dbPool = pool) {
  requireUuid(deviceId, 'Device ID');
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `UPDATE pos_devices SET revoked_at=COALESCE(revoked_at,now())
       WHERE id=$1 RETURNING id,name,created_at,last_seen_at,revoked_at,enrolled_at`,
      [deviceId],
    );
    if (!rows[0]) throw new HttpError(404, 'POS device not found.');
    await db.query(
      'UPDATE pos_device_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1',
      [deviceId],
    );
    await db.query(
      'UPDATE pos_device_enrollment_codes SET consumed_at=COALESCE(consumed_at,now()) WHERE device_id=$1',
      [deviceId],
    );
    await db.query(
      'UPDATE pos_device_challenges SET consumed_at=COALESCE(consumed_at,now()) WHERE device_id=$1',
      [deviceId],
    );
    await db.query(
      'UPDATE pos_offline_leases SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1',
      [deviceId],
    );
    await db.query('COMMIT');
    return rows[0];
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export const newCredentialId = () => randomUUID();
