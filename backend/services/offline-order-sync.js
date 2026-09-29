import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { getOrder } from './checkout.js';
import { amount, cents } from '../utils/validation.js';
import { stableJson } from './catalog-signing.js';

const moneyValue = z
  .number()
  .finite()
  .min(0)
  .max(100000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001);
const offlineOrderSchema = z
  .object({
    request_id: z.uuid(),
    device_id: z.uuid(),
    lease_id: z.uuid(),
    device_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    catalog_version: z.string().regex(/^\d{1,18}$/),
    catalog_digest: z.string().regex(/^[0-9a-f]{64}$/),
    catalog_key_id: z.string().min(1).max(100),
    catalog_signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    client_created_at: z.iso.datetime({ offset: true }),
    currency: z.enum(['USD', 'KHR', 'EUR', 'GBP', 'THB']),
    items: z
      .array(
        z
          .object({
            product_id: z.number().int().positive().max(2_147_483_647),
            name: z.string().min(1).max(120),
            category: z.string().max(80),
            image_url: z.string().max(1000),
            quantity: z.number().int().min(1).max(999),
            unit_price: moneyValue,
            subtotal: moneyValue,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    subtotal: moneyValue,
    discount: moneyValue,
    tax_percentage: z.number().finite().min(0).max(100),
    tax: moneyValue,
    expected_total: moneyValue,
    cash_received: moneyValue,
    change_amount: moneyValue,
  })
  .strict();

const knownCurrencies = new Set(['USD', 'KHR', 'EUR', 'GBP', 'THB']);
const digest = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
const validRequestId = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function priorResult(row, fingerprint, deviceId) {
  if (row.device_id !== deviceId || row.payload_hash !== fingerprint)
    return {
      request_id: row.request_id,
      state: 'needs_review',
      code: 'idempotency_conflict',
      message: 'This sale reference was already used with different details.',
      durable: false,
    };
  return row.response;
}

async function saveTerminalResult(
  db,
  { requestId, deviceId, sequence, catalogVersion, fingerprint, state, code, message, raw },
) {
  const outcome = state === 'needs_review' ? 'needs_review' : 'rejected';
  const response = {
    request_id: requestId,
    state,
    code,
    message,
    offline_order: raw,
    durable: true,
  };
  await db.query(
    `INSERT INTO order_sync_receipts
       (request_id,cashier_id,payload_hash,outcome,device_id,device_sequence,catalog_version,response)
     VALUES($1,NULL,$2,$3,$4,$5,$6,$7::jsonb)`,
    [requestId, fingerprint, outcome, deviceId, sequence, catalogVersion, JSON.stringify(response)],
  );
  return response;
}

async function recordIssue(
  db,
  context,
  state,
  code,
  message,
  sequence = null,
  catalogVersion = null,
) {
  const result = await saveTerminalResult(db, {
    ...context,
    sequence,
    catalogVersion,
    state,
    code,
    message,
  });
  await db.query('COMMIT');
  return result;
}

function sameMoney(a, b) {
  return cents(a) === cents(b);
}

function canonicalResponse(order, requestId) {
  return {
    request_id: requestId,
    state: 'synced',
    order_id: String(order.id),
    order_number: order.order_number,
    server_created_at: order.created_at,
    total: order.total,
    currency: order.currency,
    source: 'offline',
    durable: true,
  };
}

export async function processOfflineCashOrder(raw, device, dbPool = pool) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !validRequestId(raw.request_id))
    return {
      request_id: null,
      state: 'rejected',
      code: 'invalid_request_id',
      message: 'The saved sale reference is invalid.',
      durable: false,
    };

  const fingerprint = digest(raw);
  const requestId = raw.request_id;
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [requestId]);
    const previous = (
      await db.query(
        'SELECT request_id,device_id,payload_hash,response FROM order_sync_receipts WHERE request_id=$1',
        [requestId],
      )
    ).rows[0];
    if (previous) {
      const response = priorResult(previous, fingerprint, device.id);
      await db.query('COMMIT');
      return response;
    }

    const context = { requestId, deviceId: device.id, fingerprint, raw };
    if (raw.device_id !== device.id)
      return await recordIssue(
        db,
        context,
        'rejected',
        'device_mismatch',
        'The sale belongs to a different POS device.',
      );

    const lockedDevice = (
      await db.query(
        'SELECT id,last_order_sequence FROM pos_devices WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',
        [device.id],
      )
    ).rows[0];
    if (!lockedDevice)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'device_unavailable',
        'This POS device is no longer active. The sale needs administrator review.',
      );

    const requestedSequence = raw.device_sequence;
    const validSequence = Number.isSafeInteger(requestedSequence) && requestedSequence > 0;
    if (!validSequence) {
      const invalid = offlineOrderSchema.safeParse(raw);
      return await recordIssue(
        db,
        context,
        invalid.success ? 'needs_review' : 'rejected',
        'invalid_device_sequence',
        'The device sale sequence is invalid. Keep this receipt for review.',
      );
    }
    const duplicateSequence = (
      await db.query(
        'SELECT request_id FROM order_sync_receipts WHERE device_id=$1 AND device_sequence=$2',
        [device.id, requestedSequence],
      )
    ).rows[0];
    if (
      duplicateSequence ||
      BigInt(requestedSequence) !== BigInt(lockedDevice.last_order_sequence) + 1n
    )
      return await recordIssue(
        db,
        context,
        'needs_review',
        'device_sequence_conflict',
        'The device sale sequence is out of order. Keep this receipt for review.',
      );
    const sequence = requestedSequence;
    await db.query('UPDATE pos_devices SET last_order_sequence=$2 WHERE id=$1', [
      device.id,
      sequence,
    ]);
    const parsed = offlineOrderSchema.safeParse(raw);
    if (!parsed.success)
      return await recordIssue(
        db,
        context,
        'rejected',
        'invalid_sale_data',
        'The saved cash sale contains invalid details and was not finalized.',
        sequence,
      );
    const order = parsed.data;
    const catalogVersion = BigInt(order.catalog_version).toString();
    const snapshotExists =
      (await db.query('SELECT 1 FROM catalog_snapshots WHERE version=$1', [catalogVersion]))
        .rowCount > 0;
    if (!snapshotExists)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'catalog_missing',
        'The saved sale menu version is unavailable. Keep the receipt for review.',
        sequence,
      );

    const lease = (
      await db.query(
        `SELECT id,device_id,credential_id,catalog_version,capabilities,payload_text,
                issued_at,expires_at,revoked_at,clock_timestamp() AS server_now
         FROM pos_offline_leases WHERE id=$1 FOR SHARE`,
        [order.lease_id],
      )
    ).rows[0];
    let leasePayload;
    try {
      leasePayload = lease && JSON.parse(lease.payload_text);
    } catch {
      leasePayload = null;
    }
    const leaseCaps = Array.isArray(lease?.capabilities) ? lease.capabilities : [];
    const payloadCaps = Array.isArray(leasePayload?.capabilities) ? leasePayload.capabilities : [];
    if (
      !lease ||
      lease.revoked_at ||
      lease.device_id !== device.id ||
      lease.credential_id !== device.credential_id ||
      String(lease.catalog_version) !== catalogVersion ||
      String(leasePayload?.lease_id) !== order.lease_id ||
      String(leasePayload?.device_id) !== device.id ||
      String(leasePayload?.credential_id) !== device.credential_id ||
      String(leasePayload?.catalog_version) !== catalogVersion ||
      Date.parse(leasePayload?.issued_at) !== new Date(lease.issued_at).getTime() ||
      Date.parse(leasePayload?.expires_at) !== new Date(lease.expires_at).getTime() ||
      leaseCaps.length !== 2 ||
      leaseCaps[0] !== 'catalog:read' ||
      leaseCaps[1] !== 'orders:cash:offline' ||
      payloadCaps.length !== 2 ||
      payloadCaps[0] !== 'catalog:read' ||
      payloadCaps[1] !== 'orders:cash:offline'
    )
      return await recordIssue(
        db,
        context,
        'needs_review',
        'lease_not_authorized',
        'The sale does not have a valid offline cash authorization. Keep this receipt for review.',
        sequence,
        catalogVersion,
      );
    const nowMs = new Date(lease.server_now).getTime();
    const issuedMs = new Date(lease.issued_at).getTime();
    const expiresMs = new Date(lease.expires_at).getTime();
    if (lease.revoked_at || nowMs < issuedMs || nowMs >= expiresMs)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'lease_expired',
        'The offline sales authorization expired before this sale could be synchronized. Keep this receipt for review.',
        sequence,
        catalogVersion,
      );
    const clientCreatedMs = Date.parse(order.client_created_at);
    if (clientCreatedMs < issuedMs - 5 * 60_000 || clientCreatedMs > expiresMs + 5 * 60_000)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'sale_time_outside_lease',
        'The saved sale time is outside the authorized offline period. Keep this receipt for review.',
        sequence,
        catalogVersion,
      );

    const state = (await db.query('SELECT version FROM catalog_state WHERE id=1')).rows[0];
    if (!state || String(state.version) !== catalogVersion)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'stale_catalog',
        'The menu changed after this sale was recorded. Keep the receipt for review.',
        sequence,
        catalogVersion,
      );

    const signatureRow = (
      await db.query(
        `SELECT key_id,payload_text,payload_sha256,signature
         FROM catalog_snapshot_signatures
         WHERE version=$1 AND payload_sha256=$2 AND key_id=$3 AND signature=$4`,
        [catalogVersion, order.catalog_digest, order.catalog_key_id, order.catalog_signature],
      )
    ).rows[0];
    if (!signatureRow)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'catalog_signature_missing',
        'The saved sale catalog could not be verified by the server. Keep the receipt for review.',
        sequence,
        catalogVersion,
      );
    if (
      createHash('sha256').update(signatureRow.payload_text).digest('hex') !== order.catalog_digest
    )
      return await recordIssue(
        db,
        context,
        'needs_review',
        'catalog_digest_invalid',
        'The saved sale menu digest is invalid. Keep the receipt for review.',
        sequence,
        catalogVersion,
      );
    let catalog;
    try {
      catalog = JSON.parse(signatureRow.payload_text);
    } catch {
      catalog = null;
    }
    if (!catalog || String(catalog.catalog_version) !== catalogVersion)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'catalog_invalid',
        'The saved sale catalog is invalid. Keep the receipt for review.',
        sequence,
        catalogVersion,
      );

    const snapshotProducts = new Map(
      (catalog.products || []).map((product) => [product.id, product]),
    );
    const ids = order.items.map((item) => item.product_id);
    if (new Set(ids).size !== ids.length)
      return await recordIssue(
        db,
        context,
        'rejected',
        'duplicate_product_line',
        'Combine duplicate products into one sale line.',
        sequence,
        catalogVersion,
      );
    const currentProducts = (
      await db.query('SELECT * FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE', [ids])
    ).rows;
    const currentById = new Map(currentProducts.map((product) => [product.id, product]));
    const lines = [];
    for (const item of order.items) {
      const snapshot = snapshotProducts.get(item.product_id);
      if (!snapshot)
        return await recordIssue(
          db,
          context,
          'rejected',
          'invalid_product',
          'A sale item is not in the signed menu. Keep the receipt for review.',
          sequence,
          catalogVersion,
        );
      if (!snapshot.available || snapshot.deleted_at)
        return await recordIssue(
          db,
          context,
          'needs_review',
          'product_unavailable',
          `${snapshot.name} is no longer available. Keep the receipt for review.`,
          sequence,
          catalogVersion,
        );
      const unitCents = cents(snapshot.price);
      const lineCents = unitCents * item.quantity;
      if (
        item.name !== snapshot.name ||
        item.category !== snapshot.category ||
        item.image_url !== snapshot.image_url ||
        cents(item.unit_price) !== unitCents ||
        cents(item.subtotal) !== lineCents
      )
        return await recordIssue(
          db,
          context,
          'needs_review',
          'item_snapshot_changed',
          'A saved item no longer matches the verified menu. Keep the receipt for review.',
          sequence,
          catalogVersion,
        );
      const current = currentById.get(item.product_id);
      if (
        !current ||
        !current.available ||
        current.deleted_at ||
        cents(current.price) !== unitCents ||
        current.name !== snapshot.name
      )
        return await recordIssue(
          db,
          context,
          'needs_review',
          current ? 'price_or_product_changed' : 'invalid_product',
          `${snapshot.name} changed after this sale was recorded. Keep the receipt for review.`,
          sequence,
          catalogVersion,
        );
      lines.push({ ...snapshot, quantity: item.quantity, sum: lineCents });
    }

    const settings = (await db.query('SELECT * FROM settings WHERE id=1 FOR SHARE')).rows[0];
    const lockedState = (await db.query('SELECT version FROM catalog_state WHERE id=1 FOR SHARE'))
      .rows[0];
    if (!lockedState || String(lockedState.version) !== catalogVersion)
      return await recordIssue(
        db,
        context,
        'needs_review',
        'stale_catalog',
        'The menu changed while this sale was being checked. Keep the receipt for review.',
        sequence,
        catalogVersion,
      );
    const snapshotTax = Number(catalog.settings.tax_percentage);
    const snapshotCurrency = catalog.settings.currency;
    if (
      !settings ||
      !knownCurrencies.has(snapshotCurrency) ||
      settings.currency !== snapshotCurrency ||
      Number(settings.tax_percentage) !== snapshotTax ||
      order.currency !== snapshotCurrency ||
      order.tax_percentage !== snapshotTax
    )
      return await recordIssue(
        db,
        context,
        'rejected',
        'tax_or_currency_changed',
        'Tax or currency does not match the verified café settings. Keep the receipt for review.',
        sequence,
        catalogVersion,
      );

    const subtotal = lines.reduce((sum, line) => sum + line.sum, 0);
    const discount = cents(order.discount);
    if (discount > subtotal)
      return await recordIssue(
        db,
        context,
        'rejected',
        'invalid_discount',
        'The recorded discount exceeds the sale subtotal.',
        sequence,
        catalogVersion,
      );
    const tax = Math.round(((subtotal - discount) * snapshotTax) / 100);
    const total = subtotal - discount + tax;
    const cashReceived = cents(order.cash_received);
    const change = cashReceived - total;
    if (
      total > 10_000_000 ||
      cashReceived < total ||
      change < 0 ||
      !sameMoney(order.subtotal, subtotal / 100) ||
      !sameMoney(order.tax, tax / 100) ||
      !sameMoney(order.expected_total, total / 100) ||
      !sameMoney(order.change_amount, change / 100)
    )
      return await recordIssue(
        db,
        context,
        'rejected',
        'invalid_cash_totals',
        'Cash received, change, or sale totals do not match the verified sale.',
        sequence,
        catalogVersion,
      );

    const serverNow = new Date(lease.server_now);
    const orderNumber = `BB-${serverNow.toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const publicSettings = {
      cafe_name: catalog.settings.cafe_name,
      address: catalog.settings.address,
      phone: catalog.settings.phone,
      logo_url: catalog.settings.logo_url,
    };
    const inserted = await db.query(
      `INSERT INTO orders
         (order_number,request_id,cashier_id,subtotal,discount,tax,tax_percentage,total,currency,
          receipt_settings,catalog_version,source,device_id,device_sequence,client_created_at)
       VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,'offline',$11,$12,$13)
       RETURNING id`,
      [
        orderNumber,
        requestId,
        amount(subtotal),
        amount(discount),
        amount(tax),
        snapshotTax,
        amount(total),
        snapshotCurrency,
        JSON.stringify(publicSettings),
        catalogVersion,
        device.id,
        sequence,
        order.client_created_at,
      ],
    );
    const orderId = inserted.rows[0].id;
    for (const line of lines)
      await db.query(
        `INSERT INTO order_items(order_id,product_id,product_name,image_url,quantity,unit_price,subtotal)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          orderId,
          line.id,
          line.name,
          line.image_url,
          line.quantity,
          amount(cents(line.price)),
          amount(line.sum),
        ],
      );
    await db.query(
      `INSERT INTO payments(order_id,method,amount,cash_received,change_amount)
       VALUES($1,'cash',$2,$3,$4)`,
      [orderId, amount(total), amount(cashReceived), amount(change)],
    );
    const savedOrder = await getOrder(orderId, db);
    const response = canonicalResponse(savedOrder, requestId);
    await db.query(
      `INSERT INTO order_sync_receipts
         (request_id,cashier_id,payload_hash,outcome,order_id,device_id,device_sequence,catalog_version,response)
       VALUES($1,NULL,$2,'accepted',$3,$4,$5,$6,$7::jsonb)`,
      [
        requestId,
        fingerprint,
        orderId,
        device.id,
        sequence,
        catalogVersion,
        JSON.stringify(response),
      ],
    );
    await db.query('COMMIT');
    return response;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      // Preserve the original database error.
    }
    if (error instanceof HttpError) throw error;
    throw error;
  } finally {
    db.release();
  }
}

export async function syncOfflineCashBatch(orders, device, dbPool = pool) {
  const results = [];
  for (const raw of orders) results.push(await processOfflineCashOrder(raw, device, dbPool));
  return { results };
}
