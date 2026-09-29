import { Router } from 'express';
import { pool } from '../config/db.js';
import { timezone } from '../config/env.js';
import { HttpError } from '../utils/errors.js';
import { createOnlineCheckout, getOrder } from '../services/checkout.js';
const router = Router();
router.get('/', async (req, res) => {
  const conditions = [];
  const values = [];
  const add = (sql, v) => {
    values.push(v);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (req.query.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date) || !Number.isFinite(Date.parse(req.query.date)))
      throw new HttpError(400, 'Choose a valid date.');
    values.push(timezone);
    add(`(o.created_at AT TIME ZONE $${values.length})::date=?::date`, req.query.date);
  }
  if (req.query.number)
    add('o.order_number ILIKE ?', `%${String(req.query.number).slice(0, 100)}%`);
  if (req.query.method) add('p.method=?', req.query.method);
  const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page) || 1));
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const base = `FROM orders o LEFT JOIN users u ON u.id=o.cashier_id LEFT JOIN pos_devices d ON d.id=o.device_id JOIN payments p ON p.order_id=o.id ${where}`;
  const count = (await pool.query(`SELECT count(*) ${base}`, values)).rows[0].count;
  const { rows } = await pool.query(
    `SELECT o.*,COALESCE(u.name,'Offline · ' || d.name,'Offline POS') AS cashier,p.method AS payment_method,p.status AS payment_status,(SELECT sum(quantity)::int FROM order_items WHERE order_id=o.id) AS item_count ${base} ORDER BY o.created_at DESC,o.id DESC LIMIT 25 OFFSET $${values.length + 1}`,
    [...values, (page - 1) * 25],
  );
  res.json({ orders: rows, total: Number(count), page, pages: Math.ceil(Number(count) / 25) });
});
router.get('/:id', async (req, res) => res.json(await getOrder(req.params.id)));
router.post('/', async (req, res) => {
  const result = await createOnlineCheckout(req.body, req.user);
  res.status(result.replayed ? 200 : 201).json(result.order);
});
export default router;
