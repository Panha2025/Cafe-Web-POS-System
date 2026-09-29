import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { HttpError } from '../utils/errors.js';
import { createPairingCode, revokeDevice } from '../services/device-auth.js';

const router = Router();
const deviceName = z.object({ name: z.string().trim().min(1).max(100) });
const idParam = z.object({ id: z.uuid() });

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id,d.name,d.created_at,d.last_seen_at,d.revoked_at,d.enrolled_at,
       CASE WHEN d.revoked_at IS NOT NULL THEN 'revoked'
            WHEN c.id IS NOT NULL THEN 'active' ELSE 'unregistered' END AS status,
       c.id AS credential_id,c.created_at AS credential_created_at,c.last_used_at
     FROM pos_devices d
     LEFT JOIN pos_device_credentials c ON c.device_id=d.id AND c.revoked_at IS NULL
     ORDER BY d.created_at DESC,d.id`,
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name } = deviceName.parse(req.body);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      'INSERT INTO pos_devices(name) VALUES($1) RETURNING id,name,created_at,last_seen_at,revoked_at,enrolled_at',
      [name],
    );
    const pairing = await createPairingCode(db, rows[0].id, req.user.id);
    await db.query('COMMIT');
    res.status(201).json({ ...rows[0], status: 'unregistered', ...pairing });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
});

router.post('/:id/pairing-codes', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const device = (
      await db.query('SELECT id,revoked_at FROM pos_devices WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (!device) throw new HttpError(404, 'POS device not found.');
    if (device.revoked_at) throw new HttpError(409, 'A revoked POS device cannot be enrolled.');
    const pairing = await createPairingCode(db, id, req.user.id);
    await db.query('COMMIT');
    res.status(201).json({ device_id: id, ...pairing });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await revokeDevice(id));
});

export default router;
