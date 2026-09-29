import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../config/db.js';
import { orderSchema, cents, amount } from '../utils/validation.js';
import { HttpError } from '../utils/errors.js';

export async function getOrder(id, db = pool) {
  const { rows } = await db.query(
    `SELECT o.*,COALESCE(u.name,'Offline · ' || d.name,'Offline POS') AS cashier,
       p.method AS payment_method,p.status AS payment_status,p.cash_received,p.change_amount
     FROM orders o LEFT JOIN users u ON u.id=o.cashier_id
     LEFT JOIN pos_devices d ON d.id=o.device_id
     JOIN payments p ON p.order_id=o.id WHERE o.id=$1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Order not found.');
  rows[0].items = (
    await db.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [id])
  ).rows;
  return rows[0];
}

export function parseCheckoutInput(body) {
  const input = orderSchema.parse(body);
  if (new Set(input.items.map((item) => item.product_id)).size !== input.items.length)
    throw new HttpError(400, 'Combine duplicate products into one order line.');
  return input;
}

export function hashCheckoutPayload(input) {
  const canonical = {
    request_id: input.request_id,
    items: input.items.map((item) => [item.product_id, item.quantity, cents(item.expected_price)]),
    discount_cents: cents(input.discount),
    expected_total_cents: cents(input.expected_total),
    payment_method: input.payment_method,
    cash_received_cents: input.payment_method === 'cash' ? cents(input.cash_received) : null,
    confirmed: input.confirmed,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildOnlineLines(input, products) {
  return input.items.map((item) => {
    const product = products.find((candidate) => candidate.id === item.product_id);
    if (!product || !product.available || product.deleted_at)
      throw new HttpError(
        409,
        'An item is no longer available. Refresh the menu and review your order.',
      );
    if (cents(product.price) !== cents(item.expected_price))
      throw new HttpError(
        409,
        `${product.name}'s price has changed. Review the updated order before paying.`,
      );
    return { ...product, quantity: item.quantity, sum: cents(product.price) * item.quantity };
  });
}

export function calculateCheckoutTotals(input, lines, taxPercentage) {
  const subtotal = lines.reduce((sum, item) => sum + item.sum, 0);
  const discount = cents(input.discount);
  if (discount > subtotal) throw new HttpError(400, 'Discount cannot exceed the subtotal.');
  const tax = Math.round(((subtotal - discount) * Number(taxPercentage)) / 100);
  const total = subtotal - discount + tax;
  if (total > 10000000) throw new HttpError(400, 'Order total exceeds the supported limit.');
  if (cents(input.expected_total) !== total)
    throw new HttpError(
      409,
      'Order totals changed. Review the current prices and tax before paying.',
    );
  return { subtotal, discount, tax, total };
}

// Call inside the request-ID transaction lock. This is shared by online and future sync flows.
export async function findIdempotentOrder(db, { requestId, cashierId, fingerprint }) {
  const prior = (
    await db.query(
      'SELECT cashier_id,payload_hash,outcome,order_id FROM order_sync_receipts WHERE request_id=$1',
      [requestId],
    )
  ).rows[0];
  if (prior) {
    if (prior.cashier_id !== cashierId)
      throw new HttpError(409, 'Checkout reference already used.');
    if (prior.outcome !== 'accepted')
      throw new HttpError(409, 'Checkout reference is awaiting resolution.');
    if (prior.payload_hash !== null && prior.payload_hash !== fingerprint)
      throw new HttpError(409, 'Checkout reference was already used for different order details.');
    return { order: await getOrder(prior.order_id, db), replayed: true };
  }

  // Compatibility guard for legacy rows from the interval before a receipt was recorded.
  const legacy = (
    await db.query('SELECT id,cashier_id FROM orders WHERE request_id=$1', [requestId])
  ).rows[0];
  if (!legacy) return null;
  if (legacy.cashier_id !== cashierId) throw new HttpError(409, 'Checkout reference already used.');
  return { order: await getOrder(legacy.id, db), replayed: true };
}

export async function recordAcceptedCheckout(
  db,
  { input, cashierId, fingerprint, orderId, catalogVersion },
) {
  await db.query(
    `INSERT INTO order_sync_receipts(request_id,cashier_id,payload_hash,outcome,order_id,catalog_version,response)
     VALUES($1,$2,$3,'accepted',$4,$5,jsonb_build_object('order_id',$4::bigint::text))`,
    [input.request_id, cashierId, fingerprint, orderId, catalogVersion],
  );
}

export async function createOnlineCheckout(body, user) {
  const input = parseCheckoutInput(body);
  const fingerprint = hashCheckoutPayload(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // The stable request ID serializes concurrent retries before either can create an order.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.request_id]);
    const prior = await findIdempotentOrder(db, {
      requestId: input.request_id,
      cashierId: user.id,
      fingerprint,
    });
    if (prior) {
      await db.query('COMMIT');
      return prior;
    }

    const settings = (await db.query('SELECT * FROM settings WHERE id=1 FOR SHARE')).rows[0];
    const products = (
      await db.query('SELECT * FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE', [
        input.items.map((item) => item.product_id),
      ])
    ).rows;
    const lines = buildOnlineLines(input, products);
    const { subtotal, discount, tax, total } = calculateCheckoutTotals(
      input,
      lines,
      settings.tax_percentage,
    );
    if (
      input.payment_method === 'cash' &&
      (input.cash_received === undefined || cents(input.cash_received) < total)
    )
      throw new HttpError(400, 'Cash received must be at least the order total.');
    if (input.payment_method === 'khqr' && !settings.khqr_url)
      throw new HttpError(400, 'Ask the owner to upload a KHQR image in Settings first.');

    const catalogVersion = (await db.query('SELECT version FROM catalog_state WHERE id=1')).rows[0]
      .version;
    const orderNumber = `BB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const { rows } = await db.query(
      'INSERT INTO orders(order_number,request_id,cashier_id,subtotal,discount,tax,tax_percentage,total,currency,receipt_settings,catalog_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [
        orderNumber,
        input.request_id,
        user.id,
        amount(subtotal),
        amount(discount),
        amount(tax),
        settings.tax_percentage,
        amount(total),
        settings.currency,
        JSON.stringify(settings),
        catalogVersion,
      ],
    );
    const orderId = rows[0].id;
    for (const item of lines)
      await db.query(
        'INSERT INTO order_items(order_id,product_id,product_name,image_url,quantity,unit_price,subtotal) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [orderId, item.id, item.name, item.image_url, item.quantity, item.price, amount(item.sum)],
      );
    await db.query(
      'INSERT INTO payments(order_id,method,amount,cash_received,change_amount) VALUES($1,$2,$3,$4,$5)',
      [
        orderId,
        input.payment_method,
        amount(total),
        input.payment_method === 'cash' ? input.cash_received : null,
        input.payment_method === 'cash' ? amount(cents(input.cash_received) - total) : null,
      ],
    );
    await recordAcceptedCheckout(db, {
      input,
      cashierId: user.id,
      fingerprint,
      orderId,
      catalogVersion,
    });
    const saved = await getOrder(orderId, db);
    await db.query('COMMIT');
    return { order: saved, replayed: false };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
