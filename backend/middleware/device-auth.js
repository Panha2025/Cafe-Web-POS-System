import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { HttpError } from '../utils/errors.js';

export async function authenticateDevice(req, res, next) {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get('authorization') || '');
  let payload;
  try {
    if (!match) throw new Error('Missing device token.');
    payload = jwt.verify(match[1], process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      audience: 'cafe-pos-device',
    });
  } catch {
    throw new HttpError(401, 'A valid POS device token is required.');
  }
  if (
    payload.token_use !== 'pos_device' ||
    !Array.isArray(payload.scope) ||
    !payload.scope.includes('catalog:read') ||
    typeof payload.credential_id !== 'string'
  )
    throw new HttpError(403, 'POS device token does not have the required scope.');
  const { rows } = await pool.query(
    `SELECT d.id,d.name,d.revoked_at,c.id AS credential_id
     FROM pos_devices d
     JOIN pos_device_credentials c ON c.device_id=d.id
     WHERE d.id=$1 AND d.revoked_at IS NULL AND c.id=$2 AND c.revoked_at IS NULL`,
    [payload.sub, payload.credential_id],
  );
  if (!rows[0]) throw new HttpError(401, 'POS device or credential is revoked.');
  req.device = { ...rows[0], scopes: payload.scope };
  next();
}

export function requireDeviceScope(scope) {
  return (req, res, next) => {
    if (!req.device?.scopes?.includes(scope))
      throw new HttpError(403, 'POS device token does not have the required scope.');
    next();
  };
}
