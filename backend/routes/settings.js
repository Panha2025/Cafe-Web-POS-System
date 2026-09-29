import { Router } from 'express';
import { pool } from '../config/db.js';
import { admin } from '../middleware/auth.js';
import { upload, storeImage } from '../utils/storage.js';
import { settingsSchema } from '../utils/validation.js';
import { publishCatalogSnapshot } from '../utils/catalog.js';

const router = Router();

router.get('/', async (req, res) =>
  res.json((await pool.query('SELECT * FROM settings WHERE id=1')).rows[0]),
);

router.put(
  '/',
  admin,
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'khqr', maxCount: 1 },
  ]),
  async (req, res) => {
    const s = settingsSchema.parse(req.body);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM settings WHERE id=1 FOR UPDATE');
      const logo = await storeImage(req.files?.logo?.[0]);
      const khqr = await storeImage(req.files?.khqr?.[0]);
      const { rows } = await db.query(
        'UPDATE settings SET cafe_name=$1,address=$2,phone=$3,currency=$4,tax_percentage=$5,logo_url=COALESCE($6,logo_url),khqr_url=COALESCE($7,khqr_url),updated_at=now() WHERE id=1 RETURNING *',
        [s.cafe_name, s.address, s.phone, s.currency, s.tax_percentage, logo, khqr],
      );
      await publishCatalogSnapshot(db);
      await db.query('COMMIT');
      res.json(rows[0]);
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  },
);

export default router;
