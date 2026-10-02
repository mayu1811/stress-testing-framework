// SMOKE TEST - "is it safe and meaningful to run the big test?"
// 1-5 VUs for ~30s, walking the full customer journey. Verifies:
//   * the API is reachable                      (setup: scenario preflight)
//   * authentication works                      (setup: authenticated call is not 401/403)
//   * test data is valid                        (setup: known / discovered records exist)
//   * response structure is correct             (checks on every step)
//   * metrics are being collected               (summary shows non-zero samples)
// Strict thresholds: any failure => non-zero exit code. Run this first, always.

import { SMOKE, SLA, TARGET } from './config.js';
import { buildSmokeTimeline, useTimeline } from './utils/timeline.js';
import { measurementThresholds } from './utils/metrics.js';
import { buildSummary } from './utils/summary.js';
import { scenario, ENDPOINT_KEYS, WEIGHTS } from './scenarios/index.js';

const timeline = buildSmokeTimeline(SMOKE);
useTimeline(timeline.windows);

export const options = {
  scenarios: {
    smoke: { executor: 'constant-vus', vus: SMOKE.vus, duration: SMOKE.duration },
  },
  // Each VU is one returning customer: keep its cookies across iterations (k6 resets
  // them per iteration by default). Needed for targets behind sticky load balancers.
  noCookiesReset: true,
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: Object.assign(measurementThresholds(timeline.windows, ENDPOINT_KEYS), {
    checks: ['rate>0.99'],
    app_errors: ['rate<0.01'],
    rate_limited: ['rate==0'],
    http_req_duration: [`p(95)<${SLA.p95Ms}`],
  }),
};

export function setup() {
  const ctx = scenario.preflight({ testType: 'smoke-test' });
  console.log(`[${TARGET.profile}] pre-checks passed: ${ctx.summary}`);
  return { startedAt: Date.now(), ctx };
}

export default function (data) {
  scenario.fullJourney(data.ctx);
}

export function handleSummary(data) {
  return buildSummary(data, { testType: 'smoke-test', windows: timeline.windows, profile: SMOKE, endpoints: ENDPOINT_KEYS, weights: WEIGHTS });
}
