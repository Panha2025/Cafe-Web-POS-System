import 'dotenv/config';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

async function start(port, databaseUrl = process.env.DATABASE_URL) {
  const child = spawn(process.execPath, ['backend/server.js'], {
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (output.includes('Café POS API running')) return child;
    if (child.exitCode !== null) throw new Error(output);
    await delay(100);
  }
  child.kill();
  throw new Error(`Server did not start: ${output}`);
}

async function stop(child) {
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

const smokePort = Number(process.env.BUILD_SMOKE_PORT || 4001);
const server = await start(smokePort);
let browser;
try {
  const workerSource = await readFile('frontend/src/service-worker.js', 'utf8');
  assert.match(workerSource, /new NetworkOnly\(\)/, 'API routes use network-only caching');
  assert.match(
    workerSource,
    /ACTIVATE_APPROVED_UPDATE/,
    'SW updates require an explicit user action',
  );
  assert.doesNotMatch(
    workerSource,
    /indexedDB|BackgroundSync|SyncManager/,
    'the service worker never clears IndexedDB or queues requests',
  );
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
  const errors = [];
  await page.route(/\.js(?:\?|$)/, (route) => route.abort());
  await page.goto(`http://127.0.0.1:${smokePort}`);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
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
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await page.unroute(/\.js(?:\?|$)/);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.reload();
  await page.getByLabel('Email address').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  assert.match(
    await page.locator('link[rel="manifest"]').getAttribute('href'),
    /manifest\.webmanifest/,
  );
  const appShellDb = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('cafe-pos');
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('outbox', 'readonly');
          const stored = tx.objectStore('outbox').get('future-format-record');
          stored.onsuccess = () =>
            resolve({
              version: db.version,
              record: stored.result,
              hasStateIndex: tx.objectStore('outbox').indexNames.contains('state'),
              hasNextAttemptIndex: tx.objectStore('outbox').indexNames.contains('next_attempt_at'),
            });
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );
  assert.equal(appShellDb.version, 3, 'the v1-to-v3 IndexedDB migrations ran');
  assert.equal(appShellDb.record.state, 'queued', 'future outbox data survived the migration');
  assert.equal(appShellDb.hasStateIndex, true);
  assert.equal(appShellDb.hasNextAttemptIndex, true);
  const manifest = await (await fetch(`http://127.0.0.1:${smokePort}/manifest.webmanifest`)).json();
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  await page.getByLabel('Email address').fill('admin@cafepos.local');
  await page.getByLabel('Password', { exact: true }).fill('Admin123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Fresh picks, happy people.' }).waitFor();
  await page.getByRole('button', { name: 'Add Americano', exact: true }).click();
  assert.equal(await page.getByTestId('order-total').innerText(), '$2.50');
  const checkout = page.getByRole('button', { name: /Proceed to Payment/ });
  await page.context().setOffline(true);
  await page.getByTestId('pos-sync-status').getByText('network unavailable').waitFor();
  assert.equal(
    await checkout.isDisabled(),
    true,
    'checkout remains closed when the network is unavailable',
  );
  await page.reload();
  await page.getByRole('heading', { name: 'Ready for a great day?' }).waitFor();
  await page.getByTestId('pos-sync-status').getByText('network unavailable').waitFor();
  await page.context().setOffline(false);
  await page
    .evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('cafe-pos');
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('outbox', 'readonly');
            const stored = tx.objectStore('outbox').get('future-format-record');
            stored.onsuccess = () => resolve(stored.result);
            tx.oncomplete = () => db.close();
            tx.onerror = () => reject(tx.error);
          };
          request.onerror = () => reject(request.error);
        }),
    )
    .then((record) =>
      assert.equal(
        record.state,
        'queued',
        'offline shell and SW lifecycle preserved future outbox data',
      ),
    );
  await page.getByLabel('Email address').fill('admin@cafepos.local');
  await page.getByLabel('Password', { exact: true }).fill('Admin123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Fresh picks, happy people.' }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.product-photo img')].every((image) => image.naturalWidth > 0),
  );
  await page.screenshot({ path: 'test-results/built-pos.png' });
  for (const name of ['Orders', 'Products', 'Sales Report', 'Settings']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await page.locator('.page').waitFor();
    assert.equal(await page.locator('.form-error').count(), 0);
  }
  const unexpectedErrors = errors.filter(
    (message) =>
      !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_FAILED|Failed to fetch/i.test(message),
  );
  assert.deepEqual(unexpectedErrors, []);
  console.log(
    'PASS: built React app served by Express, login, local images, cart, all admin pages, no browser console errors.',
  );
} finally {
  await browser?.close();
  await stop(server);
}

const offline = await start(
  smokePort + 1,
  'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable',
);
try {
  const response = await fetch(`http://127.0.0.1:${smokePort + 1}/api/health`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Database connection failed/);
  console.log('PASS: unavailable PostgreSQL returns a friendly 503 error.');
} finally {
  await stop(offline);
}
