// Custom metrics and threshold wiring.
//
// k6 already records http_req_duration, http_reqs, etc. We add metrics that
// separate *kinds* of failure, because "error rate" alone hides the story:
//   app_errors   - failures that are the application's fault (5xx, timeouts,
//                  connection errors, unexpected 4xx). 429 is EXCLUDED.
//   rate_limited - HTTP 429: the target asked us to slow down. Reported
//                  separately: it is a policy/quota constraint, not a crash.
//   server_errors, timeouts - finer breakdown for the SLA.
//   http_status  - counter tagged by status code => status distribution.

import { Counter, Rate } from 'k6/metrics';

export const requestOk = new Rate('request_ok');
export const appErrors = new Rate('app_errors');
export const rateLimited = new Rate('rate_limited');
export const serverErrors = new Rate('server_errors');
export const timeouts = new Rate('timeouts');
export const httpStatus = new Counter('http_status');

// Case-insensitive response header lookup (k6 canonicalises header names).
export function header(res, name) {
  const want = name.toLowerCase();
  for (const k of Object.keys(res.headers || {})) if (k.toLowerCase() === want) return res.headers[k];
  return undefined;
}

// Status codes we break out individually; anything else is counted as "other".
export const TRACKED_STATUS = ['0', '200', '201', '400', '401', '403', '404', '408', '409', '429', '500', '502', '503', '504'];

const TIMEOUT_ERROR_CODE = 1050; // k6: request timeout

export function isTimeout(res) {
  return res.error_code === TIMEOUT_ERROR_CODE || /timeout/i.test(res.error || '');
}

// Record one response into all custom metrics, using the request's tags.
export function recordResponse(res, tags) {
  const status = res.status;
  const ok = status >= 200 && status < 400;
  const limited = status === 429;
  requestOk.add(ok, tags);
  rateLimited.add(limited, tags);
  appErrors.add(!ok && !limited, tags);
  serverErrors.add(status >= 500, tags);
  timeouts.add(isTimeout(res), tags);
  const code = String(status);
  httpStatus.add(1, Object.assign({}, tags, { status: TRACKED_STATUS.includes(code) ? code : 'other' }));
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
// k6 only reports per-tag breakdowns ("sub-metrics") for tag combinations that
// appear in `thresholds`. We therefore register an always-passing threshold
// for every (stage x metric) pair we want in the summary. These are for
// MEASUREMENT; real pass/fail SLA evaluation happens in summary.js.
const ALWAYS = {
  trend: ['max>=0'],
  rate: ['rate>=0'],
  counter: ['count>=0'],
};

export function measurementThresholds(windows, endpoints) {
  const t = {};
  for (const w of windows) {
    const sel = `stage:${w.name},phase:steady`;
    t[`http_req_duration{${sel}}`] = ALWAYS.trend;
    t[`http_reqs{${sel}}`] = ALWAYS.counter;
    t[`request_ok{${sel}}`] = ALWAYS.rate;
    t[`app_errors{${sel}}`] = ALWAYS.rate;
    t[`rate_limited{${sel}}`] = ALWAYS.rate;
    t[`server_errors{${sel}}`] = ALWAYS.rate;
    t[`timeouts{${sel}}`] = ALWAYS.rate;
    t[`checks{${sel}}`] = ALWAYS.rate;
    for (const code of TRACKED_STATUS.concat('other')) t[`http_status{${sel},status:${code}}`] = ALWAYS.counter;
    for (const ep of endpoints) t[`http_req_duration{${sel},endpoint:${ep}}`] = ALWAYS.trend;
  }
  return t;
}

// Abort thresholds: stop the test when a stage is clearly broken or the target
// is rate limiting us. Evaluated per stage, so earlier healthy stages do not
// dilute the signal.
export function safetyThresholds(windows, { errorRate, rateLimitRate }) {
  const t = {};
  for (const w of windows) {
    const sel = `stage:${w.name},phase:steady`;
    t[`app_errors{${sel}}`] = [...ALWAYS.rate, { threshold: `rate<${errorRate}`, abortOnFail: true, delayAbortEval: '10s' }];
    t[`rate_limited{${sel}}`] = [...ALWAYS.rate, { threshold: `rate<${rateLimitRate}`, abortOnFail: true, delayAbortEval: '10s' }];
  }
  return t;
}

// Optional CI gate: real SLA thresholds (non-zero exit) for stages <= gateVus.
export function slaGateThresholds(windows, sla, gateVus) {
  const t = {};
  if (!gateVus) return t;
  for (const w of windows.filter((x) => x.vus <= gateVus)) {
    const sel = `stage:${w.name},phase:steady`;
    t[`http_req_duration{${sel}}`] = [...ALWAYS.trend, `p(95)<${sla.p95Ms}`, `p(99)<${sla.p99Ms}`];
    t[`app_errors{${sel}}`] = [...ALWAYS.rate, `rate<${sla.errorRate}`];
    t[`server_errors{${sel}}`] = [...ALWAYS.rate, `rate<${sla.serverErrorRate}`];
    t[`timeouts{${sel}}`] = [...ALWAYS.rate, `rate<${sla.timeoutRate}`];
  }
  return t;
}

// Merge threshold maps, concatenating expressions for the same metric key.
export function mergeThresholds(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [k, v] of Object.entries(m)) {
      const existing = out[k] || [];
      out[k] = existing.concat(v.filter((x) => typeof x !== 'string' || !existing.includes(x)));
    }
  }
  return out;
}
