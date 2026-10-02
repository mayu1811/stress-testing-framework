// Local mock "Omnichannel Retail API" used as a SAFE load-test target.
//
// It is deliberately NOT infinitely fast. It models the constraints real
// retail back-ends have, so the load-testing methodology has something real
// to discover:
//   * a database connection pool with a fixed size and an acquire timeout
//     (exhaustion => HTTP 503)
//   * a slow legacy "store inventory system" dependency with limited
//     concurrency (saturation => HTTP 504)
//   * an optional token-bucket rate limiter (=> HTTP 429 + Retry-After)
//   * optional bearer/API-key authentication (=> HTTP 401)
// Every constraint is configurable through MOCK_* environment variables.
// Nothing here is destructive: carts live in a bounded in-memory map.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');
const { loadEnv } = require('../scripts/load-env');

loadEnv();
const data = require('./data');

const num = (key, def) => (process.env[key] !== undefined && process.env[key] !== '' ? Number(process.env[key]) : def);
const CFG = {
  port: num('MOCK_PORT', 8080),
  host: process.env.MOCK_HOST || '127.0.0.1',
  token: process.env.MOCK_API_TOKEN || '', // empty => no auth required
  dbPoolSize: num('MOCK_DB_POOL_SIZE', 8),
  dbAcquireTimeoutMs: num('MOCK_DB_ACQUIRE_TIMEOUT_MS', 1500),
  inventoryConcurrency: num('MOCK_INVENTORY_CONCURRENCY', 5),
  inventoryLatencyMinMs: num('MOCK_INVENTORY_LATENCY_MIN_MS', 40),
  inventoryLatencyMaxMs: num('MOCK_INVENTORY_LATENCY_MAX_MS', 90),
  inventoryAcquireTimeoutMs: num('MOCK_INVENTORY_ACQUIRE_TIMEOUT_MS', 2000),
  latencyMultiplier: num('MOCK_LATENCY_MULTIPLIER', 1),
  rateLimitRps: num('MOCK_RATE_LIMIT_RPS', 0), // 0 => disabled
  rateLimitBurst: num('MOCK_RATE_LIMIT_BURST', 0), // 0 => same as RPS
  maxCarts: num('MOCK_MAX_CARTS', 5000),
  telemetryFile: process.env.MOCK_TELEMETRY_FILE || path.join(__dirname, '..', 'results', 'mock-server-telemetry.csv'),
};

// ---------------------------------------------------------------------------
// Constrained resources
// ---------------------------------------------------------------------------
class ResourceTimeoutError extends Error {}

// A counting semaphore with a FIFO wait queue and an acquire timeout:
// the same behaviour as a JDBC/pg connection pool or an HTTP client pool.
class Pool {
  constructor(name, size, acquireTimeoutMs) {
    Object.assign(this, { name, size, acquireTimeoutMs, inUse: 0, queue: [], timeouts: 0 });
  }

  acquire() {
    if (this.inUse < this.size) {
      this.inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(waiter), 1);
        this.timeouts++;
        reject(new ResourceTimeoutError(this.name));
      }, this.acquireTimeoutMs);
      this.queue.push(waiter);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // hand the slot straight to the next waiter
    } else {
      this.inUse--;
    }
  }

  async use(minMs, maxMs) {
    await this.acquire();
    try {
      await sleep(jitter(minMs, maxMs));
    } finally {
      this.release();
    }
  }
}

const db = new Pool('database-connection-pool', CFG.dbPoolSize, CFG.dbAcquireTimeoutMs);
const inventorySystem = new Pool('store-inventory-system', CFG.inventoryConcurrency, CFG.inventoryAcquireTimeoutMs);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => (min + Math.random() * (max - min)) * CFG.latencyMultiplier;

// Token bucket keyed by client credential (or IP). All k6 VUs share one
// credential, so in practice this behaves like a per-tenant API quota.
const buckets = new Map();
function rateLimit(key) {
  if (!CFG.rateLimitRps) return { allowed: true };
  const burst = CFG.rateLimitBurst || CFG.rateLimitRps;
  const now = Date.now();
  const b = buckets.get(key) || { tokens: burst, ts: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.ts) / 1000) * CFG.rateLimitRps);
  b.ts = now;
  buckets.set(key, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, remaining: Math.floor(b.tokens), limit: CFG.rateLimitRps };
  }
  return { allowed: false, remaining: 0, limit: CFG.rateLimitRps };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const carts = new Map();
let cartSeq = 0;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new HttpError(413, 'payload too large');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

const routes = [
  ['GET', /^\/health$/, async () => ({ status: 'ok', uptimeSec: Math.round(process.uptime()) })],

  ['GET', /^\/api\/customers\/search$/, async (req, m, url) => {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    if (q.length < 3) throw new HttpError(400, 'query parameter q must be at least 3 characters');
    await db.use(15, 35); // "LIKE" search across customers: the heaviest read
    const results = data.customers
      .filter((c) => c.email.startsWith(q) || c.phone === q || c.lastName.toLowerCase() === q)
      .slice(0, 10)
      .map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, email: c.email, loyaltyTier: c.loyaltyTier }));
    return { query: q, count: results.length, results };
  }],

  ['GET', /^\/api\/customers\/([\w-]+)$/, async (req, m) => {
    await db.use(3, 8);
    const c = data.byId.customer.get(m[1]);
    if (!c) throw new HttpError(404, 'customer not found');
    return c;
  }],

  ['GET', /^\/api\/products$/, async (req, m, url) => {
    const category = url.searchParams.get('category');
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 20);
    await db.use(10, 25);
    const items = data.products.filter((p) => !category || p.category === category).slice(0, limit);
    return { category: category || 'all', count: items.length, items };
  }],

  ['GET', /^\/api\/products\/([\w-]+)$/, async (req, m) => {
    await db.use(4, 10);
    const p = data.byId.product.get(m[1]);
    if (!p) throw new HttpError(404, 'product not found');
    return p;
  }],

  ['GET', /^\/api\/inventory\/([\w-]+)$/, async (req, m, url) => {
    const storeId = url.searchParams.get('storeId');
    if (!data.byId.product.has(m[1])) throw new HttpError(404, 'product not found');
    if (!data.byId.store.has(storeId)) throw new HttpError(400, 'unknown storeId');
    await db.use(2, 5);
    // Real-time stock lives in a slower downstream store system.
    await inventorySystem.use(CFG.inventoryLatencyMinMs, CFG.inventoryLatencyMaxMs);
    const nearby = data.stores.filter((s) => s.id !== storeId).slice(0, 3)
      .map((s) => ({ storeId: s.id, ...data.inventoryFor(m[1], s.id) }));
    return { sku: m[1], storeId, ...data.inventoryFor(m[1], storeId), nearbyStores: nearby, checkedAt: new Date().toISOString() };
  }],

  ['POST', /^\/api\/carts$/, async (req) => {
    const body = await readJson(req);
    const product = data.byId.product.get(body.sku);
    if (!data.byId.customer.has(body.customerId) || !product || !(body.qty >= 1 && body.qty <= 10)) {
      throw new HttpError(400, 'customerId, sku and qty (1-10) are required');
    }
    await db.use(8, 15);
    const cart = {
      cartId: `CART-${++cartSeq}`,
      customerId: body.customerId,
      channel: body.channel || 'web',
      items: [{ sku: product.sku, qty: body.qty, unitPrice: product.price }],
      subtotal: Math.round(product.price * body.qty * 100) / 100,
      createdAt: new Date().toISOString(),
    };
    carts.set(cart.cartId, cart);
    if (carts.size > CFG.maxCarts) carts.delete(carts.keys().next().value); // bounded memory
    return [201, cart];
  }],

  ['GET', /^\/api\/carts\/([\w-]+)$/, async (req, m) => {
    await db.use(2, 5);
    const cart = carts.get(m[1]);
    if (!cart) throw new HttpError(404, 'cart not found');
    return cart;
  }],

  ['GET', /^\/api\/orders\/([\w-]+)$/, async (req, m) => {
    await db.use(4, 10);
    const o = data.byId.order.get(m[1]);
    if (!o) throw new HttpError(404, 'order not found');
    return o;
  }],

  ['GET', /^\/api\/orders\/([\w-]+)\/tracking$/, async (req, m) => {
    await db.use(4, 10);
    const o = data.byId.order.get(m[1]);
    if (!o) throw new HttpError(404, 'order not found');
    const steps = ['placed', 'picking', 'shipped', 'out_for_delivery', 'delivered'];
    const reached = Math.max(0, steps.indexOf(o.status));
    return {
      orderId: o.id,
      status: o.status,
      fulfillment: o.fulfillment,
      carrier: o.fulfillment === 'buy_online_pickup_in_store' ? null : 'UPS',
      trackingNumber: `1Z${o.id.replace(/\D/g, '')}`,
      events: steps.slice(0, reached + 1).map((s, i) => ({
        status: s,
        at: new Date(Date.parse(o.placedAt) + i * 6 * 3600000).toISOString(),
      })),
    };
  }],
];

// ---------------------------------------------------------------------------
// Telemetry: the server-side view we would normally get from APM / Prometheus.
// Only available because we own this mock; see README for real environments.
// ---------------------------------------------------------------------------
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const win = { count: 0, s2xx: 0, s4xx: 0, s429: 0, s5xx: 0, latencySum: 0 };
let inflight = 0;
let lastCpu = process.cpuUsage();
let lastTick = process.hrtime.bigint();
let latestSnapshot = {};

const TELEMETRY_COLUMNS = ['timestamp', 'epoch_ms', 'rps', 'inflight', 'avg_server_ms', 's2xx', 's4xx', 's429', 's5xx',
  'db_in_use', 'db_pool_size', 'db_queue', 'db_acquire_timeouts', 'inv_in_use', 'inv_capacity', 'inv_queue',
  'inv_acquire_timeouts', 'cpu_pct', 'rss_mb', 'heap_used_mb', 'event_loop_p99_ms'];

if (CFG.telemetryFile !== 'off') {
  fs.mkdirSync(path.dirname(CFG.telemetryFile), { recursive: true });
  if (!fs.existsSync(CFG.telemetryFile)) fs.writeFileSync(CFG.telemetryFile, TELEMETRY_COLUMNS.join(',') + '\n');
}

setInterval(() => {
  const now = process.hrtime.bigint();
  const elapsedMicros = Number(now - lastTick) / 1000;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastTick = now;
  const mem = process.memoryUsage();
  latestSnapshot = {
    timestamp: new Date().toISOString(),
    epoch_ms: Date.now(),
    rps: win.count,
    inflight,
    avg_server_ms: win.count ? +(win.latencySum / win.count).toFixed(1) : 0,
    s2xx: win.s2xx, s4xx: win.s4xx, s429: win.s429, s5xx: win.s5xx,
    db_in_use: db.inUse, db_pool_size: db.size, db_queue: db.queue.length, db_acquire_timeouts: db.timeouts,
    inv_in_use: inventorySystem.inUse, inv_capacity: inventorySystem.size, inv_queue: inventorySystem.queue.length,
    inv_acquire_timeouts: inventorySystem.timeouts,
    cpu_pct: +(((cpu.user + cpu.system) / elapsedMicros) * 100).toFixed(1),
    rss_mb: +(mem.rss / 1048576).toFixed(1),
    heap_used_mb: +(mem.heapUsed / 1048576).toFixed(1),
    event_loop_p99_ms: +(loopDelay.percentile(99) / 1e6).toFixed(1),
  };
  loopDelay.reset();
  Object.keys(win).forEach((k) => (win[k] = 0));
  if (CFG.telemetryFile !== 'off' && latestSnapshot.rps > 0) {
    fs.appendFile(CFG.telemetryFile, TELEMETRY_COLUMNS.map((c) => latestSnapshot[c]).join(',') + '\n', () => {});
  }
}, 1000).unref();

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function isAuthorized(req) {
  if (!CFG.token) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return bearer === CFG.token || req.headers['x-api-key'] === CFG.token;
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  inflight++;
  res.on('finish', () => {
    inflight--;
    win.count++;
    win.latencySum += Number(process.hrtime.bigint() - started) / 1e6;
    const s = res.statusCode;
    if (s === 429) win.s429++;
    else if (s >= 500) win.s5xx++;
    else if (s >= 400) win.s4xx++;
    else win.s2xx++;
  });

  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX_HTML);
    }
    if (url.pathname === '/__metrics') return send(res, 200, { config: { ...CFG, token: CFG.token ? '***' : '' }, latest: latestSnapshot });

    if (url.pathname.startsWith('/api/')) {
      if (!isAuthorized(req)) return send(res, 401, { error: 'unauthorized', message: 'missing or invalid credentials' });
      const key = req.headers.authorization || req.headers['x-api-key'] || req.socket.remoteAddress;
      const rl = rateLimit(key);
      if (!rl.allowed) {
        return send(res, 429, { error: 'rate_limited', message: `limit is ${rl.limit} requests/second` },
          { 'Retry-After': '1', 'X-RateLimit-Limit': String(rl.limit), 'X-RateLimit-Remaining': '0' });
      }
    }

    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (m && req.method === method) {
        const out = await handler(req, m, url);
        const [status, payload] = Array.isArray(out) ? out : [200, out];
        return send(res, status, payload);
      }
    }
    return send(res, 404, { error: 'not_found', message: `${req.method} ${url.pathname} does not exist` });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: 'request_error', message: err.message });
    if (err instanceof ResourceTimeoutError) {
      // Pool exhaustion => 503 (shed load). Downstream saturation => 504 (gateway timeout).
      const status = err.message === 'store-inventory-system' ? 504 : 503;
      return send(res, status, { error: 'resource_unavailable', resource: err.message, message: 'timed out waiting for resource' });
    }
    console.error(err);
    return send(res, 500, { error: 'internal_error' });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(CFG.port, CFG.host, () => {
  console.log(`Mock Omnichannel Retail API listening on http://${CFG.host}:${CFG.port}`);
  console.log(`  auth required        : ${CFG.token ? 'yes (MOCK_API_TOKEN)' : 'no'}`);
  console.log(`  db pool              : ${CFG.dbPoolSize} connections, acquire timeout ${CFG.dbAcquireTimeoutMs} ms`);
  console.log(`  inventory dependency : ${CFG.inventoryConcurrency} concurrent, ${CFG.inventoryLatencyMinMs}-${CFG.inventoryLatencyMaxMs} ms`);
  console.log(`  rate limit           : ${CFG.rateLimitRps ? CFG.rateLimitRps + ' req/s' : 'disabled'}`);
  console.log(`  telemetry            : ${CFG.telemetryFile}`);
});
