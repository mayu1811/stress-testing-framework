// Thin HTTP client around k6/http. Responsibilities:
//   * build the URL from TARGET_BASE_URL (so the target is swappable)
//   * attach auth headers from environment variables (never hard-coded)
//   * tag every request with endpoint + stage + phase
//   * record every response into the custom metrics
//   * on HTTP 429, back off for Retry-After seconds (respect, never bypass)

import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import encoding from 'k6/encoding';
import { TARGET } from '../config.js';
import { currentStageTags } from './timeline.js';
import { recordResponse, header } from './metrics.js';

// Logical endpoint names, registered by the active scenario. The `name` tag
// groups URLs like /api/customers/CUST-000123 into one series, avoiding
// high-cardinality metrics.
let ENDPOINT_NAMES = {};
export function registerEndpoints(map) {
  ENDPOINT_NAMES = map;
}

// Optional per-scenario hook, called for every response BEFORE any 429
// back-off sleep (a test aborted mid-sleep would otherwise never see it).
let responseObserver = null;
export function observeResponses(fn) {
  responseObserver = fn;
}

export function authHeaders() {
  if (!TARGET.token || TARGET.authType === 'none') return {};
  if (TARGET.authType === 'apikey') return { [TARGET.apiKeyHeader]: TARGET.token };
  if (TARGET.authType === 'token') return { Authorization: `Token ${TARGET.token}` };
  // Freshdesk style: the API key is the user name, "X" the (ignored) password.
  if (TARGET.authType === 'basic') return { Authorization: `Basic ${encoding.b64encode(`${TARGET.token}:X`)}` };
  return { Authorization: `Bearer ${TARGET.token}` };
}

let seq = 0;
function params(endpoint, extraHeaders) {
  const tags = Object.assign({ endpoint, name: ENDPOINT_NAMES[endpoint] || endpoint }, currentStageTags());
  return {
    tags,
    timeout: TARGET.requestTimeout,
    headers: Object.assign(
      {
        Accept: 'application/json',
        'User-Agent': 'omnichannel-load-test/1.0 (k6)',
        // Lets the target's logs/APM filter out synthetic traffic.
        'X-Load-Test': 'true',
        'X-Request-Id': `k6-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${++seq}`,
      },
      authHeaders(),
      extraHeaders || {},
    ),
  };
}

function afterResponse(res, tags) {
  recordResponse(res, tags);
  if (responseObserver) responseObserver(res);
  if (res.status === 429 && TARGET.respectRetryAfter) {
    const retryAfter = Number(header(res, 'Retry-After')) || 1;
    sleep(Math.min(retryAfter, TARGET.maxBackoffSec));
  }
  return res;
}

export function get(path, endpoint) {
  const p = params(endpoint);
  return afterResponse(http.get(`${TARGET.baseUrl}${path}`, p), p.tags);
}

// POST that only READS (e.g. a search with a JSON body). Not gated by ENABLE_WRITES.
export function postQuery(path, body, endpoint) {
  const p = params(endpoint, { 'Content-Type': 'application/json' });
  return afterResponse(http.post(`${TARGET.baseUrl}${path}`, JSON.stringify(body), p), p.tags);
}

// POST that CREATES something. Scenarios must check TARGET.enableWrites first.
export function post(path, body, endpoint) {
  const p = params(endpoint, {
    'Content-Type': 'application/json',
    // Safe retries on real systems: the server can de-duplicate on this key.
    'Idempotency-Key': `k6-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${seq + 1}`,
  });
  return afterResponse(http.post(`${TARGET.baseUrl}${path}`, JSON.stringify(body), p), p.tags);
}

// Safe JSON accessor for checks (a 503 HTML page must not throw).
export function json(res, selector) {
  try {
    return res.json(selector);
  } catch (e) {
    return undefined;
  }
}
