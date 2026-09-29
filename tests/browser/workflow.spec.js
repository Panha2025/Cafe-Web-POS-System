import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
test('requested admin workflow: create with image, cash checkout, history, reports, edit price and photo', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.getByLabel('Email address').fill('admin@cafepos.local');
  await page.getByLabel('Password', { exact: true }).fill('Admin123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fresh picks, happy people.' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Sales Report' }).click();
  await expect(page.getByText('Today’s Orders', { exact: true })).toBeVisible();
  const before = Number(
    await page.locator('.stat-card').nth(1).locator(':scope > strong').innerText(),
  );
  const revenueBefore = Number(
    (await page.locator('.stat-card').nth(0).locator(':scope > strong').innerText()).replace(
      /[^0-9.]/g,
      '',
    ),
  );
  await page.getByRole('navigation').getByRole('button', { name: 'Products', exact: true }).click();
  // Make this repeatable without deleting existing receipts.
  const existing = page.getByRole('button', { name: 'Delete Test Latte', exact: true });
  if (await existing.count()) {
    await existing.click();
    await page.getByRole('button', { name: 'Delete Product', exact: true }).click();
    await expect(existing).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Add Product', exact: true }).click();
  await page.getByLabel('Product name', { exact: true }).fill('Test Latte');
  await page.getByLabel('Price', { exact: true }).fill('3.00');
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Coffee' });
  await page
    .getByLabel('Product image', { exact: true })
    .setInputFiles('frontend/public/images/latte.jpg');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'POS', exact: true }).click();
  const card = page.getByRole('button', { name: 'Add Test Latte', exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText('$3.00');
  const firstImage = await card.locator('img').getAttribute('src');
  await card.click();
  await card.click();
  await expect(page.getByLabel('Test Latte quantity')).toHaveText('2');
  await expect(page.getByTestId('order-total')).toHaveText('$6.00');
  await page.getByRole('button', { name: 'Increase Test Latte' }).click();
  await expect(page.getByLabel('Test Latte quantity')).toHaveText('3');
  await page.getByRole('button', { name: 'Decrease Test Latte' }).click();
  await expect(page.getByLabel('Test Latte quantity')).toHaveText('2');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Proceed to Payment' }).click();
  await page.getByLabel('Cash received').fill('10');
  await expect(page.getByTestId('change')).toHaveText('$4.00');
  await page.getByRole('button', { name: 'Confirm Payment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order receipt', exact: true })).toBeVisible();
  await expect(page.locator('.receipt')).toContainText('$6.00');
  await expect(page.locator('.receipt')).toContainText('Test Latte');
  const orderNumber = await page.locator('.receipt-meta strong').innerText();
  await page.evaluate(() => {
    window.print = () => {
      window.__printed = true;
    };
  });
  await page.getByRole('button', { name: 'Print Receipt', exact: true }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(true);
  await mkdir('test-results/evidence', { recursive: true });
  await page.screenshot({ path: 'test-results/evidence/receipt.png' });
  await page.getByRole('button', { name: 'New Order', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search order number').fill(orderNumber);
  await expect(page.getByRole('button', { name: orderNumber, exact: true })).toBeVisible();
  await expect(page.locator('tbody')).toContainText('$6.00');
  await page.getByLabel('Filter payment method').selectOption('cash');
  await expect(page.getByRole('button', { name: orderNumber, exact: true })).toBeVisible();
  await page.getByRole('button', { name: orderNumber, exact: true }).click();
  await expect(page.locator('.receipt')).toContainText('Test Latte');
  await page.getByRole('button', { name: 'New Order', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Sales Report' }).click();
  await expect(page.locator('.stat-card').nth(1).locator(':scope > strong')).toHaveText(
    String(before + 1),
  );
  await expect(page.locator('.stat-card').nth(0).locator(':scope > strong')).toHaveText(
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      revenueBefore + 6,
    ),
  );
  await page.screenshot({ path: 'test-results/evidence/reports.png', fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Test Latte', exact: true }).click();
  await page.getByLabel('Price', { exact: true }).fill('4.00');
  await page
    .getByLabel('Product image', { exact: true })
    .setInputFiles('frontend/public/images/cappuccino.jpg');
  await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: 'POS', exact: true }).click();
  await expect(card).toContainText('$4.00');
  expect(await card.locator('img').getAttribute('src')).not.toBe(firstImage);
  await expect(card.locator('img')).toHaveJSProperty('naturalWidth', 500);
  await card.click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/evidence/pos-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/evidence/pos-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
test('cashier UI hides admin pages and supports search, category, remove, clear, card and KHQR confirmation', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('cashier@cafepos.local');
  await page.getByLabel('Password', { exact: true }).fill('Cashier123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fresh picks, happy people.' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Products' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Settings' })).toHaveCount(
    0,
  );
  await page.getByLabel('Search menu items').fill('Americano');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.getByLabel('Search menu items').fill('');
  await page.locator('.category-tabs').getByRole('button', { name: 'Food', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Croissant', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Americano', exact: true })).toHaveCount(0);
  await page.locator('.category-tabs').getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Add Americano', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Americano', exact: true }).click();
  await expect(page.getByTestId('order-total')).toHaveText('$0.00');
  await page.getByRole('button', { name: 'Add Americano', exact: true }).click();
  await page.getByRole('button', { name: 'Clear All' }).click();
  await expect(page.getByTestId('order-total')).toHaveText('$0.00');
  await page.getByRole('button', { name: 'Add Americano', exact: true }).click();
  await page.getByLabel('Discount amount').fill('0.50');
  await expect(page.getByTestId('order-total')).toHaveText('$2.00');
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  await page.getByRole('button', { name: 'Proceed to Payment' }).click();
  await page.getByRole('button', { name: 'Confirm Card Payment' }).click();
  await expect(page.locator('.receipt')).toContainText('CARD');
  await page.getByRole('button', { name: 'New Order', exact: true }).click();
  await page.getByRole('button', { name: 'Add Americano', exact: true }).click();
  await page.getByRole('button', { name: 'KHQR', exact: true }).click();
  await page.getByRole('button', { name: 'Proceed to Payment' }).click();
  await expect(page.getByText('No KHQR image yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Payment Received' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
