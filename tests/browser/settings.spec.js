import 'dotenv/config';
import { test, expect } from '@playwright/test';
import pg from 'pg';
async function login(page) {
  await page.goto('/');
  await page.getByLabel('Email address').fill('admin@cafepos.local');
  await page.getByLabel('Password', { exact: true }).fill('Admin123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fresh picks, happy people.' })).toBeVisible();
}
test('settings form uploads logo and KHQR, applies tax and café details to manual payment receipt', async ({
  page,
}) => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const original = (await db.query('SELECT * FROM settings WHERE id=1')).rows[0];
  try {
    await login(page);
    await page
      .getByRole('navigation')
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await page.getByLabel('Café name', { exact: true }).fill('Brew & Bean Test Café');
    await page.getByLabel('Address', { exact: true }).fill('Test address, Phnom Penh');
    await page.getByLabel('Phone number', { exact: true }).fill('+855 12 000 123');
    await page.getByRole('combobox', { name: 'Currency', exact: true }).selectOption('USD');
    await page.getByLabel('Tax percentage', { exact: true }).fill('10');
    await page
      .getByLabel('Café logo', { exact: true })
      .setInputFiles('frontend/public/images/cappuccino.jpg');
    // Test image exercises upload/display only; it is not a real payment QR.
    await page
      .getByLabel('KHQR image', { exact: true })
      .setInputFiles('frontend/public/images/latte.jpg');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByRole('status')).toContainText('Settings saved');
    await expect(page.locator('.sidebar .brand strong')).toHaveText('Brew & Bean Test Café');
    await expect(page.locator('.sidebar .brand img')).toHaveAttribute('src', /\/uploads\/.*\.webp/);
    await page.getByRole('navigation').getByRole('button', { name: 'POS', exact: true }).click();
    await page.getByRole('button', { name: 'Add Americano', exact: true }).click();
    await expect(page.getByTestId('order-total')).toHaveText('$2.75');
    await page.getByRole('button', { name: 'KHQR', exact: true }).click();
    await page.getByRole('button', { name: 'Proceed to Payment' }).click();
    await expect(page.getByAltText('Café KHQR payment code')).toBeVisible();
    await expect(page.locator('.amount-due')).toContainText('$2.75');
    await page.getByRole('button', { name: 'Payment Received', exact: true }).click();
    await expect(page.locator('.receipt')).toContainText('Brew & Bean Test Café');
    await expect(page.locator('.receipt')).toContainText('Test address, Phnom Penh');
    await expect(page.locator('.receipt')).toContainText('KHQR');
    await expect(page.locator('.receipt')).toContainText('$2.75');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.receipt')).toBeVisible();
    await expect(page.locator('.modal-header')).not.toBeVisible();
    await page.pdf({
      path: 'test-results/khqr-receipt.pdf',
      width: '80mm',
      height: '220mm',
      printBackground: true,
    });
    await page.emulateMedia({ media: 'screen' });
  } finally {
    await db.query(
      'UPDATE settings SET cafe_name=$1,address=$2,phone=$3,currency=$4,tax_percentage=$5,logo_url=$6,khqr_url=$7 WHERE id=1',
      [
        original.cafe_name,
        original.address,
        original.phone,
        original.currency,
        original.tax_percentage,
        original.logo_url,
        original.khqr_url,
      ],
    );
    await db.end();
  }
});
test('a lost checkout response can be retried without charging or saving a second order', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Add Cappuccino', exact: true }).click();
  await page.getByRole('button', { name: 'Proceed to Payment' }).click();
  await page.getByLabel('Cash received').fill('10');
  let saved,
    first = true;
  const references = [];
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    references.push(route.request().postDataJSON().request_id);
    if (first) {
      first = false;
      const response = await route.fetch();
      saved = await response.json();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Connection interrupted after saving. Please retry.' }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Confirm Payment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  await expect(page.getByRole('button', { name: 'Confirm Payment', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Confirm Payment', exact: true }).click();
  await expect(page.locator('.receipt-meta strong')).toHaveText(saved.order_number);
  expect(references).toHaveLength(2);
  expect(references[0]).toBe(references[1]);
  const orders = await page.request.get(`/api/orders?number=${saved.order_number}`);
  expect((await orders.json()).total).toBe(1);
});
