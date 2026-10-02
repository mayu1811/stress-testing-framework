// STRESS TEST - go beyond the normal operating range, in controlled steps,
// until the configured ceiling OR clear breakage, then back off.
//
// Default (retail-mock): 100 -> 200 -> 300 -> 500 -> 750 -> 1000 VUs, 15s ramp
// + 30s hold per step, without returning to zero between steps.
//
// Stops automatically (k6 abortOnFail, evaluated per step) when:
//   * a step's error rate (excluding 429) >= STRESS_ABORT_ERROR_RATE (20%), or
//   * a step's HTTP 429 rate >= ABORT_ON_429_RATE (10%)
// A 429 stop is reported as an EXTERNAL RATE-LIMIT CONSTRAINT. We never try to
// bypass it (no token rotation, no IP spreading): the quota IS the capacity
// limit for this client, and that is the finding.
//
// After the last step the test drops back to STRESS_RECOVERY_VUS (default: the
// first level) for STRESS_RECOVERY_HOLD (60s) and compares that window with the
// original baseline: did latency, errors and throughput return to normal?
// Remote targets are refused unless CONFIRM_AUTHORIZED_TARGET=true.

import { STRESS, ABORT, TARGET } from './config.js';
import { buildStressTimeline, useTimeline } from './utils/timeline.js';
import { measurementThresholds, safetyThresholds, mergeThresholds } from './utils/metrics.js';
import { buildSummary } from './utils/summary.js';
import { scenario, ENDPOINT_KEYS, WEIGHTS } from './scenarios/index.js';
import { guardTarget } from './utils/safety.js';

guardTarget('stress-test', Math.max(...STRESS.levels));

const timeline = buildStressTimeline(STRESS);
useTimeline(timeline.windows);

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: timeline.k6Stages,
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    },
  },
  // Each VU is one returning customer: keep its cookies across iterations (k6 resets
  // them per iteration by default). Needed for targets behind sticky load balancers.
  noCookiesReset: true,
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: mergeThresholds(
    measurementThresholds(timeline.windows, ENDPOINT_KEYS),
    safetyThresholds(timeline.windows, { errorRate: ABORT.stressErrorRate, rateLimitRate: ABORT.rateLimitRate }),
  ),
};

export function setup() {
  const ctx = scenario.preflight({ testType: 'stress-test' });
  console.log(`[${TARGET.profile}] pre-checks passed: ${ctx.summary}`);
  const rec = STRESS.recovery.enabled ? ` -> recovery ${STRESS.recovery.vus} VUs for ${STRESS.recovery.hold}` : '';
  console.log(`Stress test: ${STRESS.levels.join(' -> ')} VUs, ${STRESS.stepHold} per step${rec} (~${Math.round(timeline.totalSec / 60)} min max)`);
  return { startedAt: Date.now(), ctx };
}

export default function (data) {
  scenario.weightedAction(data.ctx);
}

export function handleSummary(data) {
  return buildSummary(data, { testType: 'stress-test', windows: timeline.windows, profile: STRESS, endpoints: ENDPOINT_KEYS, weights: WEIGHTS });
}
