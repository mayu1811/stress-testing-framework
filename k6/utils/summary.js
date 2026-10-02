// handleSummary() implementation shared by smoke / load / stress tests.
//
// Turns k6's end-of-test data into:
//   results/<type>-<timestamp>.json         per-stage results + analysis (input to the report)
//   results/<type>-<timestamp>-stages.csv   same table, spreadsheet friendly
//   results/<type>-<timestamp>-k6-raw.json  untouched k6 summary data
//   results/latest-<type>.json              pointer copy of the newest run
// and prints a compact per-stage table to the console.
//
// Zones (first matching rule wins; see README "Healthy vs degraded vs breaking"):
//   BREAKING      error or timeout rate >= BREAKING_ERROR_RATE, or throughput
//                 falling > 10% as users are added
//   RATE_LIMITED  429 rate >= SLA_429_RATE: an external quota is the limit,
//                 not an application failure (reported separately on purpose)
//   SATURATED     goodput no longer scales: < THROUGHPUT_SCALING_MIN of the
//                 expected gain, or goodput lower than the previous stage
//   DEGRADED      latency well above baseline, or SLA missed, but still scaling
//   HEALTHY       SLA met, latency near baseline, goodput scaling with users
// A stress-test RECOVERY window is evaluated separately against its baseline:
//   RECOVERED / NOT_RECOVERED

import { TARGET, THINK_TIME, SLA, ANALYSIS, RESULTS_DIR, STRESS, seconds } from '../config.js';
import { TRACKED_STATUS } from './metrics.js';

const r2 = (x) => (x === undefined || x === null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x === undefined || x === null || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
const isOk = (code) => /^[23]\d\d$/.test(code);

function values(data, name, sel) {
  const m = data.metrics[`${name}{${sel}}`];
  return m ? m.values : {};
}

function stageRow(data, w, elapsedSec, endpointKeys) {
  const sel = `stage:${w.name},phase:steady`;
  const dur = values(data, 'http_req_duration', sel);
  const total = values(data, 'http_reqs', sel).count || 0;
  const ok = values(data, 'request_ok', sel);
  const statusCodes = {};
  for (const code of TRACKED_STATUS.concat('other')) {
    const c = values(data, 'http_status', `${sel},status:${code}`).count;
    if (c) statusCodes[code] = c;
  }
  const endpoints = {};
  for (const ep of endpointKeys) {
    const v = values(data, 'http_req_duration', `${sel},endpoint:${ep}`);
    if (v['p(95)'] !== undefined && v.max > 0) endpoints[ep] = { p50: r2(v.med), p95: r2(v['p(95)']), p99: r2(v['p(99)']) };
  }
  // 4xx other than 429 (bad requests, missing test data, auth problems)
  const client4xx = Object.entries(statusCodes).filter(([c]) => /^4\d\d$/.test(c) && c !== '429').reduce((s, [, n]) => s + n, 0);
  // If the test stopped early (abort threshold), only part of the hold ran:
  // throughput must be divided by the time that actually elapsed.
  const measuredSec = Math.max(0, Math.min(w.holdEnd, elapsedSec) - w.holdStart);
  const partial = measuredSec < w.holdSec - 0.5;
  const secs = partial && measuredSec > 0 ? measuredSec : w.holdSec;
  const checks = values(data, 'checks', sel);
  return {
    stage: w.name,
    vus: w.vus,
    recovery: !!w.recovery,
    holdSec: w.holdSec,
    measuredSec: r2(secs),
    partial,
    reached: total > 0,
    totalRequests: total,
    rps: r2(total / secs),
    // "goodput": only successful responses per second (excludes 429s and errors)
    goodputRps: r2((ok.passes || 0) / secs),
    successful: ok.passes || 0,
    failed: ok.fails || 0,
    errorRate: r4(values(data, 'app_errors', sel).rate || 0),
    failedRate: r4(total ? (ok.fails || 0) / total : 0),
    clientErrorRate: r4(total ? client4xx / total : 0),
    serverErrorRate: r4(values(data, 'server_errors', sel).rate || 0),
    timeoutRate: r4(values(data, 'timeouts', sel).rate || 0),
    rateLimitRate: r4(values(data, 'rate_limited', sel).rate || 0),
    // null (not 0) when a stage recorded no checks at all
    checksPassRate: (checks.passes || 0) + (checks.fails || 0) > 0 ? r4(checks.rate) : null,
    latencyMs: {
      min: r2(dur.min), avg: r2(dur.avg), p50: r2(dur.med), p90: r2(dur['p(90)']),
      p95: r2(dur['p(95)']), p99: r2(dur['p(99)']), max: r2(dur.max),
    },
    statusCodes,
    endpoints,
  };
}

function evaluateSla(row) {
  const v = [];
  if (row.latencyMs.p95 > SLA.p95Ms) v.push(`P95 ${row.latencyMs.p95}ms > ${SLA.p95Ms}ms`);
  if (row.latencyMs.p99 > SLA.p99Ms) v.push(`P99 ${row.latencyMs.p99}ms > ${SLA.p99Ms}ms`);
  if (row.errorRate >= SLA.errorRate) v.push(`error rate ${pct(row.errorRate)} >= ${pct(SLA.errorRate)}`);
  if (row.serverErrorRate >= SLA.serverErrorRate) v.push(`5xx rate ${pct(row.serverErrorRate)} >= ${pct(SLA.serverErrorRate)}`);
  if (row.timeoutRate >= SLA.timeoutRate) v.push(`timeout rate ${pct(row.timeoutRate)} >= ${pct(SLA.timeoutRate)}`);
  if (row.rateLimitRate >= SLA.rateLimitRate) v.push(`HTTP 429 rate ${pct(row.rateLimitRate)} >= ${pct(SLA.rateLimitRate)} (external rate limit)`);
  return { pass: v.length === 0, violations: v };
}

// Error responses = everything that is not 2xx/3xx and not 429.
function errorCodes(row) {
  return Object.fromEntries(Object.entries(row.statusCodes).filter(([c]) => !isOk(c) && c !== '429'));
}

function evaluateRecovery(rec, mainRows) {
  const base = mainRows.find((r) => r.vus === rec.vus) || mainRows[0];
  rec.sla = evaluateSla(rec);
  const p95Ratio = base.latencyMs.p95 ? rec.latencyMs.p95 / base.latencyMs.p95 : null;
  const recovered = p95Ratio !== null && p95Ratio <= STRESS.recovery.p95Factor
    && rec.errorRate < SLA.errorRate && rec.timeoutRate < SLA.timeoutRate;
  rec.zone = recovered ? 'RECOVERED' : 'NOT_RECOVERED';
  rec.flags = [];
  return {
    vus: rec.vus,
    stage: rec.stage,
    baselineStage: base.stage,
    baselineVus: base.vus,
    baseline: { rps: base.rps, goodputRps: base.goodputRps, p50: base.latencyMs.p50, p95: base.latencyMs.p95, p99: base.latencyMs.p99, errorRate: base.errorRate },
    measured: {
      rps: rec.rps, goodputRps: rec.goodputRps, p50: rec.latencyMs.p50, p95: rec.latencyMs.p95, p99: rec.latencyMs.p99,
      errorRate: rec.errorRate, serverErrorRate: rec.serverErrorRate, timeoutRate: rec.timeoutRate,
    },
    p95Ratio: r2(p95Ratio),
    p95FactorAllowed: STRESS.recovery.p95Factor,
    errorsReturnedToZero: rec.errorRate === 0 && rec.timeoutRate === 0,
    recovered,
  };
}

export function analyse(rows) {
  const reached = rows.filter((r) => r.reached && !r.recovery);
  const out = {
    stagesPlanned: rows.filter((r) => !r.recovery).length,
    stagesReached: reached.length,
    baseline: null,
    highestHealthyVus: null,
    maxSlaCompliantVus: null,
    firstSlaBreachVus: null,
    latencyDegradationVus: null,
    saturationVus: null,
    firstError: null,
    materialErrorVus: null,
    rateLimitOnsetVus: null,
    breakingPointVus: null,
    peakThroughput: null,
    peakGoodput: null,
    failureBehaviour: null,
    recovery: null,
  };
  if (!reached.length) return out;

  const base = reached[0];
  out.baseline = { vus: base.vus, p50: base.latencyMs.p50, p95: base.latencyMs.p95, rps: base.rps };
  let slaChainIntact = true;
  let healthyChainIntact = true;
  let prev = null;

  for (const row of reached) {
    row.sla = evaluateSla(row);
    const flags = [];
    const p95 = row.latencyMs.p95;
    const latencyDegraded = p95 > base.latencyMs.p95 * ANALYSIS.degradationFactor && p95 - base.latencyMs.p95 >= ANALYSIS.degradationMinDeltaMs;
    if (latencyDegraded) flags.push('latency_degraded');

    // Fraction of the "expected" GOODPUT gain actually realised vs previous stage.
    row.throughputScaling = null;
    let saturated = false;
    if (prev && prev.goodputRps > 0 && row.vus > prev.vus && !row.partial) {
      row.throughputScaling = r2((row.goodputRps / prev.goodputRps - 1) / (row.vus / prev.vus - 1));
      if (row.throughputScaling < ANALYSIS.throughputScalingMin) saturated = true;
      if (row.goodputRps < prev.goodputRps) flags.push('goodput_falling');
      if (row.rps < prev.rps * 0.9) flags.push('throughput_falling');
    }
    if (saturated) flags.push('saturated');
    if (row.errorRate >= SLA.errorRate) flags.push('material_errors');
    if (row.rateLimitRate > 0) flags.push('rate_limited');
    if (row.timeoutRate > 0) flags.push('timeouts');
    if (!row.sla.pass) flags.push('sla_breach');
    if (row.partial) flags.push('partial_window');

    const breaking = row.errorRate >= ANALYSIS.breakingErrorRate || row.timeoutRate >= ANALYSIS.breakingErrorRate || flags.includes('throughput_falling');
    if (breaking) row.zone = 'BREAKING';
    else if (row.rateLimitRate >= SLA.rateLimitRate) row.zone = 'RATE_LIMITED';
    else if (saturated) row.zone = 'SATURATED';
    else if (latencyDegraded || !row.sla.pass) row.zone = 'DEGRADED';
    else row.zone = 'HEALTHY';
    row.flags = flags;

    const first = (key, cond) => { if (cond && out[key] === null) out[key] = row.vus; };
    first('latencyDegradationVus', latencyDegraded);
    first('saturationVus', saturated);
    first('materialErrorVus', row.errorRate >= SLA.errorRate);
    first('rateLimitOnsetVus', row.rateLimitRate > 0);
    first('breakingPointVus', breaking);
    first('firstSlaBreachVus', !row.sla.pass);
    const errs = errorCodes(row);
    const errCount = Object.values(errs).reduce((s, n) => s + n, 0);
    if (errCount > 0 && !out.firstError) {
      out.firstError = { vus: row.vus, count: errCount, codes: errs, rate: r4(errCount / row.totalRequests) };
    }
    // Highest stage where the SLA held for it AND every stage below it.
    if (slaChainIntact && row.sla.pass) out.maxSlaCompliantVus = row.vus;
    else slaChainIntact = false;
    // Highest stage where it AND every stage below were HEALTHY.
    if (healthyChainIntact && row.zone === 'HEALTHY') out.highestHealthyVus = row.vus;
    else healthyChainIntact = false;
    if (!out.peakThroughput || row.rps > out.peakThroughput.rps) out.peakThroughput = { vus: row.vus, rps: row.rps };
    if (!out.peakGoodput || row.goodputRps > out.peakGoodput.goodputRps) out.peakGoodput = { vus: row.vus, goodputRps: row.goodputRps };
    prev = row;
  }

  // How did the system behave once it produced errors? (evidence only)
  const failing = reached.filter((r) => Object.keys(errorCodes(r)).length > 0);
  if (failing.length) {
    const codes = {};
    failing.forEach((r) => Object.entries(errorCodes(r)).forEach(([c, n]) => { codes[c] = (codes[c] || 0) + n; }));
    const maxLatency = Math.max(...failing.map((r) => r.latencyMs.max));
    const timeoutsSeen = failing.some((r) => r.timeoutRate > 0) || codes['0'] > 0;
    out.failureBehaviour = {
      stages: failing.map((r) => r.vus),
      errorCodes: codes,
      timeoutsObserved: timeoutsSeen,
      maxP99Ms: Math.max(...failing.map((r) => r.latencyMs.p99)),
      maxLatencyMs: maxLatency,
      requestTimeoutSec: seconds(TARGET.requestTimeout),
      // No request came close to the client timeout => nothing hung.
      noHangingRequests: !timeoutsSeen && maxLatency < seconds(TARGET.requestTimeout) * 1000 * 0.5,
    };
  }

  const rec = rows.find((r) => r.recovery);
  if (rec) out.recovery = rec.reached ? evaluateRecovery(rec, reached) : { recovered: null, note: 'recovery window not reached (test stopped early)' };
  return out;
}

function thresholdFailures(data) {
  const failed = [];
  for (const [name, m] of Object.entries(data.metrics)) {
    for (const [expr, t] of Object.entries(m.thresholds || {})) if (!t.ok) failed.push(`${name}: ${expr}`);
  }
  return failed;
}

function toCsv(rows) {
  const cols = ['stage', 'vus', 'holdSec', 'zone', 'slaPass', 'rps', 'goodputRps', 'totalRequests', 'successful', 'failed', 'errorRate',
    'clientErrorRate', 'serverErrorRate', 'timeoutRate', 'rateLimitRate', 'checksPassRate', 'p50', 'p90', 'p95', 'p99', 'min', 'max', 'avg',
    'throughputScaling', 'statusCodes', 'flags'];
  const lines = [cols.join(',')];
  for (const r of rows.filter((x) => x.reached)) {
    const l = r.latencyMs;
    lines.push([r.stage, r.vus, r.holdSec, r.zone, r.sla.pass, r.rps, r.goodputRps, r.totalRequests, r.successful, r.failed, r.errorRate,
      r.clientErrorRate, r.serverErrorRate, r.timeoutRate, r.rateLimitRate, r.checksPassRate, l.p50, l.p90, l.p95, l.p99, l.min, l.max, l.avg,
      r.throughputScaling, `"${Object.entries(r.statusCodes).map(([k, v]) => `${k}:${v}`).join(' ')}"`, `"${(r.flags || []).join(' ')}"`].join(','));
  }
  return lines.join('\n') + '\n';
}

function pad(s, n, right) {
  s = String(s === null || s === undefined ? '-' : s);
  return right ? s.padEnd(n) : s.padStart(n);
}

const codeList = (codes) => Object.entries(codes).map(([c, n]) => `${n} x HTTP ${c === '0' ? '0 (no response)' : c}`).join(', ');

function consoleReport(doc) {
  const L = [];
  L.push('');
  L.push(`== ${doc.meta.testType.toUpperCase()} RESULTS  profile=${doc.meta.target.profile}  target=${doc.meta.target.baseUrl}  duration=${doc.meta.durationSec}s ==`);
  L.push('(steady-state samples only; latency in ms; Err% excludes 429; Chk = response checks passed)');
  L.push([pad('stage', 22, true), pad('VUs', 5), pad('RPS', 8), pad('reqs', 7), pad('P50', 7), pad('P95', 8), pad('P99', 8),
    pad('Err%', 6), pad('4xx%', 5), pad('5xx%', 5), pad('TO%', 5), pad('429%', 5), pad('Chk%', 6), pad('SLA', 5), pad('zone', 13)].join(' '));
  for (const r of doc.stages) {
    if (!r.reached) { L.push(`${pad(r.stage, 22, true)} ${pad(r.vus, 5)}  (not reached)`); continue; }
    const l = r.latencyMs;
    const p = (x) => (x * 100).toFixed(2);
    L.push([pad(r.stage + (r.partial ? '*' : ''), 22, true), pad(r.vus, 5), pad(r.rps, 8), pad(r.totalRequests, 7), pad(l.p50, 7),
      pad(l.p95, 8), pad(l.p99, 8), pad(p(r.errorRate), 6), pad(p(r.clientErrorRate), 5), pad(p(r.serverErrorRate), 5),
      pad(p(r.timeoutRate), 5), pad(p(r.rateLimitRate), 5), pad(r.checksPassRate === null ? '-' : (r.checksPassRate * 100).toFixed(1), 6),
      pad(r.sla.pass ? 'PASS' : 'FAIL', 5), pad(r.zone, 13)].join(' '));
  }
  if (doc.stages.some((r) => r.partial)) L.push('* partial stage: test stopped before the hold completed; RPS uses the time actually measured');
  const a = doc.analysis;
  if (doc.meta.testType === 'smoke-test') {
    const s = doc.stages[0];
    const t = doc.meta.totals;
    L.push('');
    L.push(`Checks passed      : ${t.checksPassRate === null ? '-' : (t.checksPassRate * 100).toFixed(2) + '%'}`);
    L.push(`Metrics collected  : ${s.totalRequests} tagged requests, ${Object.keys(s.endpoints).length} endpoints, status codes ${JSON.stringify(s.statusCodes)}`);
    L.push(`Smoke verdict      : ${doc.thresholdFailures.length ? 'FAIL - fix before running load tests' : 'PASS - safe to run load / stress tests'}`);
  } else {
    const fe = a.firstError;
    const line = (label, value) => L.push(`${label.padEnd(38)}: ${value}`);
    L.push('');
    line('Highest tested healthy stage', `${a.highestHealthyVus ?? 'none'} VUs`);
    line('Highest stage meeting SLA', `${a.maxSlaCompliantVus ?? 'none'} VUs`);
    line('Latency degradation from', a.latencyDegradationVus ?? 'not observed');
    line('Saturation (goodput stops scaling)', a.saturationVus ?? 'not observed');
    line('First error', fe ? `${fe.vus} VUs (${codeList(fe.codes)}, ${pct(fe.rate, 3)})` : 'none observed');
    line(`Material errors (>= SLA ${pct(SLA.errorRate, 1)})`, a.materialErrorVus ?? 'not observed');
    line('Rate limiting (429) from', a.rateLimitOnsetVus ?? 'not observed');
    line(`Formal breaking threshold (>= ${pct(ANALYSIS.breakingErrorRate, 0)})`, a.breakingPointVus ? `reached at ${a.breakingPointVus} VUs` : 'not reached');
    line('Peak throughput / peak goodput', `${a.peakThroughput.rps} req/s @ ${a.peakThroughput.vus} VUs / ${a.peakGoodput.goodputRps} req/s @ ${a.peakGoodput.vus} VUs`);
    if (a.failureBehaviour) {
      const f = a.failureBehaviour;
      line('Failure behaviour', `${codeList(f.errorCodes)}; timeouts ${f.timeoutsObserved ? 'OBSERVED' : 'none'}; max P99 ${f.maxP99Ms} ms; max ${f.maxLatencyMs} ms (client timeout ${f.requestTimeoutSec}s)`);
    }
    if (a.recovery) {
      const r = a.recovery;
      line(`Recovery${r.vus ? ` at ${r.vus} VUs` : ''}`, r.recovered === null ? r.note
        : `${r.recovered ? 'RECOVERED' : 'NOT RECOVERED'} - P95 ${r.measured.p95} ms vs baseline ${r.baseline.p95} ms (x${r.p95Ratio}), errors ${pct(r.measured.errorRate)}, timeouts ${pct(r.measured.timeoutRate)}`);
    }
  }
  if (doc.thresholdFailures.length) {
    L.push('');
    L.push('Thresholds crossed (abort / gate):');
    doc.thresholdFailures.forEach((f) => L.push(`  - ${f}`));
  }
  L.push('');
  L.push(`Results written: ${doc.files.join(', ')}`);
  L.push('');
  return L.join('\n');
}

// endpoints: endpoint keys of the active scenario; weights: its effective action weights.
export function buildSummary(data, { testType, windows, profile, endpoints, weights }) {
  const now = Date.now();
  const durationMs = data.state.testRunDurationMs;
  const startMs = (data.setup_data && data.setup_data.startedAt) || now - durationMs;
  const elapsedSec = (now - startMs) / 1000;
  const rows = windows.map((w) => Object.assign(stageRow(data, w, elapsedSec, endpoints), {
    windowStartMs: Math.round(startMs + w.holdStart * 1000),
    windowEndMs: Math.round(startMs + w.holdEnd * 1000),
    // start of the ramp INTO this window (for recovery-time analysis)
    rampStartMs: Math.round(startMs + w.start * 1000),
  }));
  const analysis = analyse(rows);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${RESULTS_DIR}/${testType}-${stamp}`;
  const files = [`${base}.json`, `${base}-stages.csv`, `${base}-k6-raw.json`, `${RESULTS_DIR}/latest-${testType}.json`];

  const doc = {
    meta: {
      testType,
      generatedAt: new Date(now).toISOString(),
      testStartMs: startMs,
      testEndMs: now,
      durationSec: Math.round(durationMs / 1000),
      target: { profile: TARGET.profile, baseUrl: TARGET.baseUrl, authType: TARGET.authType, authConfigured: !!TARGET.token, enableWrites: TARGET.enableWrites, requestTimeout: TARGET.requestTimeout },
      workload: { weights, thinkTimeSec: THINK_TIME, executor: 'ramping-vus (closed model)' },
      profile,
      sla: SLA,
      analysisConfig: ANALYSIS,
      totals: {
        requests: (data.metrics.http_reqs && data.metrics.http_reqs.values.count) || 0,
        iterations: (data.metrics.iterations && data.metrics.iterations.values.count) || 0,
        checksPassRate: data.metrics.checks ? r4(data.metrics.checks.values.rate) : null,
        maxVus: data.metrics.vus_max ? data.metrics.vus_max.values.max : null,
      },
    },
    stages: rows,
    analysis,
    thresholdFailures: thresholdFailures(data),
    files,
  };

  const json = JSON.stringify(doc, null, 2);
  return {
    stdout: consoleReport(doc),
    [files[0]]: json,
    [files[1]]: toCsv(rows),
    [files[2]]: JSON.stringify(data, null, 2),
    [files[3]]: json,
  };
}
