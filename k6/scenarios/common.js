// Building blocks shared by every target scenario.
//
// A scenario module exports the same interface, so the smoke / load / stress
// scripts never need to know which API they are testing:
//   ENDPOINTS        { key: 'METHOD /path/template' } - per-endpoint metrics
//   DEFAULT_WEIGHTS  { action: weight }              - traffic mix
//   preflight()      run once in setup(): reachability, auth, test data.
//                    Returns context (e.g. discovered IDs) passed to every VU.
//   weightedAction(ctx)  one weighted user action (load / stress)
//   fullJourney(ctx)     every step in order, used by the smoke test

import { sleep, check } from 'k6';
import exec from 'k6/execution';
import { THINK_TIME, WEIGHTS_OVERRIDE } from '../config.js';
import { currentStageTags } from '../utils/timeline.js';

export const any = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function think() {
  sleep(THINK_TIME.min + Math.random() * (THINK_TIME.max - THINK_TIME.min));
}

// Returns a function that picks an action name according to weights.
// `available(name)` lets a scenario drop actions it cannot run (e.g. writes
// disabled, or the target has no data for that action).
export function weightedPicker(actions, defaultWeights, available = () => true) {
  const weights = WEIGHTS_OVERRIDE || defaultWeights;
  let cache = null;
  return function pick(ctx) {
    if (!cache) {
      const active = Object.entries(weights).filter(([n, w]) => w > 0 && actions[n] && available(n, ctx));
      if (!active.length) exec.test.abort(`No runnable actions for weights ${JSON.stringify(weights)}`);
      cache = { active, total: active.reduce((s, [, w]) => s + w, 0) };
    }
    let r = Math.random() * cache.total;
    for (const [name, w] of cache.active) {
      if ((r -= w) < 0) return name;
    }
    return cache.active[cache.active.length - 1][0];
  };
}

// check() with the current stage/phase tags. k6 does not copy request tags to
// checks, so without this the per-stage `checks{stage,phase}` sub-metric would
// be empty and the per-stage validation rate meaningless.
export function verify(res, assertions) {
  return check(res, assertions, currentStageTags());
}

// Abort the whole test from setup() with a clear, actionable message.
export function preflightFail(msg) {
  exec.test.abort(`PRE-CHECK FAILED: ${msg}`);
}
