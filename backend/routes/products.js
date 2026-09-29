import { Router } from 'express';
import { pool } from '../config/db.js';
import { admin } from '../middleware/auth.js';
import { upload, storeImage } from '../utils/storage.js';
import { productSchema } from '../utils/validation.js';
import { HttpError } from '../utils/errors.js';
import { publishCatalogSnapshot } from '../utils/catalog.js';

const router = Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name AS category FROM products p JOIN categories c ON c.id=p.category_id WHERE p.deleted_at IS NULL ${req.user.role === 'cashier' ? 'AND p.available=true' : ''} ORDER BY p.id`,
  );
  res.json(rows);
});

router.post('/', admin, upload.single('image'), async (req, res) => {
  const p = productSchema.parse(req.body);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (!(await db.query('SELECT id FROM categories WHERE id=$1', [p.category_id])).rowCount)
      throw new HttpError(400, 'Choose a valid category.');
    const image = await storeImage(req.file);
    const { rows } = await db.query(
      'INSERT INTO products(name,price,category_id,available,image_url) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [p.name, p.price, p.category_id, p.available, image || '/images/coffee.svg'],
    );
    await publishCatalogSnapshot(db);
    await db.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
});

router.put('/:id', admin, upload.single('image'), async (req, res) => {
  const p = productSchema.parse(req.body);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (
      !(
        await db.query('SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
          req.params.id,
        ])
      ).rowCount
    )
      throw new HttpError(404, 'Product not found.');
    if (!(await db.query('SELECT id FROM categories WHERE id=$1', [p.category_id])).rowCount)
      throw new HttpError(400, 'Choose a valid category.');
    const image = await storeImage(req.file);
    const { rows } = await db.query(
      'UPDATE products SET name=$1,price=$2,category_id=$3,available=$4,image_url=COALESCE($5,image_url),updated_at=now() WHERE id=$6 AND deleted_at IS NULL RETURNING *',
      [p.name, p.price, p.category_id, p.available, image, req.params.id],
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
});

router.delete('/:id', admin, async (req, res) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await db.query(
      'UPDATE products SET deleted_at=now(),available=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id',
      [req.params.id],
    );
    if (!result.rowCount) throw new HttpError(404, 'Product not found.');
    await publishCatalogSnapshot(db);
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
});

export default router;
