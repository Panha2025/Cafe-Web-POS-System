import { deviceApi } from './device';
import {
  enqueueOfflineOrder,
  getLastSuccessfulSync,
  listOutboxOrders,
  saveSyncResult,
  updateOutboxOrder,
} from './database';

const cents = (value) => Math.round(Number(value) * 100);
const amount = (value) => Number((value / 100).toFixed(2));
const emitOutboxUpdate = () => window.dispatchEvent(new Event('pos-outbox-updated'));

export async function createOfflineCashSale({ authorization, items, discount, cashReceived }) {
  if (!authorization?.catalog || !authorization?.lease || !authorization?.identity)
    throw new Error('A verified menu and offline cash authorization are required.');
  const catalog = authorization.catalog;
  const catalogProducts = new Map(catalog.products.map((product) => [product.id, product]));
  const normalizedItems = items.map((item) => {
    const product = catalogProducts.get(item.id);
    if (!product || !product.available || product.deleted_at)
      throw new Error('An item is not available in the verified offline menu.');
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999)
      throw new Error('An item quantity is invalid.');
    return {
      product_id: product.id,
      name: product.name,
      category: product.category,
      image_url: product.image_url,
      quantity,
      unit_price: Number(product.price),
      subtotal: amount(cents(product.price) * quantity),
    };
  });
  if (new Set(normalizedItems.map((item) => item.product_id)).size !== normalizedItems.length)
    throw new Error('Combine duplicate products into one sale line.');

  const subtotal = normalizedItems.reduce((sum, item) => sum + cents(item.subtotal), 0);
  const discountCents = cents(discount || 0);
  const taxPercentage = Number(catalog.settings.tax_percentage);
  const receivedCents = cents(cashReceived);
  if (!Number.isSafeInteger(discountCents) || discountCents < 0 || discountCents > subtotal)
    throw new Error('Discount must be between zero and the subtotal.');
  if (!Number.isFinite(taxPercentage) || taxPercentage < 0 || taxPercentage > 100)
    throw new Error('The verified catalog tax setting is invalid.');
  const tax = Math.round(((subtotal - discountCents) * taxPercentage) / 100);
  const total = subtotal - discountCents + tax;
  if (!Number.isSafeInteger(receivedCents) || receivedCents < total)
    throw new Error('Cash received must cover the sale total.');
  const requestId = crypto.randomUUID();
  const clientCreatedAt = new Date().toISOString();
  const receiptSettings = {
    cafe_name: catalog.settings.cafe_name,
    address: catalog.settings.address,
    phone: catalog.settings.phone,
    logo_url: catalog.settings.logo_url,
  };

  const saved = await enqueueOfflineOrder((deviceSequence) => {
    const payload = {
      request_id: requestId,
      device_id: authorization.identity.device_id,
      lease_id: authorization.lease.lease_id,
      device_sequence: deviceSequence,
      catalog_version: String(catalog.catalog_version),
      catalog_digest: authorization.catalogEnvelope.digest,
      catalog_key_id: authorization.catalogEnvelope.key_id,
      catalog_signature: authorization.catalogEnvelope.signature,
      client_created_at: clientCreatedAt,
      currency: catalog.settings.currency,
      items: normalizedItems,
      subtotal: amount(subtotal),
      discount: amount(discountCents),
      tax_percentage: taxPercentage,
      tax: amount(tax),
      expected_total: amount(total),
      cash_received: amount(receivedCents),
      change_amount: amount(receivedCents - total),
    };
    const provisionalReceipt = {
      id: `local-${requestId}`,
      request_id: requestId,
      order_number: `LOCAL-${requestId.slice(0, 8).toUpperCase()}`,
      created_at: clientCreatedAt,
      client_created_at: clientCreatedAt,
      cashier: 'Offline POS device',
      source: 'offline',
      sync_state: 'pending_sync',
      offline_pending: true,
      items: normalizedItems.map((item) => ({
        id: item.product_id,
        product_id: item.product_id,
        product_name: item.name,
        image_url: item.image_url,
        quantity: item.quantity,
        unit_price: item.unit_price,
        subtotal: item.subtotal,
      })),
      subtotal: amount(subtotal),
      discount: amount(discountCents),
      tax: amount(tax),
      tax_percentage: taxPercentage,
      total: amount(total),
      currency: catalog.settings.currency,
      payment_method: 'cash',
      cash_received: amount(receivedCents),
      change_amount: amount(receivedCents - total),
      receipt_settings: receiptSettings,
    };
    return {
      request_id: requestId,
      source: 'offline',
      device_sequence: deviceSequence,
      state: 'pending_sync',
      attempts: 0,
      created_at: clientCreatedAt,
      payload,
      provisional_receipt: provisionalReceipt,
    };
  });
  emitOutboxUpdate();
  return saved.provisional_receipt;
}

async function markRetry(record, message) {
  const attempts = Number(record.attempts || 0) + 1;
  const delay = Math.min(1000 * 2 ** Math.min(attempts, 8), 5 * 60_000);
  await updateOutboxOrder(record.request_id, {
    state: 'pending_sync',
    attempts,
    next_attempt_at: new Date(Date.now() + delay).toISOString(),
    sync_error: message,
  });
}

async function sendBatch(records) {
  const startedAt = new Date().toISOString();
  for (const record of records)
    await updateOutboxOrder(record.request_id, {
      state: 'syncing',
      sync_started_at: startedAt,
      sync_error: '',
    });
  emitOutboxUpdate();

  let response;
  try {
    response = await deviceApi('/orders/sync', {
      method: 'POST',
      body: JSON.stringify({ orders: records.map((record) => record.payload) }),
    });
  } catch (error) {
    if ([400, 401, 403, 413].includes(error.status)) {
      for (const record of records) {
        await updateOutboxOrder(record.request_id, {
          state: 'needs_review',
          sync_error: 'POS authorization or sale format needs administrator review.',
          server_result: { state: 'needs_review', durable: false },
          next_attempt_at: null,
          provisional_receipt: {
            ...record.provisional_receipt,
            sync_state: 'needs_review',
            offline_pending: false,
          },
        });
      }
      emitOutboxUpdate();
      return false;
    }
    for (const record of records)
      await markRetry(
        record,
        'The server could not confirm synchronization. Retrying automatically.',
      );
    emitOutboxUpdate();
    return false;
  }

  let safeToContinue = true;
  const results = new Map((response.results || []).map((result) => [result.request_id, result]));
  for (const record of records) {
    const result = results.get(record.request_id);
    if (!result) {
      await markRetry(record, 'The server response was incomplete. Retrying automatically.');
      safeToContinue = false;
      continue;
    }
    if (result.state === 'synced' && result.durable) {
      const saved = await updateOutboxOrder(record.request_id, {
        state: 'synced',
        sync_error: '',
        server_result: result,
        next_attempt_at: null,
        provisional_receipt: {
          ...record.provisional_receipt,
          order_number: result.order_number,
          created_at: result.server_created_at || record.provisional_receipt.created_at,
          server_order_id: result.order_id,
          sync_state: 'synced',
          offline_pending: false,
        },
      });
      await saveSyncResult({ ...result, state: 'synced' });
      if (!saved) continue;
    } else if (result.state === 'needs_review') {
      if (!result.durable) safeToContinue = false;
      await updateOutboxOrder(record.request_id, {
        state: 'needs_review',
        sync_error: result.message || 'This sale needs administrator review.',
        server_result: result,
        next_attempt_at: null,
        provisional_receipt: {
          ...record.provisional_receipt,
          sync_state: 'needs_review',
          offline_pending: false,
        },
      });
      await saveSyncResult(result);
    } else if (result.state === 'rejected') {
      if (!result.durable) safeToContinue = false;
      await updateOutboxOrder(record.request_id, {
        state: 'rejected',
        sync_error: result.message || 'This sale could not be finalized.',
        server_result: result,
        next_attempt_at: null,
        provisional_receipt: {
          ...record.provisional_receipt,
          sync_state: 'rejected',
          offline_pending: false,
        },
      });
      await saveSyncResult(result);
    } else {
      await markRetry(
        record,
        'The server has not confirmed this sale yet. Retrying automatically.',
      );
      safeToContinue = false;
    }
  }
  emitOutboxUpdate();
  return safeToContinue;
}

let activeSync;
export async function synchronizeOutbox({ force = false } = {}) {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    if (!navigator.onLine) return { attempted: false, error: 'offline' };
    const records = await listOutboxOrders();
    const now = Date.now();
    const due = records.filter((record) => {
      if (!['pending_sync', 'syncing'].includes(record.state)) return false;
      if (record.state === 'syncing') return true;
      return force || !record.next_attempt_at || Date.parse(record.next_attempt_at) <= now;
    });
    if (!due.length) return { attempted: false, count: 0 };
    for (let index = 0; index < due.length; index += 10) {
      if (!(await sendBatch(due.slice(index, index + 10)))) break;
    }
    return { attempted: true, count: due.length };
  })().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

export async function recoverOutboxAfterRestart() {
  const records = await listOutboxOrders();
  const interrupted = records.filter((record) => record.state === 'syncing');
  for (const record of interrupted)
    await updateOutboxOrder(record.request_id, {
      state: 'pending_sync',
      next_attempt_at: null,
      sync_error: '',
    });
  if (interrupted.length) emitOutboxUpdate();
  return listOutboxOrders();
}

export async function readOutboxStatus() {
  const orders = await listOutboxOrders();
  return {
    orders,
    pending: orders.filter((order) => ['pending_sync', 'syncing'].includes(order.state)).length,
    syncing: orders.some((order) => order.state === 'syncing'),
    needsReview: orders.filter((order) => order.state === 'needs_review').length,
    rejected: orders.filter((order) => order.state === 'rejected').length,
    lastSuccessfulSync: await getLastSuccessfulSync(),
    syncErrors: orders.filter((order) => order.sync_error).map((order) => order.sync_error),
  };
}
