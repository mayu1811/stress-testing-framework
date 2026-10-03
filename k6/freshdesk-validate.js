// FRESHDESK API VALIDATION - run BEFORE any load against Freshdesk.
//
// Sends exactly ONE authenticated request (GET /api/v2/tickets) and confirms:
//   * the domain is reachable                 (no connection error)
//   * authentication works                    (not 401 / 403)
//   * the endpoint responds                   (HTTP 200)
//   * the response is valid                   (a JSON array of tickets)
// and records the account's rate-limit headers. The API key is never printed
// or written: results contain only whether a key was configured.
//
//   npm run freshdesk:validate
//
// Exit code 0 = validated, 99 = validation failed (reason printed).

import { Rate } from 'k6/metrics';
import { TARGET, RESULTS_DIR } from './config.js';
import { validate } from './scenarios/freshdesk.js';

if (TARGET.profile !== 'freshdesk') throw new Error('Run with TARGET_PROFILE=freshdesk (npm run freshdesk:validate).');

const validationOk = new Rate('freshdesk_validation_ok');

export const options = {
  scenarios: { validate: { executor: 'shared-iterations', vus: 1, iterations: 1 } },
  thresholds: { freshdesk_validation_ok: ['rate==1'] },
};

export function setup() {
  const v = validate();
  // Keep only the count: the report does not need the IDs.
  const result = Object.assign({}, v, { ticketIds: undefined, discoveredTicketIds: (v.ticketIds || []).length });
  if (v.ok) console.log(`[freshdesk] VALIDATION PASSED: HTTP ${v.status} in ${v.latencyMs} ms, ${v.ticketCount} tickets returned, rate limit total=${v.rateLimit.totalPerMinute} remaining=${v.rateLimit.remaining}`);
  else console.error(`[freshdesk] VALIDATION FAILED: ${v.reason}`);
  return { startedAt: Date.now(), validation: result };
}

export default function (data) {
  validationOk.add(data.validation.ok);
}

export function handleSummary(data) {
  const v = (data.setup_data && data.setup_data.validation) || { ok: false, reason: 'setup did not complete' };
  const doc = { meta: { testType: 'validation', generatedAt: new Date().toISOString(), profile: TARGET.profile }, validation: v };
  const stamp = doc.meta.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const files = [`${RESULTS_DIR}/validation-${stamp}.json`, `${RESULTS_DIR}/latest-validation.json`];
  const json = JSON.stringify(doc, null, 2);
  const line = v.ok
    ? `Validation: PASS - ${v.request} -> HTTP ${v.status}, ${v.latencyMs} ms, valid JSON array (${v.ticketCount} tickets)`
    : `Validation: FAIL - ${v.reason}`;
  return { stdout: `\n${line}\nResults written: ${files.join(', ')}\n\n`, [files[0]]: json, [files[1]]: json };
}
