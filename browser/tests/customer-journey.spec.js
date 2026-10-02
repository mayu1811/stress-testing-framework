// End-to-end omnichannel customer journey in a real browser:
// find customer -> browse catalog -> check store inventory -> add to cart -> track order.
// Measures how long each step takes *as the user sees it* (network + rendering),
// which API-level load tests cannot tell you.
const { test, expect } = require('@playwright/test');
const testData = require('../../k6/data/test-data.json');

const any = (arr) => arr[Math.floor(Math.random() * arr.length)];

test('omnichannel customer journey', async ({ page }, testInfo) => {
  const timings = {};
  const step = async (name, fn) => {
    const t0 = Date.now();
    await test.step(name, fn);
    timings[name] = Date.now() - t0;
  };

  const customer = any(testData.customers);
  const order = any(testData.orders);

  await step('open storefront', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Mock Omnichannel Store' })).toBeVisible();
  });

  await step('find customer', async () => {
    await page.getByTestId('customer-query').fill(customer.searchTerm);
    await page.getByTestId('customer-search').click();
    await expect(page.getByTestId('customer-result')).toContainText(customer.id);
  });

  await step('browse catalog', async () => {
    await page.getByTestId('category').selectOption('electronics');
    await page.getByTestId('load-products').click();
    await expect(page.getByTestId('product-result')).toContainText('products loaded');
  });

  await step('check store inventory', async () => {
    await page.getByTestId('check-inventory').click();
    await expect(page.getByTestId('inventory-result')).toContainText('Available at');
  });

  await step('add to cart', async () => {
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-result')).toContainText('CART-');
  });

  await step('track order', async () => {
    await page.getByTestId('order-id').fill(order);
    await page.getByTestId('track-order').click();
    await expect(page.getByTestId('tracking-result')).toContainText(order);
  });

  // Attach step timings so they appear in results/browser-journey.json.
  await testInfo.attach('step-timings-ms', { body: JSON.stringify(timings, null, 2), contentType: 'application/json' });
  console.log(`journey step timings (ms): ${JSON.stringify(timings)}`);
});
