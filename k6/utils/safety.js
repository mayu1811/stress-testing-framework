// Safety guard: this framework must never send hundreds of VUs to a system
// nobody authorised. Local targets (localhost / 127.0.0.1 / ::1) are allowed.
// Any other host is REFUSED for load and stress tests unless the operator sets
// CONFIRM_AUTHORIZED_TARGET=true, i.e. explicitly states they have written
// permission to test that environment.
//
// Called from the init context with __VU === 0 (k6's first, options-parsing
// pass), so a refused target fails BEFORE any VU is allocated or any request
// is sent. The existing per-stage abort valves still apply on top of this.
//
// TARGET_PROFILE=freshdesk (a real SaaS account) gets extra, stricter rules:
// credentials must be present, stress tests are refused outright, the peak is
// capped at FRESHDESK_MAX_VUS, and HTTP 429 can stop the whole run.

import { TARGET, FRESHDESK } from '../config.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export function targetHost(url) {
  const m = /^[a-z]+:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

export function isLocalTarget(url) {
  const host = targetHost(url);
  return LOCAL_HOSTS.includes(host) || host.startsWith('127.');
}

export function guardTarget(testType, peakVus) {
  if (__VU !== 0) return; // print and check once, not once per VU
  const local = isLocalTarget(TARGET.baseUrl);
  console.log(`Target   : ${TARGET.baseUrl} (${local ? 'local' : 'REMOTE'})`);
  console.log(`Profile  : ${TARGET.profile}`);
  console.log(`Test     : ${testType}`);
  console.log(`Peak VUs : ${peakVus}`);
  if (TARGET.profile === 'freshdesk') guardFreshdesk(testType, peakVus);
  if (!local && !TARGET.confirmedAuthorized) {
    throw new Error(`REFUSED: ${testType} against remote target ${TARGET.baseUrl} (peak ${peakVus} VUs). `
      + 'Only run load/stress tests against systems you have WRITTEN authorisation to test. '
      + 'If you do, re-run with CONFIRM_AUTHORIZED_TARGET=true.');
  }
}

// Never prints the API key: only whether it is set.
function guardFreshdesk(testType, peakVus) {
  if (!TARGET.baseUrl) {
    throw new Error('REFUSED: FRESHDESK_BASE_URL is not set (expected https://<your-domain>.freshdesk.com). Add it to .env.');
  }
  if (TARGET.ignoredPath) console.log(`Note     : path "${TARGET.ignoredPath}" in FRESHDESK_BASE_URL ignored; API calls go to ${TARGET.baseUrl}/api/v2`);
  if (!TARGET.token) throw new Error('REFUSED: FRESHDESK_API_KEY is not set. Add it to .env (git-ignored); never commit it.');
  console.log('Auth     : HTTP Basic, key from FRESHDESK_API_KEY (value not shown)');
  if (testType === 'stress-test') {
    throw new Error('REFUSED: stress tests are not allowed against Freshdesk. It is a real SaaS account: use the controlled profile (npm run freshdesk).');
  }
  if (peakVus > FRESHDESK.maxVus) {
    throw new Error(`REFUSED: peak ${peakVus} VUs exceeds FRESHDESK_MAX_VUS=${FRESHDESK.maxVus}. Freshdesk is tested at low volume only.`);
  }
  console.log(`429 stop : ${FRESHDESK.abortOn429 ? `abort when HTTP 429 rate >= ${FRESHDESK.max429Rate * 100}% (run or stage)` : 'disabled (FRESHDESK_ABORT_ON_429=false): 429s recorded only'}`);
}

// Run-wide 429 stop for Freshdesk, on top of the per-stage valves (which only
// see steady-state samples). Empty for every other profile.
export function profileSafetyThresholds() {
  if (TARGET.profile !== 'freshdesk' || !FRESHDESK.abortOn429) return {};
  return { rate_limited: [{ threshold: `rate<${FRESHDESK.max429Rate}`, abortOnFail: true, delayAbortEval: '10s' }] };
}
