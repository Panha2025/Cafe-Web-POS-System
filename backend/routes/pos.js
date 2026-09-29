import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { production } from '../config/env.js';
import { authenticateDevice, requireDeviceScope } from '../middleware/device-auth.js';
import { HttpError } from '../utils/errors.js';
import {
  authenticateDeviceChallenge,
  enrollDevice,
  issueDeviceChallenge,
  rotateDeviceCredential,
} from '../services/device-auth.js';
import { signedCatalog } from '../services/catalog-signing.js';
import { issueCatalogLease } from '../services/offline-leases.js';
import { syncOfflineCashBatch } from '../services/offline-order-sync.js';

const router = Router();
router.use((req, res, next) => {
  if (production && !req.secure)
    throw new HttpError(426, 'HTTPS is required for POS device authentication.');
  next();
});
const enrollLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const enrollmentSchema = z.object({
  pairing_code: z.string().min(60).max(120),
  credential_id: z.uuid(),
  public_key_spki: z.string().min(80).max(1000),
});
const challengeSchema = z.object({ device_id: z.uuid(), credential_id: z.uuid() });
const sessionSchema = z.object({
  device_id: z.uuid(),
  credential_id: z.uuid(),
  challenge: z.string().min(40).max(50),
  signature: z.string().min(80).max(100),
});
const rotationSchema = z.object({
  challenge: z.string().min(40).max(50),
  signature: z.string().min(80).max(100),
  new_credential_id: z.uuid(),
  new_public_key_spki: z.string().min(80).max(1000),
});
const leaseSchema = z.object({ catalog_version: z.string().regex(/^[0-9]{1,18}$/) });
const orderSyncBatchSchema = z.object({ orders: z.array(z.unknown()).min(1).max(10) }).strict();

router.post('/enroll', enrollLimiter, async (req, res) => {
  const input = enrollmentSchema.parse(req.body);
  res.status(201).json(
    await enrollDevice({
      pairingCode: input.pairing_code,
      credentialId: input.credential_id,
      publicKeySpki: input.public_key_spki,
    }),
  );
});

router.post('/challenge', authLimiter, async (req, res) => {
  const input = challengeSchema.parse(req.body);
  res.json(
    await issueDeviceChallenge({ deviceId: input.device_id, credentialId: input.credential_id }),
  );
});

router.post('/session', authLimiter, async (req, res) => {
  const input = sessionSchema.parse(req.body);
  res.json(
    await authenticateDeviceChallenge({
      deviceId: input.device_id,
      credentialId: input.credential_id,
      challenge: input.challenge,
      signature: input.signature,
    }),
  );
});

router.post(
  '/rotate-key',
  authenticateDevice,
  requireDeviceScope('lease:issue'),
  async (req, res) => {
    const input = rotationSchema.parse(req.body);
    res.json(
      await rotateDeviceCredential({
        deviceId: req.device.id,
        credentialId: req.device.credential_id,
        challenge: input.challenge,
        signature: input.signature,
        newCredentialId: input.new_credential_id,
        newPublicKeySpki: input.new_public_key_spki,
      }),
    );
  },
);

router.get('/bootstrap', authenticateDevice, async (req, res) => {
  const db = await pool.connect();
  try {
    const { rows } = await db.query(
      `SELECT s.version,s.updated_at,c.created_at,now() AS server_time
       FROM catalog_state s
       JOIN catalog_snapshots c ON c.version=s.version
       WHERE s.id=1`,
    );
    if (!rows[0]) throw new HttpError(503, 'No catalog snapshot is available yet.');
    const catalog = await signedCatalog(db, rows[0].version);
    res.json({
      server_time: new Date(rows[0].server_time).toISOString(),
      device: { id: req.device.id, name: req.device.name, credential_id: req.device.credential_id },
      catalog,
    });
  } finally {
    db.release();
  }
});

router.post('/lease', authenticateDevice, requireDeviceScope('lease:issue'), async (req, res) => {
  const input = leaseSchema.parse(req.body);
  const current = (await pool.query('SELECT version FROM catalog_state WHERE id=1')).rows[0];
  if (!current) throw new HttpError(503, 'Catalog version state is unavailable.');
  if (String(current.version) !== input.catalog_version)
    throw new HttpError(
      409,
      'Catalog changed. Refresh and verify the latest catalog before requesting a lease.',
    );
  res.status(201).json(
    await issueCatalogLease({
      device: { id: req.device.id, credential_id: req.device.credential_id },
      catalogVersion: current.version,
    }),
  );
});

router.post(
  '/orders/sync',
  authenticateDevice,
  requireDeviceScope('orders:sync'),
  async (req, res) => {
    const input = orderSyncBatchSchema.parse(req.body);
    res.json(await syncOfflineCashBatch(input.orders, req.device));
  },
);

export default router;
