// TARGET_PROFILE=quickpizza: Grafana's public QuickPizza demo API
// (https://quickpizza.grafana.com). Grafana explicitly permits load tests
// against it; it is a SHARED demo, so the default profile peaks at 50 VUs.
//
// Workload, mapped to the omnichannel retail journey:
//   recommend   POST /api/pizza           personalised recommendation / search  (40%)
//   menu        GET  /api/ingredients/:t  catalog browse                         (20%)
//   pizza_get   GET  /api/pizza/:id       look up a previous result ("order")    (15%)
//   doughs      GET  /api/doughs          catalog reference data                 (10%)
//   tools       GET  /api/tools           catalog reference data                 (10%)
//   quotes      GET  /api/quotes          content                                (5%)
// POST /api/pizza is QuickPizza's normal recommendation call (used by Grafana's
// own examples). Ratings (real writes) are deliberately not exercised.
//
// Auth: "Authorization: Token <16 chars>". Any 16-character value is accepted;
// set QUICKPIZZA_TOKEN in .env.

import http from 'k6/http';
import { group } from 'k6';
import { TARGET } from '../config.js';
import { get, postQuery, json, authHeaders } from '../utils/api.js';
import { any, think, weightedPicker, preflightFail, verify } from './common.js';

export const ENDPOINTS = {
  pizza_recommend: 'POST /api/pizza',
  pizza_get: 'GET /api/pizza/:id',
  ingredients: 'GET /api/ingredients/:type',
  doughs: 'GET /api/doughs',
  tools: 'GET /api/tools',
  quotes: 'GET /api/quotes',
};

export const DEFAULT_WEIGHTS = { recommend: 40, menu: 20, pizza_get: 15, doughs: 10, tools: 10, quotes: 5 };

const INGREDIENT_TYPES = ['olive_oil', 'tomato', 'mozzarella', 'topping'];
let lastPizzaId = null; // per-VU: the most recent recommendation this "customer" got

function restrictions() {
  return {
    maxCaloriesPerSlice: any([500, 800, 1000]),
    mustBeVegetarian: Math.random() < 0.2,
    excludedIngredients: Math.random() < 0.3 ? ['anchovies'] : [],
    excludedTools: [],
    maxNumberOfToppings: any([3, 5, 6]),
    minNumberOfToppings: 2,
  };
}

export function recommend() {
  const res = postQuery('/api/pizza', restrictions(), 'pizza_recommend');
  verify(res, {
    'recommend: status 200': (r) => r.status === 200,
    'recommend: has pizza': (r) => typeof json(r, 'pizza.name') === 'string',
  });
  const id = json(res, 'pizza.id');
  if (id) lastPizzaId = id;
  return id;
}

export function getPizza(id = lastPizzaId) {
  if (!id) return recommend(); // nothing to look up yet: behave like a new visitor
  const res = get(`/api/pizza/${id}`, 'pizza_get');
  verify(res, {
    'pizza: status 200': (r) => r.status === 200,
    'pizza: id matches': (r) => json(r, 'id') === id,
  });
  return res;
}

function listCheck(res, label, field) {
  verify(res, {
    [`${label}: status 200`]: (r) => r.status === 200,
    [`${label}: has ${field}`]: (r) => Array.isArray(json(r, field)),
  });
  return res;
}

export const menu = () => listCheck(get(`/api/ingredients/${any(INGREDIENT_TYPES)}`, 'ingredients'), 'ingredients', 'ingredients');
export const doughs = () => listCheck(get('/api/doughs', 'doughs'), 'doughs', 'doughs');
export const tools = () => listCheck(get('/api/tools', 'tools'), 'tools', 'tools');
export const quotes = () => listCheck(get('/api/quotes', 'quotes'), 'quotes', 'quotes');

// --- scenario interface -----------------------------------------------------
export function preflight() {
  const h = (withAuth) => ({ headers: Object.assign({ Accept: 'application/json' }, withAuth ? authHeaders() : {}), timeout: TARGET.requestTimeout });
  if (!TARGET.token) preflightFail('QUICKPIZZA_TOKEN is not set. Put any 16-character value in .env (QUICKPIZZA_TOKEN=<16 characters>)');
  if (TARGET.token.length !== 16) preflightFail(`QUICKPIZZA_TOKEN must be exactly 16 characters (got ${TARGET.token.length}).`);
  const ok = http.get(`${TARGET.baseUrl}/api/doughs`, h(true));
  if (ok.status === 0) preflightFail(`${TARGET.baseUrl} unreachable: ${ok.error}`);
  if (ok.status === 401 || ok.status === 403) preflightFail(`authentication rejected (${ok.status}). Check QUICKPIZZA_TOKEN / AUTH_TYPE=token.`);
  if (ok.status !== 200 || !Array.isArray(json(ok, 'doughs'))) preflightFail(`unexpected response from /api/doughs: ${ok.status}`);
  // Confirms auth is actually enforced (i.e. our header is what made it work).
  const anon = http.get(`${TARGET.baseUrl}/api/doughs`, h(false));
  return { summary: `reachable, Token auth OK (anonymous request -> ${anon.status}), ${json(ok, 'doughs').length} doughs` };
}

const ACTIONS = { recommend, menu, pizza_get: () => getPizza(), doughs, tools, quotes };
const pick = weightedPicker(ACTIONS, DEFAULT_WEIGHTS);

export function weightedAction(ctx) {
  ACTIONS[pick(ctx)]();
  think();
}

export function fullJourney() {
  group('1. browse menu', () => {
    doughs();
    menu();
    tools();
  });
  group('2. get recommendation', () => recommend());
  group('3. look up previous recommendation', () => getPizza());
  group('4. content', () => quotes());
  think();
}
