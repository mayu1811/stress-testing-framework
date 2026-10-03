// INCREMENTAL LOAD TEST - capacity discovery.
//
// Default profile (retail-mock; each stage: ramp 0->N, hold, ramp N->0, cool-down):
//   10, 20, 30 VUs for 30s; 50, 100, 150, 200, 300, 500 VUs for 60s.
// Other targets have their own, smaller defaults (see config.js PROFILES).
// Each stage is measured independently (steady-state only), then classified
// HEALTHY / DEGRADED / SATURATED / RATE_LIMITED / BREAKING. The run does NOT fail just
// because higher stages miss the SLA: finding where that happens is the point.
//
// Safety: remote targets are refused unless CONFIRM_AUTHORIZED_TARGET=true
// (utils/safety.js). During the run, a stage aborts the test if >50% of requests fail (target is down)
// or >10% are HTTP 429 (target is telling us to back off). Both configurable.

import { LOAD, ABORT, SLA, SLA_GATE_VUS, TARGET } from './config.js';
import { buildLoadTimeline, useTimeline } from './utils/timeline.js';
import { measurementThresholds, safetyThresholds, slaGateThresholds, mergeThresholds } from './utils/metrics.js';
import { buildSummary } from './utils/summary.js';
import { scenario, ENDPOINT_KEYS, WEIGHTS } from './scenarios/index.js';
import { guardTarget, profileSafetyThresholds } from './utils/safety.js';

guardTarget('load-test', Math.max(...LOAD.stages.map((s) => s.vus)));

const timeline = buildLoadTimeline(LOAD);
useTimeline(timeline.windows);

export const options = {
  scenarios: {
    incremental_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: timeline.k6Stages,
      gracefulRampDown: '5s',
      gracefulStop: '10s',
    },
  },
  // Each VU is one returning customer: keep its cookies across iterations (k6 resets
  // them per iteration by default). Needed for targets behind sticky load balancers.
  noCookiesReset: true,
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: mergeThresholds(
    measurementThresholds(timeline.windows, ENDPOINT_KEYS),
    safetyThresholds(timeline.windows, { errorRate: ABORT.errorRate, rateLimitRate: ABORT.rateLimitRate }),
    slaGateThresholds(timeline.windows, SLA, SLA_GATE_VUS),
    profileSafetyThresholds(),
  ),
};

export function setup() {
  const ctx = scenario.preflight({ testType: 'load-test' });
  console.log(`[${TARGET.profile}] pre-checks passed: ${ctx.summary}`);
  console.log(`Incremental load test: ${LOAD.stages.map((s) => `${s.vus}VU/${s.hold}`).join(' -> ')} (~${Math.round(timeline.totalSec / 60)} min)`);
  return { startedAt: Date.now(), ctx };
}

export default function (data) {
  scenario.weightedAction(data.ctx);
}

export function handleSummary(data) {
  return buildSummary(data, { testType: 'load-test', windows: timeline.windows, profile: LOAD, endpoints: ENDPOINT_KEYS, weights: WEIGHTS });
}
