// Central configuration. Every value can be overridden with an environment
// variable, either exported in the shell, put in .env (loaded by
// scripts/run-k6.js) or passed directly: k6 run -e KEY=value <script>.
//
// TARGET_PROFILE picks which API (and which scenario) is tested:
//   retail-mock  local mock Omnichannel Retail API (default, high load is fine)
//   quickpizza   Grafana's public QuickPizza demo API (load testing permitted;
//                shared demo, so default load is modest)
// A profile only supplies DEFAULTS; any explicit env var still wins.

const env = (key, def) => (__ENV[key] !== undefined && __ENV[key] !== '' ? __ENV[key] : def);
const num = (key, def) => Number(env(key, def));
const bool = (key, def) => String(env(key, def)).toLowerCase() === 'true';

export const PROFILE = env('TARGET_PROFILE', 'retail-mock');

const PROFILES = {
  'retail-mock': {
    baseUrl: 'http://localhost:8080',
    authType: null, // auto: bearer if a token is set
    tokenVar: 'API_TOKEN',
    thinkTime: [0.5, 1.5],
    stages: '10:30s,20:30s,30:30s,50:60s,100:60s,150:60s,200:60s,300:60s,500:60s',
    quickStages: '10:10s,20:10s,30:10s,50:10s,100:10s,150:10s,200:10s,300:10s,500:10s',
    kneeStages: '300:60s,350:60s,400:60s,450:60s,500:60s',
    stressLevels: '100,200,300,500,750,1000',
  },
  quickpizza: {
    baseUrl: 'https://quickpizza.grafana.com',
    authType: 'token', // Authorization: Token <16 chars>
    tokenVar: 'QUICKPIZZA_TOKEN',
    thinkTime: [1, 2],
    stages: '5:30s,10:30s,20:30s,30:30s,50:30s',
    quickStages: '5:10s,10:10s,20:10s',
    kneeStages: '20:30s,30:30s,40:30s,50:30s',
    stressLevels: '25,50,75,100',
  },
};
if (!PROFILES[PROFILE]) throw new Error(`Unknown TARGET_PROFILE "${PROFILE}". Use one of: ${Object.keys(PROFILES).join(', ')}`);
const P = PROFILES[PROFILE];

// ---------------------------------------------------------------------------
// Target API: swap TARGET_BASE_URL to point at an AUTHORIZED environment.
// ---------------------------------------------------------------------------
// Profile-specific token variable first (e.g. QUICKPIZZA_TOKEN), then API_TOKEN.
const token = env(P.tokenVar, env('API_TOKEN', ''));
export const TARGET = {
  profile: PROFILE,
  baseUrl: env('TARGET_BASE_URL', env('BASE_URL', P.baseUrl)).replace(/\/+$/, ''),
  // none | bearer | apikey | token
  authType: env('AUTH_TYPE', P.authType || (token ? 'bearer' : 'none')).toLowerCase(),
  token,
  tokenVar: P.tokenVar,
  apiKeyHeader: env('API_KEY_HEADER', 'x-api-key'),
  requestTimeout: env('REQUEST_TIMEOUT', '10s'),
  // Writes are OFF unless explicitly enabled. Only enable against a target where
  // the write endpoint is sandboxed / idempotent (the local mock is).
  enableWrites: bool('ENABLE_WRITES', false),
  // On HTTP 429, pause this VU for Retry-After seconds (capped) before going on.
  // This is respecting the limit, never bypassing it.
  respectRetryAfter: bool('RESPECT_RETRY_AFTER', true),
  maxBackoffSec: num('MAX_BACKOFF_SEC', 10),
  // Required for load/stress tests against any non-localhost target (utils/safety.js).
  confirmedAuthorized: bool('CONFIRM_AUTHORIZED_TARGET', false),
};

// ---------------------------------------------------------------------------
// Workload model
// ---------------------------------------------------------------------------
// Relative weights of user actions. Each scenario defines its own defaults;
// WEIGHTS overrides them, e.g. WEIGHTS=customer_search:40,product:20,...
export const WEIGHTS_OVERRIDE = __ENV.WEIGHTS ? parseWeights(__ENV.WEIGHTS) : null;

// Think time between actions (seconds). This is what makes a "virtual user"
// behave like a person and controls requests/sec per user.
export const THINK_TIME = { min: num('THINK_TIME_MIN', P.thinkTime[0]), max: num('THINK_TIME_MAX', P.thinkTime[1]) };

// ---------------------------------------------------------------------------
// Load profiles
// ---------------------------------------------------------------------------
// LOAD_PROFILE: full (default) | quick (fast dry-run of the whole pipeline) |
// knee (refinement stages to locate the degradation knee precisely)
const QUICK = env('LOAD_PROFILE', 'full') === 'quick';
const KNEE = env('LOAD_PROFILE', 'full') === 'knee';

export const LOAD = {
  // "VUs:hold" pairs. Each stage: ramp 0 -> VUs, hold, ramp -> 0, cool down.
  stages: parseStages(env('LOAD_STAGES', KNEE ? P.kneeStages : QUICK ? P.quickStages : P.stages)),
  rampUp: env('RAMP_UP', QUICK ? '5s' : '15s'),
  rampDown: env('RAMP_DOWN', '5s'),
  cooldown: env('COOLDOWN', QUICK ? '3s' : '10s'),
};

export const STRESS = {
  // Stair-step without returning to zero: keeps pushing past normal range.
  levels: env('STRESS_LEVELS', P.stressLevels).split(',').map(Number),
  stepRamp: env('STRESS_STEP_RAMP', '15s'),
  stepHold: env('STRESS_STEP_HOLD', '30s'),
  rampDown: env('STRESS_RAMP_DOWN', '15s'),
};
// Recovery phase after the last stress step: drop to a baseline level (default:
// the first stress level) and hold, then compare with that level's original numbers.
STRESS.recovery = {
  enabled: bool('STRESS_RECOVERY', true),
  vus: num('STRESS_RECOVERY_VUS', STRESS.levels[0]),
  ramp: env('STRESS_RECOVERY_RAMP', '15s'),
  hold: env('STRESS_RECOVERY_HOLD', '60s'),
  // "Recovered" = P95 within this factor of the baseline AND error rate below the SLA.
  p95Factor: num('RECOVERY_P95_FACTOR', 1.5),
};

export const SMOKE = { vus: num('SMOKE_VUS', 2), duration: env('SMOKE_DURATION', '30s') };

// ---------------------------------------------------------------------------
// SLA (EXAMPLE values: replace with real business requirements)
// ---------------------------------------------------------------------------
export const SLA = {
  p95Ms: num('SLA_P95_MS', 1000),
  p99Ms: num('SLA_P99_MS', 2000),
  errorRate: num('SLA_ERROR_RATE', 0.01), // app errors, excluding 429
  serverErrorRate: num('SLA_5XX_RATE', 0.005),
  timeoutRate: num('SLA_TIMEOUT_RATE', 0.005),
  // 429s are NOT application errors, but rate-limited customers were not
  // served either, so a stage above this 429 rate is not "within SLA".
  rateLimitRate: num('SLA_429_RATE', 0.01),
};

// Optional CI gate: fail the k6 run (exit code 99) if the SLA is missed at or
// below this concurrency. 0 = disabled (capacity discovery mode).
export const SLA_GATE_VUS = num('SLA_GATE_VUS', 0);

// ---------------------------------------------------------------------------
// Analysis heuristics (how we classify healthy / degraded / breaking)
// ---------------------------------------------------------------------------
export const ANALYSIS = {
  // Latency is "degrading" once P95 exceeds baseline (first stage) x factor
  // AND has grown by at least minDeltaMs (ignores 5ms -> 11ms noise).
  degradationFactor: num('DEGRADATION_FACTOR', 2),
  degradationMinDeltaMs: num('DEGRADATION_MIN_DELTA_MS', 50),
  // SATURATED: a stage realises less than this fraction of the GOODPUT gain its
  // extra users should have produced (or goodput falls). Adding users no longer
  // adds useful work, only queueing.
  throughputScalingMin: num('THROUGHPUT_SCALING_MIN', 0.5),
  // Breaking point: errors or timeouts at or above this rate.
  breakingErrorRate: num('BREAKING_ERROR_RATE', 0.05),
};

// Safety valves: abort instead of hammering a target that is clearly down or
// telling us to back off (HTTP 429). We never try to bypass a rate limit.
export const ABORT = {
  errorRate: num('ABORT_ON_ERROR_RATE', 0.5),
  rateLimitRate: num('ABORT_ON_429_RATE', 0.1),
  stressErrorRate: num('STRESS_ABORT_ERROR_RATE', 0.2),
};

// Each profile writes to its own folder so runs never overwrite each other.
export const RESULTS_DIR = env('RESULTS_DIR', PROFILE === 'retail-mock' ? 'results' : `results/${PROFILE}`);

// ---------------------------------------------------------------------------
function parseStages(spec) {
  return spec.split(',').map((s) => {
    const [vus, hold] = s.trim().split(':');
    return { vus: Number(vus), hold: hold || '60s' };
  });
}

function parseWeights(spec) {
  const out = {};
  for (const part of spec.split(',')) {
    const [name, w] = part.trim().split(':');
    out[name] = Number(w);
  }
  return out;
}

// "1m30s" / "45s" / "500ms" -> seconds
export function seconds(duration) {
  if (typeof duration === 'number') return duration;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m;
  while ((m = re.exec(duration)) !== null) {
    total += Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  }
  return total;
}
