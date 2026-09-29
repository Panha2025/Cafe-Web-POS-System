import { test, expect } from '@playwright/test';

test('edit price and replace product photo from Settings, preserving drafts and saved changes', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email address').fill('admin@cafepos.local');
  await page.getByLabel('Password', { exact: true }).fill('Admin123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fresh picks, happy people.' })).toBeVisible();

  const name = `Settings photo check ${Date.now()}`;
  const categories = await (await page.request.get('/api/categories')).json();
  const response = await page.request.post('/api/products', {
    multipart: { name, price: '3.00', category_id: String(categories[0].id), available: 'true' },
  });
  expect(response.status()).toBe(201);
  const product = await response.json();
  try {
    await page.reload();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    const cafeName = await page.getByLabel('Café name', { exact: true }).inputValue();
    await page.getByLabel('Café name', { exact: true }).fill('Unsaved café draft');
    await page.getByRole('button', { name: 'Menu & prices', exact: true }).click();
    await page.getByRole('button', { name: 'Café details & images', exact: true }).click();
    await expect(page.getByLabel('Café name', { exact: true })).toHaveValue('Unsaved café draft');
    await page.getByLabel('Café name', { exact: true }).fill(cafeName);
    await page.getByRole('button', { name: 'Menu & prices', exact: true }).click();
    await page.getByLabel('Search products').fill(name);
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await page.getByLabel('Price', { exact: true }).fill('4.25');
    await page.getByLabel('Product image').setInputFiles('frontend/public/images/cappuccino.jpg');
    await expect(page.getByText('New photo preview', { exact: true })).toBeVisible();
    await expect(page.getByAltText('Product preview')).toHaveAttribute('src', /^data:image/);
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.settings-menu tbody')).toContainText('$4.25');
    const newPhoto = await page.locator('.settings-menu tbody img').getAttribute('src');
    expect(newPhoto).toMatch(/^\/uploads\/.+\.webp$/);
    expect(newPhoto).not.toBe(product.image_url);

    await page.getByRole('navigation').getByRole('button', { name: 'POS', exact: true }).click();
    const card = page.getByRole('button', { name: `Add ${name}`, exact: true });
    await expect(card).toContainText('$4.25');
    await expect(card.locator('img')).toHaveAttribute('src', newPhoto);
    await card.click();
    await expect(page.locator('.cart-item-info')).toContainText('$4.25');
    await page.reload();
    await expect(card).toContainText('$4.25');
    await expect(card.locator('img')).toHaveAttribute('src', newPhoto);

    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('navigation')
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Menu & prices', exact: true }).click();
    await page.getByLabel('Search products').fill(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/api/products/${product.id}`);
  }
});
