// Safety guard: this framework must never send hundreds of VUs to a system
// nobody authorised. Local targets (localhost / 127.0.0.1 / ::1) are allowed.
// Any other host is REFUSED for load and stress tests unless the operator sets
// CONFIRM_AUTHORIZED_TARGET=true, i.e. explicitly states they have written
// permission to test that environment.
//
// Called from the init context with __VU === 0 (k6's first, options-parsing
// pass), so a refused target fails BEFORE any VU is allocated or any request
// is sent. The existing per-stage abort valves still apply on top of this.

import { TARGET } from '../config.js';

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
  if (!local && !TARGET.confirmedAuthorized) {
    throw new Error(`REFUSED: ${testType} against remote target ${TARGET.baseUrl} (peak ${peakVus} VUs). `
      + 'Only run load/stress tests against systems you have WRITTEN authorisation to test. '
      + 'If you do, re-run with CONFIRM_AUTHORIZED_TARGET=true.');
  }
}
