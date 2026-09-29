import { Router } from 'express';
import { pool } from '../config/db.js';
import { timezone } from '../config/env.js';
const router = Router();
router.get('/summary', async (req, res) => {
  const metrics = (
    await pool.query(
      `SELECT currency,
    COALESCE(sum(total) FILTER(WHERE (created_at AT TIME ZONE $1)::date=(now() AT TIME ZONE $1)::date),0) AS today_revenue,
    count(*) FILTER(WHERE (created_at AT TIME ZONE $1)::date=(now() AT TIME ZONE $1)::date)::int AS today_orders,
    COALESCE(sum(total) FILTER(WHERE date_trunc('month',created_at AT TIME ZONE $1)=date_trunc('month',now() AT TIME ZONE $1)),0) AS month_revenue,
    COALESCE(avg(total),0) AS average_order_value, count(*)::int AS total_orders FROM orders GROUP BY currency`,
      [timezone],
    )
  ).rows;
  const best = (
    await pool.query(
      `SELECT i.product_id,i.product_name,sum(i.quantity)::int AS quantity,sum(i.subtotal) AS revenue,o.currency FROM order_items i JOIN orders o ON o.id=i.order_id GROUP BY i.product_id,i.product_name,o.currency ORDER BY quantity DESC LIMIT 6`,
    )
  ).rows;
  const payments = (
    await pool.query(
      'SELECT p.method,o.currency,count(*)::int AS orders,sum(p.amount) AS revenue FROM payments p JOIN orders o ON o.id=p.order_id GROUP BY p.method,o.currency ORDER BY revenue DESC',
    )
  ).rows;
  const daily = (
    await pool.query(
      `SELECT (created_at AT TIME ZONE $1)::date::text AS day,currency,sum(total) AS revenue,count(*)::int AS orders FROM orders WHERE (created_at AT TIME ZONE $1)::date >= (now() AT TIME ZONE $1)::date-6 GROUP BY day,currency ORDER BY day`,
      [timezone],
    )
  ).rows;
  const recent = (
    await pool.query(
      `SELECT o.*,COALESCE(u.name,'Offline · ' || d.name,'Offline POS') AS cashier,
        p.method AS payment_method FROM orders o LEFT JOIN users u ON u.id=o.cashier_id
        LEFT JOIN pos_devices d ON d.id=o.device_id JOIN payments p ON p.order_id=o.id
       ORDER BY o.created_at DESC LIMIT 6`,
    )
  ).rows;
  const offlineReview = (
    await pool.query(
      `SELECT r.request_id,r.outcome,r.created_at,d.name AS device_name,
         r.device_sequence,r.response->'offline_order'->>'expected_total' AS recorded_total,
         r.response->'offline_order'->>'currency' AS currency
       FROM order_sync_receipts r LEFT JOIN pos_devices d ON d.id=r.device_id
       WHERE r.outcome IN ('needs_review','rejected') AND r.device_id IS NOT NULL
       ORDER BY r.created_at DESC LIMIT 100`,
    )
  ).rows;
  res.json({ metrics, best, payments, daily, recent, offlineReview, timezone });
});
export default router;
