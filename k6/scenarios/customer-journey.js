// TARGET_PROFILE=retail-mock: the simulated omnichannel retail customer,
// against the local mock API (mock-api/server.js).
//
//   weightedAction() - load & stress: ONE action chosen by weight, then think.
//   fullJourney()    - smoke: search -> customer -> catalog -> product ->
//                      inventory -> cart -> order -> tracking, all validated.

import http from 'k6/http';
import { group } from 'k6';
import { SharedArray } from 'k6/data';
import { TARGET } from '../config.js';
import { get, post, json, authHeaders } from '../utils/api.js';
import { any, think, weightedPicker, preflightFail, verify } from './common.js';

export const ENDPOINTS = {
  customer_search: 'GET /api/customers/search',
  customer_get: 'GET /api/customers/:id',
  product_list: 'GET /api/products',
  product_get: 'GET /api/products/:sku',
  inventory_get: 'GET /api/inventory/:sku',
  cart_create: 'POST /api/carts',
  order_get: 'GET /api/orders/:id',
  order_tracking: 'GET /api/orders/:id/tracking',
};

// An action may issue more than one request (order_status = order + tracking).
export const DEFAULT_WEIGHTS = { customer_search: 40, product: 20, inventory: 20, order_status: 15, cart_write: 5 };

// Loaded once and shared read-only between all VUs (memory efficient).
const DATA = new SharedArray('retail-test-data', () => [JSON.parse(open('../data/test-data.json'))])[0];

// --- individual steps -------------------------------------------------------
export function searchCustomer(customer = any(DATA.customers)) {
  const res = get(`/api/customers/search?q=${encodeURIComponent(customer.searchTerm)}`, 'customer_search');
  verify(res, {
    'search: status 200': (r) => r.status === 200,
    'search: has results': (r) => json(r, 'count') > 0,
  });
  return json(res, 'results.0.id');
}

export function getCustomer(id = any(DATA.customers).id) {
  const res = get(`/api/customers/${id}`, 'customer_get');
  verify(res, {
    'customer: status 200': (r) => r.status === 200,
    'customer: id matches': (r) => json(r, 'id') === id,
  });
  return json(res);
}

export function listProducts(category = any(DATA.categories)) {
  const res = get(`/api/products?category=${category}&limit=20`, 'product_list');
  verify(res, {
    'catalog: status 200': (r) => r.status === 200,
    'catalog: has items': (r) => Array.isArray(json(r, 'items')) && json(r, 'count') > 0,
  });
  return json(res, 'items.0.sku');
}

export function getProduct(sku = any(DATA.products).sku) {
  const res = get(`/api/products/${sku}`, 'product_get');
  verify(res, {
    'product: status 200': (r) => r.status === 200,
    'product: has price': (r) => typeof json(r, 'price') === 'number',
  });
  return res;
}

export function checkInventory(sku = any(DATA.products).sku, storeId = any(DATA.stores)) {
  const res = get(`/api/inventory/${sku}?storeId=${storeId}`, 'inventory_get');
  verify(res, {
    'inventory: status 200': (r) => r.status === 200,
    'inventory: has availability': (r) => typeof json(r, 'available') === 'number',
  });
  return res;
}

export function addToCart(customerId = any(DATA.customers).id, sku = any(DATA.products).sku) {
  if (!TARGET.enableWrites) return null;
  const res = post('/api/carts', { customerId, sku, qty: 1, channel: 'web' }, 'cart_create');
  verify(res, {
    'cart: status 201': (r) => r.status === 201,
    'cart: has cartId': (r) => typeof json(r, 'cartId') === 'string',
  });
  return res;
}

export function trackOrder(orderId = any(DATA.orders)) {
  const order = get(`/api/orders/${orderId}`, 'order_get');
  verify(order, {
    'order: status 200': (r) => r.status === 200,
    'order: has items': (r) => Array.isArray(json(r, 'items')),
  });
  const tracking = get(`/api/orders/${orderId}/tracking`, 'order_tracking');
  verify(tracking, {
    'tracking: status 200': (r) => r.status === 200,
    'tracking: has events': (r) => Array.isArray(json(r, 'events')),
  });
  return tracking;
}

// --- scenario interface -----------------------------------------------------
export function preflight() {
  const h = { headers: Object.assign({ Accept: 'application/json', 'X-Load-Test': 'true' }, authHeaders()), timeout: TARGET.requestTimeout };
  // 1. Reachability
  const health = http.get(`${TARGET.baseUrl}/health`, h);
  if (health.status !== 200) preflightFail(`${TARGET.baseUrl}/health returned ${health.status} ${health.error || ''}. Is the mock running (npm run mock)?`);
  // 2. Authentication
  const c = DATA.customers[0];
  const authProbe = http.get(`${TARGET.baseUrl}/api/customers/${c.id}`, h);
  if (authProbe.status === 401 || authProbe.status === 403) preflightFail(`authentication rejected (${authProbe.status}). Check API_TOKEN / AUTH_TYPE.`);
  // 3. Test data validity
  if (authProbe.status !== 200 || json(authProbe, 'id') !== c.id) preflightFail(`test customer ${c.id} not found (status ${authProbe.status}). Check k6/data/test-data.json.`);
  const p = http.get(`${TARGET.baseUrl}/api/products/${DATA.products[0].sku}`, h);
  if (p.status !== 200) preflightFail(`test product ${DATA.products[0].sku} not found (status ${p.status}).`);
  const o = http.get(`${TARGET.baseUrl}/api/orders/${DATA.orders[0]}`, h);
  if (o.status !== 200) preflightFail(`test order ${DATA.orders[0]} not found (status ${o.status}).`);
  return { summary: `reachable, auth=${TARGET.authType}, test data valid, writes=${TARGET.enableWrites}` };
}

const ACTIONS = {
  customer_search: () => searchCustomer(),
  product: () => (Math.random() < 0.3 ? listProducts() : getProduct()),
  inventory: () => checkInventory(),
  order_status: () => trackOrder(),
  cart_write: () => addToCart(),
};
const pick = weightedPicker(ACTIONS, DEFAULT_WEIGHTS, (name) => name !== 'cart_write' || TARGET.enableWrites);

export function weightedAction(ctx) {
  ACTIONS[pick(ctx)]();
  think();
}

export function fullJourney() {
  const c = any(DATA.customers);
  let customer;
  group('1. find customer', () => {
    const id = searchCustomer(c) || c.id;
    customer = getCustomer(id);
  });
  let sku;
  group('2. browse catalog', () => {
    sku = listProducts() || any(DATA.products).sku;
    getProduct(sku);
  });
  group('3. check store inventory', () => checkInventory(sku, (customer && customer.preferredStoreId) || any(DATA.stores)));
  group('4. add to cart', () => addToCart(c.id, sku));
  group('5. order status & tracking', () => trackOrder());
  think();
}
