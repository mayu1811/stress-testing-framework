// Deterministic, synthetic omnichannel retail data set.
// Same seed => same data every run, so the k6 test-data file always matches
// what the mock server serves. No real customer data is used anywhere.

function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261002);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pad = (n, width) => String(n).padStart(width, '0');

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Mia', 'Lucas', 'Zoe', 'Ethan', 'Aria', 'Mason',
  'Isla', 'Leo', 'Nora', 'Kai', 'Ruby', 'Omar', 'Priya', 'Diego', 'Hana', 'Sam'];
const LAST = ['Smith', 'Garcia', 'Chen', 'Patel', 'Johnson', 'Nguyen', 'Brown', 'Lopez', 'Kim',
  'Davis', 'Martin', 'Singh', 'Clark', 'Lewis', 'Walker', 'Young', 'Allen', 'Wright', 'Hill', 'Scott'];
const CATEGORIES = ['apparel', 'footwear', 'electronics', 'home', 'grocery', 'beauty', 'toys', 'outdoor'];
const ADJ = ['Classic', 'Ultra', 'Everyday', 'Pro', 'Eco', 'Smart', 'Premium', 'Compact', 'Deluxe', 'Lite'];
const NOUN = {
  apparel: ['Tee', 'Hoodie', 'Jacket', 'Jeans'], footwear: ['Runner', 'Boot', 'Sandal', 'Sneaker'],
  electronics: ['Earbuds', 'Speaker', 'Charger', 'Tablet'], home: ['Lamp', 'Blender', 'Rug', 'Kettle'],
  grocery: ['Coffee', 'Granola', 'Olive Oil', 'Tea'], beauty: ['Serum', 'Cleanser', 'Lotion', 'Balm'],
  toys: ['Puzzle', 'Robot Kit', 'Plush', 'Blocks'], outdoor: ['Tent', 'Cooler', 'Lantern', 'Backpack'],
};
const CITIES = [['Dallas', 'TX'], ['Austin', 'TX'], ['Chicago', 'IL'], ['Seattle', 'WA'], ['Denver', 'CO'],
  ['Atlanta', 'GA'], ['Miami', 'FL'], ['Phoenix', 'AZ'], ['Boston', 'MA'], ['Columbus', 'OH']];
const CHANNELS = ['web', 'mobile_app', 'store', 'call_center'];
const FULFILLMENT = ['ship_to_home', 'buy_online_pickup_in_store', 'ship_from_store'];
const ORDER_STATUS = ['placed', 'picking', 'shipped', 'out_for_delivery', 'delivered', 'ready_for_pickup'];
const TIERS = ['standard', 'silver', 'gold', 'platinum'];

const stores = [];
for (let i = 1; i <= 25; i++) {
  const [city, state] = CITIES[(i - 1) % CITIES.length];
  stores.push({ id: `STR-${pad(i, 3)}`, name: `${city} #${i}`, city, state });
}

const customers = [];
for (let i = 1; i <= 1000; i++) {
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  customers.push({
    id: `CUST-${pad(i, 6)}`,
    firstName,
    lastName,
    email: `${firstName}.${lastName}.${i}@example.com`.toLowerCase(),
    phone: `555-${pad(int(100, 999), 3)}-${pad(i, 4)}`,
    loyaltyTier: pick(TIERS),
    preferredStoreId: pick(stores).id,
    createdAt: new Date(Date.UTC(2020, 0, 1) + int(0, 2000) * 86400000).toISOString(),
  });
}

const products = [];
for (let i = 1; i <= 500; i++) {
  const category = CATEGORIES[(i - 1) % CATEGORIES.length];
  products.push({
    sku: `SKU-${100000 + i}`,
    name: `${pick(ADJ)} ${pick(NOUN[category])}`,
    category,
    brand: `Brand ${String.fromCharCode(65 + int(0, 11))}`,
    price: Math.round(int(299, 49999)) / 100,
    rating: Math.round((3 + rand() * 2) * 10) / 10,
  });
}

const orders = [];
for (let i = 1; i <= 3000; i++) {
  const customer = pick(customers);
  const items = [];
  for (let j = 0; j < int(1, 4); j++) {
    const p = pick(products);
    items.push({ sku: p.sku, name: p.name, qty: int(1, 3), unitPrice: p.price });
  }
  const total = Math.round(items.reduce((s, it) => s + it.qty * it.unitPrice, 0) * 100) / 100;
  orders.push({
    id: `ORD-${700000 + i}`,
    customerId: customer.id,
    channel: pick(CHANNELS),
    fulfillment: pick(FULFILLMENT),
    status: pick(ORDER_STATUS),
    storeId: pick(stores).id,
    items,
    total,
    placedAt: new Date(Date.UTC(2026, 6, 1) + int(0, 90) * 86400000).toISOString(),
  });
}

// Inventory is derived (not stored) from a hash of sku + store, so it is
// stable without materialising 12,500 records.
function inventoryFor(sku, storeId) {
  let h = 2166136261;
  for (const c of `${sku}|${storeId}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const onHand = (h >>> 0) % 120;
  const reserved = Math.min(onHand, (h >>> 8) % 6);
  return { onHand, reserved, available: onHand - reserved };
}

module.exports = {
  stores,
  customers,
  products,
  orders,
  inventoryFor,
  byId: {
    customer: new Map(customers.map((c) => [c.id, c])),
    product: new Map(products.map((p) => [p.sku, p])),
    order: new Map(orders.map((o) => [o.id, o])),
    store: new Map(stores.map((s) => [s.id, s])),
  },
};
