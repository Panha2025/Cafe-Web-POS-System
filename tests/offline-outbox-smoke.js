import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const vite = await createServer({
  configFile: join(process.cwd(), 'frontend/vite.config.js'),
  root: join(process.cwd(), 'frontend'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
const profile = await mkdtemp(join(tmpdir(), 'cafe-pos-offline-'));
let browserContext;

try {
  await vite.listen();
  const address = vite.httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  browserContext = await chromium.launchPersistentContext(profile, {
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
  });
  let page = browserContext.pages()[0] || (await browserContext.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const receipt = await page.evaluate(async () => {
    const { createOfflineCashSale } = await import('/src/offline/orders.js');
    const product = {
      id: 41,
      name: 'Offline test latte',
      category: 'Coffee',
      image_url: '/images/coffee.svg',
      price: 2.5,
      available: true,
      deleted_at: null,
    };
    return createOfflineCashSale({
      authorization: {
        identity: { device_id: '11111111-1111-4111-8111-111111111111' },
        lease: { lease_id: '22222222-2222-4222-8222-222222222222' },
        catalogEnvelope: { digest: 'a'.repeat(64) },
        catalog: {
          catalog_version: '8',
          settings: {
            cafe_name: 'Test Café',
            address: 'Test address',
            phone: '555-0100',
            logo_url: null,
            currency: 'USD',
            tax_percentage: 10,
          },
          products: [product],
        },
      },
      items: [{ ...product, quantity: 2 }],
      discount: 0,
      cashReceived: 10,
    });
  });
  assert.equal(receipt.offline_pending, true);
  assert.match(receipt.order_number, /^LOCAL-/);
  assert.equal(receipt.payment_method, 'cash');
  assert.equal(receipt.total, 5.5);

  await page.evaluate(async () => {
    const { updateOutboxOrder } = await import('/src/offline/database.js');
    const { listOutboxOrders, countFutureOutboxRecords } = await import('/src/offline/database.js');
    const records = await listOutboxOrders();
    await updateOutboxOrder(records[0].request_id, { state: 'syncing' });
    return countFutureOutboxRecords();
  });
  await page.route('**/api/health', (route) => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  let recovered = await page.evaluate(async () => {
    const { listOutboxOrders } = await import('/src/offline/database.js');
    return listOutboxOrders();
  });
  assert.equal(recovered.length, 1, 'the sale survives a full page reload');
  assert.equal(
    recovered[0].state,
    'pending_sync',
    'an interrupted sync returns to the retry queue',
  );
  assert.equal(recovered[0].provisional_receipt.order_number, receipt.order_number);
  assert.equal(recovered[0].payload.items[0].name, 'Offline test latte');

  await browserContext.close();
  browserContext = await chromium.launchPersistentContext(profile, {
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
  });
  page = browserContext.pages()[0] || (await browserContext.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  recovered = await page.evaluate(async () => {
    const { listOutboxOrders } = await import('/src/offline/database.js');
    return listOutboxOrders();
  });
  assert.equal(recovered.length, 1, 'the sale survives closing and restarting the browser');
  assert.equal(recovered[0].state, 'pending_sync');
  console.log(
    'PASS: offline provisional receipt, IndexedDB persistence, reload recovery, and browser restart recovery.',
  );
} finally {
  await browserContext?.close();
  await vite.close();
  await rm(profile, { recursive: true, force: true });
}
