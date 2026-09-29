import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const dist = resolve('frontend/dist');
const workerPath = resolve(dist, 'service-worker.js');
const originalWorker = await readFile(workerPath);
const mime = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
};
const owner = { id: 1, name: 'Test Owner', email: 'owner@example.test', role: 'admin' };
const settings = {
  cafe_name: 'Test Café',
  address: '',
  phone: '',
  currency: 'USD',
  tax_percentage: 0,
  logo_url: null,
  khqr_url: null,
};
const products = [
  {
    id: 1,
    name: 'Americano',
    price: '2.50',
    category_id: 1,
    category: 'Coffee',
    available: true,
    image_url: '/images/coffee.svg',
  },
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/health') return response.end(JSON.stringify({ status: 'ok' }));
    if (url.pathname === '/api/auth/me') return response.end(JSON.stringify(owner));
    if (url.pathname === '/api/settings') return response.end(JSON.stringify(settings));
    if (url.pathname === '/api/products') return response.end(JSON.stringify(products));
    if (url.pathname === '/api/categories')
      return response.end(JSON.stringify([{ id: 1, name: 'Coffee' }]));
    if (url.pathname === '/api/orders' && request.method === 'POST')
      return response.writeHead(201).end(JSON.stringify({ id: 123 }));
    return response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
  }
  let path = resolve(dist, '.' + decodeURIComponent(url.pathname));
  if (!path.startsWith(dist)) path = resolve(dist, 'index.html');
  try {
    const info = await stat(path);
    if (!info.isFile()) path = resolve(dist, 'index.html');
  } catch {
    path = resolve(dist, 'index.html');
  }
  try {
    const body = await readFile(path);
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const port = server.address().port;
const origin = 'http://127.0.0.1:' + port;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage();
  await page.route(/\.js(?:\?|$)/, (route) => route.abort());
  await page.goto(origin);
  await page.evaluate(
    () =>
      new Promise((resolveRequest, reject) => {
        const request = indexedDB.open('cafe-pos', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('catalogs', { keyPath: 'version' });
          db.createObjectStore('deviceKeys', { keyPath: 'credential_id' });
          db.createObjectStore('leases', { keyPath: 'lease_id' });
          db.createObjectStore('outbox', { keyPath: 'request_id' });
          db.createObjectStore('syncResults', { keyPath: 'request_id' });
          request.transaction.objectStore('outbox').put({
            request_id: 'future-format-record',
            state: 'queued',
            created_at: '2026-09-01T00:00:00.000Z',
          });
        };
        request.onsuccess = () => {
          request.result.close();
          resolveRequest();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await page.unroute(/\.js(?:\?|$)/);
  await page.addInitScript(() => {
    window.addEventListener('pos-pwa-registration-error', () => {
      window.__posPwaRegistrationFailed = true;
    });
  });
  await page.reload();
  await page.getByRole('heading', { name: 'Fresh picks, happy people.' }).waitFor();
  await page
    .waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 5000 })
    .catch(async () => {
      const state = await page.evaluate(async () => ({
        secure: globalThis.isSecureContext,
        supported: 'serviceWorker' in navigator,
        failed: window.__posPwaRegistrationFailed,
        registration: (await navigator.serviceWorker?.getRegistration())?.active?.scriptURL || null,
      }));
      throw new Error('Service worker did not control the page: ' + JSON.stringify(state));
    });
  const migration = await page.evaluate(
    () =>
      new Promise((resolveRequest, reject) => {
        const request = indexedDB.open('cafe-pos');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readonly');
          const store = tx.objectStore('outbox');
          const record = store.get('future-format-record');
          record.onsuccess = () =>
            resolveRequest({
              version: db.version,
              state: record.result?.state,
              index: store.indexNames.contains('state'),
              next_attempt_index: store.indexNames.contains('next_attempt_at'),
            });
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  assert.equal(migration.version, 3);
  assert.equal(migration.state, 'queued');
  assert.equal(migration.index, true);
  assert.equal(migration.next_attempt_index, true);

  await page.getByRole('button', { name: 'Add Americano' }).click();
  await page.context().setOffline(true);
  await page.getByTestId('pos-sync-status').getByText('network unavailable').waitFor();
  assert.equal(await page.getByRole('button', { name: /Proceed to Payment/ }).isDisabled(), true);
  await page.reload();
  await page.getByRole('heading', { name: 'Ready for a great day?' }).waitFor();
  await page.getByTestId('pos-sync-status').getByText('network unavailable').waitFor();
  const preserved = await page.evaluate(
    () =>
      new Promise((resolveRequest, reject) => {
        const request = indexedDB.open('cafe-pos');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readonly');
          const record = tx.objectStore('outbox').get('future-format-record');
          record.onsuccess = () => resolveRequest(record.result);
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  assert.equal(
    preserved.state,
    'queued',
    'offline app-shell load leaves future outbox data intact',
  );

  const manifest = await (await fetch(origin + '/manifest.webmanifest')).json();
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  const worker = await readFile('frontend/src/service-worker.js', 'utf8');
  assert.match(worker, /new NetworkOnly\(\)/);
  assert.match(worker, /ACTIVATE_APPROVED_UPDATE/);
  assert.doesNotMatch(worker, /indexedDB|BackgroundSync|SyncManager/);
  await page.context().setOffline(false);
  await writeFile(
    workerPath,
    Buffer.concat([originalWorker, Buffer.from('\n/* phase2 update test */\n')]),
  );
  await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then((registration) => registration.update()),
  );
  const updateButton = page.getByRole('button', { name: /App update waiting/ });
  await updateButton.waitFor({ timeout: 15000 });
  await updateButton.click();
  await page.getByText(/preserve and sync local records before applying it/i).waitFor();
  const waitingUpdate = await page.evaluate(async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
  assert.equal(
    waitingUpdate,
    true,
    'the waiting update stays deferred while future outbox data exists',
  );
  const queuedAfterUpdate = await page.evaluate(
    () =>
      new Promise((resolveRequest, reject) => {
        const request = indexedDB.open('cafe-pos');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readonly');
          const record = tx.objectStore('outbox').get('future-format-record');
          record.onsuccess = () => resolveRequest(record.result);
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  assert.equal(
    queuedAfterUpdate.state,
    'queued',
    'a waiting service-worker update preserves the outbox',
  );
  console.log(
    'PASS: install metadata, IndexedDB migration, offline app shell, checkout live-server gate, waiting SW update, and outbox preservation.',
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await writeFile(workerPath, originalWorker);
}
