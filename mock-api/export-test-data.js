// Writes k6/data/test-data.json: the IDs the load test is allowed to use.
// For a real staging environment, replace that file with IDs of seeded,
// non-production test records (never real customer data).
const fs = require('fs');
const path = require('path');
const data = require('./data');

const sample = (arr, n) => arr.filter((_, i) => i % Math.ceil(arr.length / n) === 0).slice(0, n);

const testData = {
  description: 'Synthetic test data for the local mock API. Replace with seeded staging test records.',
  customers: sample(data.customers, 200).map((c) => ({ id: c.id, searchTerm: c.email.split('@')[0] })),
  products: sample(data.products, 200).map((p) => ({ sku: p.sku, category: p.category })),
  stores: data.stores.map((s) => s.id),
  orders: sample(data.orders, 300).map((o) => o.id),
  categories: [...new Set(data.products.map((p) => p.category))],
};

const out = path.join(__dirname, '..', 'k6', 'data', 'test-data.json');
fs.writeFileSync(out, JSON.stringify(testData, null, 2) + '\n');
console.log(`Wrote ${out}`);
