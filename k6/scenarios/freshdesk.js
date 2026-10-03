// TARGET_PROFILE=freshdesk: a real Freshdesk (trial) helpdesk account.
//
// Purpose: validate the framework against a real authenticated SaaS API and
// measure what it actually does at LOW volume: latency, errors and HTTP 429
// rate limiting. It is NOT a capacity test: Freshdesk is a shared production
// service with per-account rate limits, so the peak is capped (FRESHDESK_MAX_VUS)
// and HTTP 429 stops the run (FRESHDESK_ABORT_ON_429 / FRESHDESK_MAX_429_RATE).
//
// READ-ONLY by construction: there are no create / update / delete calls here.
//   tickets      GET /api/v2/tickets?per_page=N     agent opens the ticket list   (40%)
//   contacts     GET /api/v2/contacts?per_page=N    agent looks up customers      (30%)
//   ticket_get   GET /api/v2/tickets/:id            agent opens one ticket        (30%)
// Ticket IDs are discovered by the preflight call; nothing is hard-coded.
//
// Auth: HTTP Basic with the API key as user name and "X" as password
// (Freshdesk API v2). Domain from FRESHDESK_BASE_URL, key from
// FRESHDESK_API_KEY: environment only, never logged or written to results.

import http from 'k6/http';
import { group } from 'k6';
import { Trend } from 'k6/metrics';
import { TARGET } from '../config.js';
import { get, json, authHeaders, observeResponses } from '../utils/api.js';
import { header } from '../utils/metrics.js';
import { any, think, weightedPicker, preflightFail, verify } from './common.js';

export const ENDPOINTS = {
  tickets_list: 'GET /api/v2/tickets',
  contacts_list: 'GET /api/v2/contacts',
  ticket_get: 'GET /api/v2/tickets/:id',
};

export const DEFAULT_WEIGHTS = { tickets: 40, contacts: 30, ticket_get: 30 };

const PAGE_SIZE = Number(__ENV.FRESHDESK_PAGE_SIZE || 10);

// Freshdesk reports its own per-minute quota on every response. Recording it
// shows how close the run came to the limit, without guessing.
const quotaRemaining = new Trend('freshdesk_ratelimit_remaining');
const retryAfter = new Trend('freshdesk_retry_after_sec');

function observe(res) {
  const rem = header(res, 'X-Ratelimit-Remaining');
  if (rem !== undefined && rem !== '' && Number.isFinite(Number(rem))) quotaRemaining.add(Number(rem));
  if (res.status === 429) retryAfter.add(Number(header(res, 'Retry-After')) || 0);
  return res;
}
// Only active when this profile is selected (index.js imports every scenario).
if (TARGET.profile === 'freshdesk') observeResponses(observe);

// Whole-body JSON (the list endpoints return a bare array).
function body(res) {
  try {
    return res.json();
  } catch (e) {
    return undefined;
  }
}

// --- individual steps -------------------------------------------------------
export function listTickets() {
  const res = get(`/api/v2/tickets?per_page=${PAGE_SIZE}`, 'tickets_list');
  verify(res, {
    'tickets: status 200': (r) => r.status === 200,
    'tickets: JSON array': (r) => Array.isArray(body(r)),
  });
  return res;
}

export function listContacts() {
  const res = get(`/api/v2/contacts?per_page=${PAGE_SIZE}`, 'contacts_list');
  verify(res, {
    'contacts: status 200': (r) => r.status === 200,
    'contacts: JSON array': (r) => Array.isArray(body(r)),
  });
  return res;
}

export function getTicket(ctx) {
  const id = any(ctx.ticketIds);
  const res = get(`/api/v2/tickets/${id}`, 'ticket_get');
  verify(res, {
    'ticket: status 200': (r) => r.status === 200,
    'ticket: id matches': (r) => json(r, 'id') === id,
  });
  return res;
}

// --- validation: ONE authenticated GET --------------------------------------
// Returns a result object instead of aborting, so the validation script can
// record WHY it failed. The reason never contains the API key.
export function validate() {
  const out = { ok: false, baseUrl: TARGET.baseUrl, ignoredPath: TARGET.ignoredPath, request: 'GET /api/v2/tickets', authType: 'basic', keyConfigured: !!TARGET.token };
  if (!TARGET.baseUrl) return Object.assign(out, { reason: 'FRESHDESK_BASE_URL is not set (expected https://<your-domain>.freshdesk.com).' });
  if (!TARGET.token) return Object.assign(out, { reason: 'FRESHDESK_API_KEY is not set. Add it to .env (git-ignored).' });

  const res = observe(http.get(`${TARGET.baseUrl}/api/v2/tickets?per_page=${PAGE_SIZE}`, {
    headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'omnichannel-load-test/1.0 (k6)' }, authHeaders()),
    timeout: TARGET.requestTimeout,
    tags: { endpoint: 'preflight', name: 'GET /api/v2/tickets (preflight)' },
  }));
  const code = json(res, 'code'); // Freshdesk error code, e.g. invalid_credentials
  const rl = (h) => (header(res, h) === undefined ? null : Number(header(res, h)));
  Object.assign(out, {
    status: res.status,
    latencyMs: Math.round(res.timings.duration * 10) / 10,
    contentType: header(res, 'Content-Type') || null,
    rateLimit: { totalPerMinute: rl('X-Ratelimit-Total'), remaining: rl('X-Ratelimit-Remaining'), usedByRequest: rl('X-Ratelimit-Used-CurrentRequest') },
  });
  const why = code ? ` (Freshdesk code "${code}")` : '';
  if (res.status === 0) return Object.assign(out, { reason: `${TARGET.baseUrl} unreachable: ${res.error}` });
  if (res.status === 401) return Object.assign(out, { reason: `authentication failed: HTTP 401${why}. Freshdesk rejected FRESHDESK_API_KEY for ${TARGET.baseUrl}. Check the key and that it belongs to this domain.` });
  if (res.status === 403) return Object.assign(out, { reason: `access denied: HTTP 403${why}. The key's agent lacks permission, or API access is disabled for this account.` });
  if (res.status === 404) return Object.assign(out, { reason: `HTTP 404${why}: no Freshdesk API at ${TARGET.baseUrl}/api/v2. Check FRESHDESK_BASE_URL.` });
  if (res.status === 429) return Object.assign(out, { reason: `already rate limited: HTTP 429, Retry-After ${header(res, 'Retry-After') || '?'}s. Wait for the quota to reset; do not retry in a loop.` });
  if (res.status !== 200) return Object.assign(out, { reason: `unexpected HTTP ${res.status}${why} from GET /api/v2/tickets.` });
  const tickets = body(res);
  if (!Array.isArray(tickets)) return Object.assign(out, { reason: `HTTP 200 but the body is not a JSON array (Content-Type ${out.contentType}). FRESHDESK_BASE_URL may not be the helpdesk domain.` });
  const ids = tickets.map((t) => t && t.id).filter((id) => Number.isFinite(id));
  return Object.assign(out, { ok: true, ticketCount: tickets.length, ticketIds: ids, reason: null });
}

// --- scenario interface -----------------------------------------------------
export function preflight() {
  const v = validate();
  if (!v.ok) preflightFail(v.reason);
  const q = v.rateLimit.totalPerMinute === null ? 'not reported' : `${v.rateLimit.remaining}/${v.rateLimit.totalPerMinute} per minute remaining`;
  return {
    ticketIds: v.ticketIds,
    rateLimit: v.rateLimit,
    summary: `reachable, Basic auth OK (HTTP ${v.status}, ${v.latencyMs} ms), ${v.ticketIds.length} ticket IDs discovered, rate limit ${q}, read-only`,
  };
}

const ACTIONS = { tickets: listTickets, contacts: listContacts, ticket_get: getTicket };
// ticket_get needs at least one discovered ticket; a new account may have none.
const pick = weightedPicker(ACTIONS, DEFAULT_WEIGHTS, (name, ctx) => name !== 'ticket_get' || (ctx && ctx.ticketIds && ctx.ticketIds.length > 0));

export function weightedAction(ctx) {
  ACTIONS[pick(ctx)](ctx);
  think();
}

export function fullJourney(ctx) {
  group('1. ticket list', () => listTickets());
  if (ctx && ctx.ticketIds && ctx.ticketIds.length) group('2. open a ticket', () => getTicket(ctx));
  group('3. contact list', () => listContacts());
  think();
}
