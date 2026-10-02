#!/usr/bin/env python3
"""
Turn k6 result files into a Markdown performance report + PNG charts.

Inputs (defaults = newest runs of the chosen --profile):
  results/latest-load-test.json      (required)
  results/latest-stress-test.json    (optional, includes the recovery window)
  results/latest-smoke-test.json     (optional)
  results/knee/latest-load-test.json (optional, LOAD_PROFILE=knee refinement run)
  results/mock-server-telemetry.csv  (optional: server-side metrics, local mock only)

Output:
  reports/performance-report.md            (retail-mock)
  reports/<profile>-performance-report.md  (other profiles)
  reports/charts/*.png

Every number in the report is read from those files. Nothing is invented:
if a metric was not collected, the report says so.

Usage:
  python scripts/generate-report.py
  python scripts/generate-report.py --profile quickpizza
  python scripts/generate-report.py --load results/load-test-2026-...json --no-stress --out reports/run-2.md
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.ticker
    from matplotlib.patches import Patch
    HAVE_MPL = True
except ImportError:  # charts are optional; the Markdown report still works
    HAVE_MPL = False

# Chart palette (validated categorical order; text never wears series colour)
SURFACE, INK, INK2, GRID, REF = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e0", "#8a8984"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
ZONE_FILL = {"DEGRADED": "#fbe7b5", "SATURATED": "#f7d2b4", "RATE_LIMITED": "#e4def7", "BREAKING": "#f8d0cf"}
ZONE_ORDER = ("DEGRADED", "SATURATED", "RATE_LIMITED", "BREAKING")


# --------------------------------------------------------------------------- io
def load_json(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def load_telemetry(path):
    if not path or not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        rows = []
        for r in csv.DictReader(f):
            try:
                rows.append({k: (v if k == "timestamp" else float(v)) for k, v in r.items()})
            except (TypeError, ValueError):
                continue
        return rows


def window_rows(telemetry, start_ms, end_ms):
    return [t for t in telemetry if start_ms <= t["epoch_ms"] <= end_ms]


def telemetry_for(stage, telemetry):
    """Aggregate server telemetry samples inside a stage's steady-state window."""
    rows = window_rows(telemetry, stage["windowStartMs"], stage["windowEndMs"])
    if not rows:
        return None
    avg = lambda k: sum(r[k] for r in rows) / len(rows)
    mx = lambda k: max(r[k] for r in rows)
    return {
        "samples": len(rows),
        "cpu_avg": avg("cpu_pct"),
        "rss_max": mx("rss_mb"),
        "loop_p99_max": mx("event_loop_p99_ms"),
        "inflight_avg": avg("inflight"),
        "inflight_max": mx("inflight"),
        "server_ms_avg": avg("avg_server_ms"),
        "db_util_avg": avg("db_in_use") / max(1, rows[0]["db_pool_size"]) * 100,
        "db_queue_avg": avg("db_queue"),
        "db_queue_max": mx("db_queue"),
        "db_timeouts": rows[-1]["db_acquire_timeouts"] - rows[0]["db_acquire_timeouts"],
        "inv_util_avg": avg("inv_in_use") / max(1, rows[0]["inv_capacity"]) * 100,
        "inv_queue_avg": avg("inv_queue"),
        "inv_queue_max": mx("inv_queue"),
        "inv_timeouts": rows[-1]["inv_acquire_timeouts"] - rows[0]["inv_acquire_timeouts"],
    }


def stage_telemetry(doc, telemetry):
    if not doc or not telemetry:
        return {}
    out = {s["stage"]: telemetry_for(s, telemetry) for s in doc["stages"] if s["reached"]}
    return {k: v for k, v in out.items() if v}


def recovery_time(stress, telemetry, telem):
    """Seconds from the moment load started dropping until the server's queues were
    empty and its average latency was back near the baseline stage's, sustained for 5 s."""
    rec = next((s for s in stress["stages"] if s.get("recovery") and s["reached"]), None)
    if not rec or not telemetry or "rampStartMs" not in rec:
        return None
    base_stage = stress["analysis"]["recovery"]["baselineStage"]
    base = telem.get(base_stage)
    if not base:
        return None
    limit = max(base["server_ms_avg"] * 2, base["server_ms_avg"] + 20)
    rows = window_rows(telemetry, rec["rampStartMs"], rec["windowEndMs"])
    for i, r in enumerate(rows):
        nxt = rows[i:i + 5]
        if len(nxt) == 5 and all(x["db_queue"] == 0 and x["inv_queue"] == 0 and x["avg_server_ms"] <= limit for x in nxt):
            return {"seconds": round((r["epoch_ms"] - rec["rampStartMs"]) / 1000), "serverMsLimit": round(limit, 1),
                    "baselineServerMs": round(base["server_ms_avg"], 1), "rampSec": round((rec["windowStartMs"] - rec["rampStartMs"]) / 1000)}
    return {"seconds": None, "serverMsLimit": round(limit, 1), "baselineServerMs": round(base["server_ms_avg"], 1),
            "rampSec": round((rec["windowStartMs"] - rec["rampStartMs"]) / 1000)}


# ----------------------------------------------------------------------- format
def pct(x, digits=2):
    return "-" if x is None else f"{x * 100:.{digits}f}%"


def ms(x):
    return "-" if x is None else (f"{x:,.0f}" if x >= 100 else f"{x:,.1f}")


def num(x, digits=1):
    return "-" if x is None else f"{x:,.{digits}f}"


def vus(x, none="not observed"):
    return none if x is None else f"{x} VUs"


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def reached(doc):
    """Main (scaling) stages only: excludes the stress recovery window."""
    return [s for s in doc["stages"] if s["reached"] and not s.get("recovery")] if doc else []


def ts(ms_epoch):
    return datetime.fromtimestamp(ms_epoch / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def code_list(codes):
    return ", ".join(f"{n:,} x HTTP {'0 (no response)' if c == '0' else c}" for c, n in codes.items())


def stage_by_vus(stages, v):
    return next((s for s in stages if s["vus"] == v), None)


# ----------------------------------------------------------------------- charts
def style(ax, title, ylabel):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", color=INK, fontsize=12, fontweight="bold", pad=34)
    ax.set_xlabel("Concurrent virtual users (stage)", color=INK2, fontsize=9)
    ax.set_ylabel(ylabel, color=INK2, fontsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=8)


def zone_bands(ax, stages):
    seen = set()
    for i, s in enumerate(stages):
        if s.get("zone") in ZONE_FILL:
            ax.axvspan(i - 0.5, i + 0.5, color=ZONE_FILL[s["zone"]], alpha=0.55, linewidth=0, zorder=0)
            seen.add(s["zone"])
    return [Patch(facecolor=ZONE_FILL[z], alpha=0.55, label=f"{z.replace('_', '-').title()} zone") for z in ZONE_ORDER if z in seen]


def ref_line(ax, y, label):
    ax.axhline(y, color=REF, linestyle=(0, (4, 3)), linewidth=1.2, zorder=1)
    ax.text(-0.45, y, f" {label}", color=INK2, fontsize=8, va="bottom", ha="left")


def line_chart(path, stages, series, title, ylabel, ref=None, yfmt=None, extra_legend=True):
    if not HAVE_MPL or not stages:
        return None
    fig, ax = plt.subplots(figsize=(8, 4.2), dpi=130)
    fig.patch.set_facecolor(SURFACE)
    x = list(range(len(stages)))
    style(ax, title, ylabel)
    patches = zone_bands(ax, stages)
    handles = []
    for i, (label, values, *kind) in enumerate(series):
        if kind == ["reference"]:  # dashed grey guide line, not a data series
            h, = ax.plot(x, values, color=REF, linewidth=1.2, linestyle=(0, (4, 3)), label=label, zorder=2)
            handles.append(h)
            continue
        h, = ax.plot(x, values, color=SERIES[i], linewidth=2, marker="o", markersize=6,
                     markeredgecolor=SURFACE, markeredgewidth=1.5, label=label, zorder=3)
        handles.append(h)
        last = [v for v in values if v is not None]
        if last and len(series) <= 4:  # direct-label the last point only
            ax.annotate(yfmt(last[-1]) if yfmt else f"{last[-1]:,.0f}", (x[len(last) - 1], last[-1]),
                        textcoords="offset points", xytext=(6, 4), fontsize=8, color=INK)
    if ref:
        ref_line(ax, ref[0], ref[1])
    ax.set_xticks(x, [str(s["vus"]) for s in stages])
    ax.set_xlim(-0.5, len(stages) - 0.5)
    ax.set_ylim(bottom=0)
    if yfmt:
        ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: yfmt(v)))
    legend_items = (handles if len(series) > 1 else []) + (patches if extra_legend else [])
    if legend_items:
        ax.legend(handles=legend_items, frameon=False, fontsize=8, loc="lower left", bbox_to_anchor=(0, 1.0),
                  ncol=min(4, len(legend_items)), labelcolor=INK2, borderaxespad=0.2)
    fig.tight_layout()
    fig.savefig(path, facecolor=SURFACE)
    plt.close(fig)
    return path


def make_charts(doc, charts_dir, prefix, sla):
    stages = reached(doc)
    if not stages:
        return {}
    os.makedirs(charts_dir, exist_ok=True)
    p = lambda name: os.path.join(charts_dir, f"{prefix}-{name}.png")
    L = lambda key: [s["latencyMs"][key] for s in stages]
    base_rps_per_vu = stages[0]["rps"] / stages[0]["vus"] if stages[0]["vus"] else 0
    out = {
        "p95": line_chart(p("p95-latency"), stages, [("P95", L("p95"))], "P95 latency vs concurrent users", "milliseconds",
                          ref=(sla["p95Ms"], f"SLA P95 {sla['p95Ms']} ms")),
        "p99": line_chart(p("p99-latency"), stages, [("P99", L("p99"))], "P99 latency vs concurrent users", "milliseconds",
                          ref=(sla["p99Ms"], f"SLA P99 {sla['p99Ms']} ms")),
        "errors": line_chart(p("error-rate"), stages,
                             [("App error rate (excl. 429)", [s["errorRate"] for s in stages]),
                              ("HTTP 429 rate", [s["rateLimitRate"] for s in stages])],
                             "Error rate vs concurrent users", "% of requests",
                             ref=(sla["errorRate"], f"SLA error {pct(sla['errorRate'], 1)}"),
                             yfmt=lambda v: f"{v * 100:.1f}%"),
        "throughput": line_chart(p("throughput"), stages,
                                 [("All responses", [s["rps"] for s in stages]),
                                  ("Successful (goodput)", [s.get("goodputRps", s["rps"]) for s in stages]),
                                  ("Linear scaling from baseline", [round(base_rps_per_vu * s["vus"], 1) for s in stages], "reference")],
                                 "Throughput vs concurrent users", "requests / second"),
        "percentiles": line_chart(p("latency-percentiles"), stages,
                                  [("P50", L("p50")), ("P95", L("p95")), ("P99", L("p99"))],
                                  "Latency percentiles vs concurrent users", "milliseconds"),
    }
    endpoints = sorted({ep for s in stages for ep in s.get("endpoints", {})})
    if endpoints:
        out["endpoints"] = line_chart(p("endpoint-p95"), stages,
                                      [(ep, [s["endpoints"].get(ep, {}).get("p95") for s in stages]) for ep in endpoints[:8]],
                                      "P95 latency by endpoint", "milliseconds", extra_legend=False)
    return {k: v for k, v in out.items() if v}


def chart_md(charts, key, alt, report_dir):
    path = charts.get(key)
    if not path:
        return ""
    return f"![{alt}]({os.path.relpath(path, report_dir).replace(os.sep, '/')})\n"


# --------------------------------------------------------------------- analysis
def first_error_text(doc, label):
    fe = doc["analysis"].get("firstError") if doc else None
    if not fe:
        return None
    return f"{fe['vus']} VUs in the {label} ({code_list(fe['codes'])}, {pct(fe['rate'], 3)} of requests)"


def material_error_text(doc, label):
    a = doc["analysis"] if doc else {}
    v = a.get("materialErrorVus")
    if v is None:
        return None
    s = stage_by_vus(reached(doc), v)
    errs = {c: n for c, n in s["statusCodes"].items() if not c.startswith(("2", "3")) and c != "429"}
    return f"{v} VUs in the {label} ({pct(s['errorRate'])} errors: {code_list(errs)})"


def resource_saturation(stages, telem, key, threshold=95):
    """First stage where a resource's average utilisation reached the threshold."""
    for s in stages:
        t = telem.get(s["stage"])
        if t and t[key] >= threshold:
            return s, t
    return None, None


def bottleneck_indicators(doc, telem):
    """Evidence-based hints. Each item cites the data it came from."""
    out = []
    stages = reached(doc)
    a = doc["analysis"]
    if not stages:
        return out
    if a.get("saturationVus") is not None:
        s = stage_by_vus(stages, a["saturationVus"])
        out.append(f"**Goodput saturation at {s['vus']} VUs**: adding users realised only "
                   f"{num((s.get('throughputScaling') or 0) * 100, 0)}% of the expected goodput gain while P95 rose to "
                   f"{ms(s['latencyMs']['p95'])} ms. This is the signature of a fixed-capacity resource (pool, thread, CPU, "
                   f"downstream quota) where requests start queueing.")
    for code, meaning in (("503", "service unavailable / load shedding, typically connection-pool exhaustion"),
                          ("504", "gateway timeout: a downstream dependency is not answering in time")):
        for s in stages:
            n = s["statusCodes"].get(code, 0)
            if n:
                out.append(f"**HTTP {code} from {s['vus']} VUs** ({n:,} responses, {pct(n / s['totalRequests'], 3)}): {meaning}.")
                break
    if a.get("rateLimitOnsetVus") is not None:
        out.append(f"**HTTP 429 from {a['rateLimitOnsetVus']} VUs**: the target enforces a request quota. This is a policy "
                   f"limit, not an application failure.")
    first, last = stages[0], stages[-1]
    growth = []
    for ep, v in last.get("endpoints", {}).items():
        b = first.get("endpoints", {}).get(ep)
        if b and b["p95"]:
            growth.append((v["p95"] / b["p95"], ep, b["p95"], v["p95"]))
    growth.sort(reverse=True)
    if growth and growth[0][0] >= doc["meta"]["analysisConfig"]["degradationFactor"]:
        g, ep, b, v = growth[0]
        others = [x for x in growth[1:] if x[0] < doc["meta"]["analysisConfig"]["degradationFactor"]]
        out.append(f"**Slowest-degrading endpoint: `{ep}`**: P95 went from {ms(b)} ms at {first['vus']} VUs to {ms(v)} ms "
                   f"at {last['vus']} VUs ({g:.1f}x)" + (f", while {len(others)} other endpoints stayed below "
                   f"{doc['meta']['analysisConfig']['degradationFactor']:.0f}x." if others else "."))
    if telem:
        for key, label, qkey, tkey in (("inv_util_avg", "Store-inventory dependency", "inv_queue_max", "inv_timeouts"),
                                       ("db_util_avg", "DB connection pool", "db_queue_max", "db_timeouts")):
            s, t = resource_saturation(stages, telem, key)
            if s:
                out.append(f"**{label} saturated from {s['vus']} VUs** (server telemetry): average utilisation "
                           f"{num(t[key], 0)}%, wait queue up to {num(t[qkey], 0)}, {num(t[tkey], 0)} acquire timeouts in the stage.")
            else:
                peak = max((telem[x["stage"]] for x in stages if telem.get(x["stage"])), key=lambda t: t[key], default=None)
                if peak:
                    out.append(f"{label} did **not** saturate in this test (peak stage-average utilisation {num(peak[key], 0)}%).")
        hot = [s for s in stages if telem.get(s["stage"]) and (telem[s["stage"]]["cpu_avg"] > 85 or telem[s["stage"]]["loop_p99_max"] > 200)]
        if hot:
            t = telem[hot[0]["stage"]]
            out.append(f"**Application CPU / event-loop pressure from {hot[0]['vus']} VUs**: CPU avg {num(t['cpu_avg'], 0)}%, "
                       f"event-loop delay p99 up to {ms(t['loop_p99_max'])} ms.")
        else:
            peak = max((telem[s["stage"]] for s in stages if telem.get(s["stage"])), key=lambda t: t["cpu_avg"], default=None)
            if peak:
                out.append(f"Application CPU was **not** the limiting factor: peak stage-average CPU {num(peak['cpu_avg'], 0)}% "
                           f"of one core, event-loop p99 at most {ms(max(telem[s['stage']]['loop_p99_max'] for s in stages if telem.get(s['stage'])))} ms.")
    if not out:
        out.append("No bottleneck signature was observed in the tested range. The system was not pushed to its limit; "
                   "extend the profile (higher VUs or a stress test).")
    return out


def stress_stage_narrative(stages, telem):
    """Per stage: which constrained resources were saturated (>=95%) or high (>=80%)."""
    lines = []
    for s in stages:
        t = telem.get(s["stage"])
        if not t:
            continue
        parts = []
        for key, label, qkey, tkey, code in (("inv_util_avg", "inventory dependency", "inv_queue_max", "inv_timeouts", "504"),
                                             ("db_util_avg", "DB pool", "db_queue_max", "db_timeouts", "503")):
            u = t[key]
            if u >= 95:
                state = "**saturated**"
            elif u >= 80:
                state = "high"
            else:
                continue
            extra = f", {num(t[tkey], 0)} acquire timeouts" + (f" (-> HTTP {code})" if t[tkey] > 0 else "")
            parts.append(f"{label} {state} ({num(u, 0)}% utilisation, queue up to {num(t[qkey], 0)}{extra})")
        if parts:
            lines.append(f"- **{s['vus']} VUs:** " + "; ".join(parts) + f"; CPU {num(t['cpu_avg'], 0)}%.")
    return lines


def graceful_failure_text(doc):
    f = doc["analysis"].get("failureBehaviour")
    if not f:
        return None
    parts = [f"errors were {code_list(f['errorCodes'])} (across {', '.join(map(str, f['stages']))} VUs)"]
    parts.append("**no client timeouts**" if not f["timeoutsObserved"] else "**client timeouts occurred**")
    parts.append(f"P99 stayed bounded at <= {ms(f['maxP99Ms'])} ms")
    parts.append(f"the slowest single request took {ms(f['maxLatencyMs'])} ms against a {f['requestTimeoutSec']:.0f} s client timeout")
    verdict = ("The system **failed gracefully**: it rejected excess work quickly with explicit errors instead of hanging."
               if f["noHangingRequests"] else "Some requests approached or hit the client timeout: failure was **not** fully graceful.")
    return "; ".join(parts) + ". " + verdict


# ------------------------------------------------------------------------ tables
def results_table(stages):
    rows = []
    for s in stages:
        l = s["latencyMs"]
        rows.append([f"{s['vus']}{'*' if s.get('partial') else ''}", num(s["rps"]), num(s.get("goodputRps")), f"{s['totalRequests']:,}",
                     f"{s['successful']:,}", f"{s['failed']:,}", ms(l["p50"]), ms(l["p90"]), ms(l["p95"]), ms(l["p99"]), ms(l["min"]),
                     ms(l["max"]), pct(s["errorRate"]), pct(s.get("clientErrorRate")), pct(s["serverErrorRate"]), pct(s["timeoutRate"]),
                     pct(s["rateLimitRate"]), pct(s.get("checksPassRate"), 1), "PASS" if s["sla"]["pass"] else "FAIL", f"**{s['zone']}**"])
    return table(["VUs", "RPS", "Goodput", "Total req", "OK", "Failed", "P50", "P90", "P95", "P99", "Min", "Max",
                  "Error %", "4xx %", "5xx %", "Timeout %", "429 %", "Checks", "SLA", "Zone"], rows)


def status_table(stages):
    codes = sorted({c for s in stages for c in s["statusCodes"]}, key=lambda c: (c == "other", c))
    rows = [[s["vus"]] + [f"{s['statusCodes'].get(c, 0):,}" for c in codes] for s in stages]
    return table(["VUs"] + [("no response (0)" if c == "0" else c) for c in codes], rows)


def endpoint_table(stages, key="p95"):
    eps = sorted({ep for s in stages for ep in s.get("endpoints", {})})
    rows = [[s["vus"]] + [ms(s["endpoints"].get(ep, {}).get(key)) for ep in eps] for s in stages]
    return table(["VUs"] + [f"`{e}`" for e in eps], rows)


def endpoint_p95_p99_table(stages):
    eps = sorted({ep for s in stages for ep in s.get("endpoints", {})})
    rows = [[f"`{ep}`"] + [f"{ms(s['endpoints'].get(ep, {}).get('p95'))} / {ms(s['endpoints'].get(ep, {}).get('p99'))}" for s in stages]
            for ep in eps]
    return table(["Endpoint (P95 / P99 ms)"] + [f"{s['vus']} VUs" for s in stages], rows)


def telemetry_table(stages, telem):
    rows = []
    for s in stages:
        t = telem.get(s["stage"])
        if not t:
            continue
        rows.append([s["vus"], num(t["cpu_avg"], 0) + "%", num(t["rss_max"], 0), ms(t["loop_p99_max"]), num(t["inflight_max"], 0),
                     num(t["db_util_avg"], 0) + "%", num(t["db_queue_max"], 0), num(t["db_timeouts"], 0),
                     num(t["inv_util_avg"], 0) + "%", num(t["inv_queue_max"], 0), num(t["inv_timeouts"], 0)])
    if not rows:
        return None
    return table(["VUs", "CPU avg (1 core)", "RSS MB max", "Event-loop p99 ms", "In-flight max", "DB pool util", "DB queue max",
                  "DB acquire timeouts", "Inventory dep util", "Inv queue max", "Inv timeouts"], rows)


def stress_combined_table(stages, telem):
    rows = []
    for s in stages:
        t = telem.get(s["stage"]) or {}
        g = lambda k, f=num, *a: f(t[k], *a) if k in t else "Not measured"
        rows.append([s["vus"], f"{num(s['rps'])} / {num(s.get('goodputRps'))}", ms(s["latencyMs"]["p95"]), ms(s["latencyMs"]["p99"]),
                     pct(s["errorRate"]), pct(s["serverErrorRate"]), pct(s["timeoutRate"]),
                     (num(t["db_util_avg"], 0) + "%") if t else "Not measured", g("db_queue_max", num, 0),
                     (num(t["inv_util_avg"], 0) + "%") if t else "Not measured", g("inv_queue_max", num, 0),
                     (num(t["cpu_avg"], 0) + "%") if t else "Not measured", (num(t["rss_max"], 0) + " MB") if t else "Not measured",
                     f"**{s['zone']}**"])
    return table(["VUs", "Throughput / goodput (req/s)", "P95", "P99", "Error %", "5xx %", "Timeout %", "DB pool util", "DB queue max",
                  "Inventory util", "Inv queue max", "CPU", "Memory (RSS max)", "Zone"], rows)


# ------------------------------------------------------------------------ report
def describe_profile(doc):
    m = doc["meta"]
    p = m["profile"]
    if m["testType"] == "load-test":
        steps = " -> ".join(f"{s['vus']} VUs ({s['hold']})" for s in p["stages"])
        return (f"Each stage ramps **0 -> N** over `{p['rampUp']}`, **holds** for the listed duration, ramps back to 0 over "
                f"`{p['rampDown']}` and cools down for `{p['cooldown']}` before the next stage. Only samples from the hold "
                f"window are used for the stage's numbers.\n\nStages: {steps}")
    rec = p.get("recovery") or {}
    rec_txt = (f", then a **recovery window**: drop to {rec['vus']} VUs over `{rec['ramp']}` and hold `{rec['hold']}`"
               if rec.get("enabled") else "")
    return (f"Stair-step without returning to zero: {' -> '.join(str(v) for v in p['levels'])} VUs, "
            f"`{p['stepRamp']}` ramp + `{p['stepHold']}` hold per step{rec_txt}, then ramp down over `{p['rampDown']}`.")


def context_box(profile, is_local):
    if profile == "retail-mock" and is_local:
        return ("> **Context:** this run targets the **local mock Omnichannel Retail API** included in this repository, used to "
                "demonstrate the methodology safely. The mock's resource limits (DB pool, inventory dependency) are deliberately "
                "constrained and configurable. **The absolute numbers describe the mock on this machine, not any real product.** "
                "The method, metrics and analysis carry over unchanged to an authorised staging environment.")
    if profile == "quickpizza":
        return ("> **Context:** this run targets **QuickPizza** (`quickpizza.grafana.com`), a public demo API operated by Grafana "
                "Labs that explicitly permits load testing. It is a shared environment, so load was kept modest. Latency includes "
                "the internet path from this machine to the service. No server-side telemetry is available. **The numbers "
                "describe QuickPizza's public demo as seen from this client, not any product.**")
    return ("> **Context:** remote target run with explicit authorisation (`CONFIRM_AUTHORIZED_TARGET=true`). No server-side "
            "telemetry was joined to this report.")


def build_report(load, stress, smoke, knee, telemetry, out_path, charts_dir, chart_prefix):
    report_dir = os.path.dirname(out_path)
    stages = reached(load)
    a = load["analysis"]
    m = load["meta"]
    sla = m["sla"]
    acfg = m["analysisConfig"]
    profile = m["target"].get("profile", "retail-mock")
    is_local = any(h in m["target"]["baseUrl"] for h in ("localhost", "127.0.0.1"))
    telem = stage_telemetry(load, telemetry)
    s_telem = stage_telemetry(stress, telemetry)
    charts = make_charts(load, charts_dir, f"{chart_prefix}load", sla)
    stress_charts = make_charts(stress, charts_dir, f"{chart_prefix}stress", sla) if stress else {}
    sa = stress["analysis"] if stress else None
    sstages = reached(stress)
    rec = sa.get("recovery") if sa else None
    rec_time = recovery_time(stress, telemetry, s_telem) if (stress and rec and rec.get("recovered") is not None) else None
    mock = profile == "retail-mock" and is_local
    md = []
    w = md.append

    w("# Performance & Capacity Report")
    w("")
    srcs = [os.path.basename(d["files"][0]) for d in (load, stress, knee) if d]
    w(f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} by `scripts/generate-report.py` from "
      + ", ".join(f"`{x}`" for x in srcs) + ". All figures are measured values from those files._")
    w("")
    w(context_box(profile, is_local))
    w("")

    # ---------------------------------------------------------------- 1. summary
    w("## 1. Executive Summary")
    w("")
    env_note = " (controlled local mock; this does not establish production capacity)" if mock else ""
    b = []
    b.append(f"**Highest tested healthy stage:** {vus(a.get('highestHealthyVus'), 'none')}{env_note}.")
    b.append(f"**Highest stage meeting the example SLA:** {vus(a.get('maxSlaCompliantVus'), 'none')}"
             + (f"; first SLA breach at {a['firstSlaBreachVus']} VUs ("
                + "; ".join(stage_by_vus(stages, a['firstSlaBreachVus'])['sla']['violations']) + ")." if a.get("firstSlaBreachVus") else "."))
    if a.get("latencyDegradationVus"):
        s = stage_by_vus(stages, a["latencyDegradationVus"])
        b.append(f"**Latency degradation:** from {s['vus']} VUs (P95 {ms(a['baseline']['p95'])} ms at baseline -> {ms(s['latencyMs']['p95'])} ms; "
                 f"P50 {ms(s['latencyMs']['p50'])} ms).")
    else:
        b.append("**Latency degradation:** not observed in the load test.")
    sat_parts = []
    if a.get("saturationVus"):
        sat_parts.append(f"{a['saturationVus']} VUs in the load test")
    if sa and sa.get("saturationVus"):
        sat_parts.append(f"{sa['saturationVus']} VUs in the stress test")
    b.append(f"**Saturation (goodput stops scaling):** {' / '.join(sat_parts) if sat_parts else 'not observed'}.")
    fe = first_error_text(load, "load test") or first_error_text(stress, "stress test")
    me = material_error_text(load, "load test") or material_error_text(stress, "stress test")
    if fe:
        b.append(f"**Errors:** first error occurred at {fe}. "
                 + (f"Material errors (>= {pct(sla['errorRate'], 0)}) appeared at {me}." if me else "No material error rate was observed."))
    else:
        b.append("**Errors:** none observed in any stage.")
    rl = a.get("rateLimitOnsetVus") or (sa.get("rateLimitOnsetVus") if sa else None)
    b.append(f"**Rate limiting (HTTP 429):** {vus(rl)}.")
    brk = a.get("breakingPointVus") or (sa.get("breakingPointVus") if sa else None)
    if brk:
        b.append(f"**Breaking point:** the formal {pct(acfg['breakingErrorRate'], 0)} error/timeout threshold was reached at {brk} VUs.")
    else:
        worst = max(sstages or stages, key=lambda s: s["errorRate"])
        severe = (sa.get("materialErrorVus") if sa else None) or a.get("materialErrorVus")
        b.append(f"**Breaking point:** the formal {pct(acfg['breakingErrorRate'], 0)} error threshold was **not** reached "
                 f"(highest error rate {pct(worst['errorRate'])} at {worst['vus']} VUs)"
                 + (f", but severe degradation and saturation were observed from {severe} VUs." if severe else "."))
    pk, pg = (sa or a)["peakThroughput"], (sa or a)["peakGoodput"]
    b.append(f"**Peak throughput vs goodput{' (stress test)' if sa else ''}:** all responses {num(pk['rps'])} req/s at {pk['vus']} VUs; "
             f"successful responses (goodput) {num(pg['goodputRps'])} req/s at {pg['vus']} VUs.")
    g = graceful_failure_text(stress) if stress else graceful_failure_text(load)
    if g:
        b.append(f"**Failure behaviour:** {g}")
    if rec:
        if rec.get("recovered") is None:
            b.append(f"**Recovery:** not measured ({rec.get('note')}).")
        else:
            t = ""
            if rec_time and rec_time.get("seconds") == 0:
                t = "; no backlog had built up, so there was nothing to drain"
            elif rec_time and rec_time.get("seconds") is not None:
                t = f"; server queues empty and latency back to baseline {rec_time['seconds']} s after load started dropping"
            b.append(f"**Recovery:** {'**recovered**' if rec['recovered'] else '**did not recover**'}: back at {rec['vus']} VUs after the "
                     f"{sstages[-1]['vus']}-VU step, P95 {ms(rec['measured']['p95'])} ms vs baseline {ms(rec['baseline']['p95'])} ms "
                     f"(x{rec['p95Ratio']}), error rate {pct(rec['measured']['errorRate'])}{t}.")
    if knee:
        ka = knee["analysis"]
        b.append(f"**Capacity knee (refinement run {', '.join(str(s['vus']) for s in reached(knee))} VUs):** highest healthy stage "
                 f"{vus(ka.get('highestHealthyVus'), 'none')}, latency degradation from {vus(ka.get('latencyDegradationVus'))}, "
                 f"saturation from {vus(ka.get('saturationVus'))}.")
    for x in b:
        w(f"- {x}")
    w("")

    # ---------------------------------------------------- 2-3. proves / not prove
    w("## 2. What This Test Proves")
    w("")
    proves = ["**The methodology works end to end:** smoke test -> incremental load (0 -> N -> hold -> 0 per stage) -> stress beyond "
              "the expected range -> recovery, with every stage measured on steady-state samples only."]
    proves.append(f"**Incremental load testing exposes the capacity curve:** {len(stages)} stages from {stages[0]['vus']} to "
                  f"{stages[-1]['vus']} VUs show where the system is healthy, where latency degrades and where goodput stops scaling, "
                  "instead of a single pass/fail at 500 users.")
    if mock:
        proves.append("**The controlled mock reproduces realistic capacity behaviour:** a bounded DB connection pool and a slow, "
                      "concurrency-limited inventory dependency produce genuinely measured queueing, saturation and errors.")
    if a.get("latencyDegradationVus"):
        proves.append(f"**Latency degradation is detected automatically:** from {a['latencyDegradationVus']} VUs (P95 > "
                      f"{acfg['degradationFactor']:.0f}x baseline).")
    if telem and (resource_saturation(stages, telem, "inv_util_avg")[0] or resource_saturation(stages, telem, "db_util_avg")[0]):
        proves.append("**Dependency saturation is identified from evidence:** per-endpoint latency (client side) and resource "
                      "utilisation/queues (server telemetry) point to the same resource.")
    if stress and sa.get("failureBehaviour"):
        proves.append("**Failure behaviour is characterised:** which errors appear, at what load, whether requests hang, and how "
                      "bounded the tail latency is.")
    if rec and rec.get("recovered") is not None:
        proves.append("**Recovery is measured:** a dedicated post-stress window is compared with the original baseline.")
    proves.append("**Safety controls work:** remote targets are refused without explicit authorisation; per-stage abort valves stop "
                  "the test on excessive errors or rate limiting.")
    for x in proves:
        w(f"- {x}")
    w("")
    w("## 3. What This Test Does NOT Prove")
    w("")
    not_proves = []
    if mock:
        not_proves += ["It does **NOT** prove the capacity of any real production product.",
                       "It does **NOT** prove that the actual Clarwiz/customer system can handle 500 concurrent users.",
                       "The numbers are specific to the controlled local mock, its deliberately constrained resources and this machine "
                       "(load generator and target share one CPU)."]
    else:
        not_proves += ["It does **NOT** prove the capacity of the customer's system; it describes only the tested target as seen from this client."]
    not_proves += ["Actual capacity must be established by running the same workload against an **authorised**, production-like "
                   "staging environment.",
                   "Real infrastructure metrics (APM, CPU, memory, database, connection pools, load balancer, network, downstream "
                   "dependencies) are required to confirm bottlenecks. The mock's own telemetry is a stand-in, not a substitute.",
                   "Single run, short holds (30-60 s): no statistical repetition and no long-duration (soak) behaviour such as memory "
                   "leaks or cache expiry."]
    for x in not_proves:
        w(f"- {x}")
    w("")

    # -------------------------------------------------------------- 4-7 context
    w("## 4. Test Environment")
    w("")
    w(table(["Item", "Value"], [
        ["Target", f"`{m['target']['baseUrl']}` (profile `{profile}`)" + (" (local mock API)" if mock else "")],
        ["Authentication", f"{m['target']['authType']} (credential {'configured via env' if m['target']['authConfigured'] else 'not used'})"],
        ["Load generator", "k6 (Grafana k6), JavaScript scenarios"],
        ["Load generator location", "same machine as target" if is_local else "this machine, over the internet"],
        ["Load test window", f"{ts(m['testStartMs'])} to {ts(m['testEndMs'])} ({m['durationSec']} s)"],
        ["Stress test window", f"{ts(stress['meta']['testStartMs'])} to {ts(stress['meta']['testEndMs'])} ({stress['meta']['durationSec']} s)" if stress else "not run"],
        ["Server-side telemetry", "mock telemetry CSV (CPU, memory, in-flight, DB pool, dependency)" if telem else "not available"],
    ]))
    w("")
    w("## 5. Test Configuration")
    w("")
    wl = m["workload"]
    w(table(["Setting", "Value"], [
        ["Executor", wl["executor"]],
        ["Action weights", ", ".join(f"{k} {v}%" for k, v in (wl.get("weights") or {}).items())],
        ["Writes enabled", str(m["target"]["enableWrites"])],
        ["Think time", f"{wl['thinkTimeSec']['min']}-{wl['thinkTimeSec']['max']} s between actions"],
        ["Request timeout", m["target"]["requestTimeout"]],
        ["SLA: P95 / P99", f"< {sla['p95Ms']} ms / < {sla['p99Ms']} ms"],
        ["SLA: error / 5xx / timeout rate", f"< {pct(sla['errorRate'], 1)} / < {pct(sla['serverErrorRate'], 1)} / < {pct(sla['timeoutRate'], 1)}"],
        ["SLA: HTTP 429 rate", f"< {pct(sla['rateLimitRate'], 1)} (reported separately from errors)" if "rateLimitRate" in sla else "not set"],
    ]))
    w("")
    w("> The SLA values are **examples** chosen for this demo. For a production decision they must be replaced with the "
      "business's real requirements (ideally per endpoint).")
    w("")
    w("## 6. Load Profile")
    w("")
    w(describe_profile(load))
    w("")
    if stress:
        w("Stress profile: " + describe_profile(stress))
        w("")
    w("## 7. Metrics Collected")
    w("")
    w("Per stage (steady-state only): concurrent VUs, throughput (all responses) and goodput (successful responses) per second, "
      "total / successful / failed requests, HTTP status distribution, error rate (excluding 429), 4xx rate (excluding 429), "
      "5xx rate, timeout rate, HTTP 429 rate, response-check pass rate, P50/P90/P95/P99/min/max latency and per-endpoint latency. "
      "`Failed` counts every non-2xx/3xx response; `Error %` excludes 429 so that rate limiting is not mistaken for an "
      "application fault.")
    w("")
    if not telem:
        w("**Infrastructure metrics (CPU, memory, DB CPU, DB connections, network, dependency latency) were not available for "
          "this run.** See section 18 for how they are collected in a real environment.")
        w("")

    # -------------------------------------------------------------- 8. results
    w("## 8. Load Test Results")
    w("")
    w(results_table(stages))
    w("")
    w(f"Latency in ms. Goodput = successful responses/s. Zones: **HEALTHY**: SLA met, latency near baseline, goodput scaling. "
      f"**DEGRADED**: latency well above baseline or SLA missed, but goodput still scaling. **SATURATED**: goodput realised less "
      f"than {pct(acfg['throughputScalingMin'], 0)} of the gain the extra users should produce, or fell: more users only add "
      f"queueing. **RATE_LIMITED**: HTTP 429 above the 429 SLA (external quota). **BREAKING**: error/timeout rate >= "
      f"{pct(acfg['breakingErrorRate'], 0)} or throughput falling > 10%. `*` = partial stage (test stopped early).")
    w("")
    w("Compact view:")
    w("")
    w(table(["VUs", "RPS", "P50", "P95", "P99", "Error %", "429 %"],
            [[s["vus"], num(s["rps"]), ms(s["latencyMs"]["p50"]), ms(s["latencyMs"]["p95"]), ms(s["latencyMs"]["p99"]),
              pct(s["errorRate"], 3), pct(s["rateLimitRate"])] for s in stages]))
    w("")
    w(chart_md(charts, "throughput", "Throughput vs VUs", report_dir))

    w("## 9. Latency Analysis")
    w("")
    base = a.get("baseline") or {}
    w(f"Baseline (first stage, {base.get('vus')} VUs): P50 {ms(base.get('p50'))} ms, P95 {ms(base.get('p95'))} ms. "
      f"A stage counts as *latency-degraded* when P95 exceeds {acfg['degradationFactor']}x baseline and has grown "
      f"by at least {acfg['degradationMinDeltaMs']} ms.")
    w("")
    w(chart_md(charts, "p95", "P95 latency vs VUs", report_dir))
    w(chart_md(charts, "p99", "P99 latency vs VUs", report_dir))
    w(chart_md(charts, "percentiles", "Latency percentiles vs VUs", report_dir))
    if any(s.get("endpoints") for s in stages):
        w("Latency per endpoint, P95 / P99 (ms):")
        w("")
        w(endpoint_p95_p99_table(stages))
        w("")
        w(chart_md(charts, "endpoints", "Endpoint P95 vs VUs", report_dir))

    w("## 10. Error Analysis")
    w("")
    w("HTTP status distribution (steady-state requests):")
    w("")
    w(status_table(stages))
    w("")
    w("Status `0` means no HTTP response was received (client-side timeout or connection error).")
    w("")
    w(chart_md(charts, "errors", "Error rate vs VUs", report_dir))
    breaches = [s for s in stages if not s["sla"]["pass"]]
    if breaches:
        w("SLA violations by stage:")
        w("")
        for s in breaches:
            w(f"- **{s['vus']} VUs**: " + "; ".join(s["sla"]["violations"]))
        w("")

    w("## 11. Capacity Benchmark")
    w("")
    w(table(["Question", "Answer (measured)"], [
        ["Highest tested healthy stage", vus(a.get("highestHealthyVus"), "none") + env_note],
        ["Highest tested concurrency meeting the SLA", vus(a.get("maxSlaCompliantVus"), "none")],
        ["Where latency starts degrading significantly", vus(a.get("latencyDegradationVus"))],
        ["Where goodput stops scaling (saturation)", " / ".join(sat_parts) if sat_parts else "not observed"],
        ["First error", fe or "none observed"],
        ["Material errors (>= SLA error rate)", me or "not observed"],
        ["Where rate limiting begins", vus(rl)],
        ["Formal breaking threshold", f"reached at {brk} VUs" if brk else f"not reached (>= {pct(acfg['breakingErrorRate'], 0)} errors/timeouts)"],
        ["Peak throughput (all responses)", f"{num(pk['rps'])} req/s @ {pk['vus']} VUs"],
        ["Peak goodput (successful responses)", f"{num(pg['goodputRps'])} req/s @ {pg['vus']} VUs"],
        ["Recovered after stress?", ("yes" if rec["recovered"] else "no") if rec and rec.get("recovered") is not None else "not measured"],
    ]))
    w("")
    w("\"Highest stage\" answers use the highest stage where that stage **and every stage below it** qualified, so one lucky "
      "stage after a failure cannot inflate the number. Because stages are discrete, the true limit lies between the last "
      "qualifying stage and the next one.")
    w("")

    w("## 12. Operating Zones")
    w("")
    all_main = stages + [s for s in sstages if s["vus"] > stages[-1]["vus"]]
    zones = {z: [str(s["vus"]) for s in all_main if s["zone"] == z] for z in ("HEALTHY", "DEGRADED", "SATURATED", "RATE_LIMITED", "BREAKING")}
    w(table(["Zone", "Stages (VUs)", "Meaning"], [
        ["Healthy operating range", ", ".join(zones["HEALTHY"]) or "-", "Meets SLA with headroom; latency near baseline; goodput scales."],
        ["Degradation zone", ", ".join(zones["DEGRADED"]) or "-", "Still correct, latency climbing, goodput still scaling."],
        ["Saturation", ", ".join(zones["SATURATED"]) or "-", "Goodput flat or falling: extra users only add queueing (and, here, errors)."],
        ["Rate limited", ", ".join(zones["RATE_LIMITED"]) or "-", "External quota reached: requests refused with 429."],
        ["Failure / breaking", ", ".join(zones["BREAKING"]) or "-", f"Errors or timeouts >= {pct(acfg['breakingErrorRate'], 0)}, or throughput falling > 10%."],
    ]))
    w("")
    w("Stages above the load test's highest level come from the stress test. Rising latency alone is **not** a failure: it is "
      "the expected sign that the system is approaching a capacity limit.")
    w("")

    w("## 13. Bottleneck Analysis (Load Test)")
    w("")
    for x in bottleneck_indicators(load, telem):
        w(f"- {x}")
    w("")
    tt = telemetry_table(stages, telem) if telem else None
    if tt:
        w("Server-side telemetry per stage (from the mock's own instrumentation; real systems would use APM/Prometheus):")
        w("")
        w(tt)
        w("")
    w("These are **indicators** inferred from client-side metrics" + (" and mock telemetry" if telem else "")
      + ". On a real system, confirm with server-side profiling/APM before acting on them.")
    w("")

    # -------------------------------------------------------------- 14. stress
    n = 14
    if stress:
        w(f"## {n}. Stress Test (Beyond Expected Capacity)")
        w("")
        w(describe_profile(stress))
        w("")
        w(results_table(sstages))
        w("")
        w("Stress stages with server-side telemetry:")
        w("")
        w(stress_combined_table(sstages, s_telem))
        w("")
        if stress["thresholdFailures"]:
            w("**The stress test was stopped by a safety threshold** (by design: we stop rather than keep hammering a broken "
              "or rate-limiting target):")
            w("")
            for f in stress["thresholdFailures"]:
                w(f"- `{f}`")
            w("")
        not_reached = [s["vus"] for s in stress["stages"] if not s["reached"] and not s.get("recovery")]
        if not_reached:
            w(f"Steps not reached: {', '.join(map(str, not_reached))} VUs.")
            w("")
        w("Endpoint latency in the stress test, P95 / P99 (ms):")
        w("")
        w(endpoint_p95_p99_table(sstages))
        w("")
        narrative = stress_stage_narrative(sstages, s_telem)
        if narrative:
            w("**Bottleneck progression (server telemetry):**")
            w("")
            for x in narrative:
                w(x)
            w("")
            first_inv, _ = resource_saturation(sstages, s_telem, "inv_util_avg")
            first_db, _ = resource_saturation(sstages, s_telem, "db_util_avg")
            order = sorted([(s["vus"], name) for s, name in ((first_inv, "the store-inventory dependency"), (first_db, "the DB connection pool")) if s])
            if order:
                txt = f"The first resource to saturate was **{order[0][1]}** at {order[0][0]} VUs"
                if len(order) > 1:
                    txt += f"; **{order[1][1]}** followed at {order[1][0]} VUs"
                w(txt + ". Errors map to the resource that timed out: inventory acquire timeouts surface as HTTP 504, "
                  "DB-pool acquire timeouts as HTTP 503.")
                w("")
        else:
            w("Server-side telemetry was not available for the stress stages.")
            w("")
        g = graceful_failure_text(stress)
        if g:
            w(f"**Failure behaviour:** {g}")
            w("")
        brk_s = sa.get("breakingPointVus")
        w(f"Stress findings: saturation from {vus(sa.get('saturationVus'))}, material errors from {vus(sa.get('materialErrorVus'))}, "
          f"429 onset {vus(sa.get('rateLimitOnsetVus'))}; formal breaking threshold "
          + (f"reached at {brk_s} VUs." if brk_s else "not reached."))
        w("")
        for key, alt in (("throughput", "Stress throughput vs VUs"), ("p95", "Stress P95 vs VUs"), ("p99", "Stress P99 vs VUs"),
                         ("percentiles", "Stress latency percentiles"), ("errors", "Stress error rate vs VUs"),
                         ("endpoints", "Stress endpoint P95")):
            w(chart_md(stress_charts, key, alt, report_dir))
        n += 1

        # ---------------------------------------------------------- recovery
        w(f"## {n}. Recovery After Stress")
        w("")
        if not rec:
            w("Recovery was not part of this stress run (`STRESS_RECOVERY=false`).")
        elif rec.get("recovered") is None:
            w(f"Recovery was **not measured**: {rec.get('note')}.")
        else:
            rs = next(s for s in stress["stages"] if s.get("recovery"))
            bs = stage_by_vus(sstages, rec["baselineVus"])
            rt = s_telem.get(rs["stage"]) or {}
            bt = s_telem.get(bs["stage"]) or {}
            q = lambda t, k, d=1: num(t[k], d) if k in t else "Not measured"
            w(f"After the {sstages[-1]['vus']}-VU step the load dropped to **{rec['vus']} VUs** and was held for {rs['holdSec']:.0f} s "
              f"(measured window). It is compared with the original {rec['baselineVus']}-VU stage at the start of the stress test.")
            w("")
            w(table(["Metric", f"Baseline ({rec['baselineVus']} VUs, before stress)", f"Recovery ({rec['vus']} VUs, after stress)"], [
                ["Throughput / goodput (req/s)", f"{num(bs['rps'])} / {num(bs['goodputRps'])}", f"{num(rs['rps'])} / {num(rs['goodputRps'])}"],
                ["P50 (ms)", ms(bs["latencyMs"]["p50"]), ms(rs["latencyMs"]["p50"])],
                ["P95 (ms)", ms(bs["latencyMs"]["p95"]), ms(rs["latencyMs"]["p95"])],
                ["P99 (ms)", ms(bs["latencyMs"]["p99"]), ms(rs["latencyMs"]["p99"])],
                ["Error rate", pct(bs["errorRate"]), pct(rs["errorRate"])],
                ["5xx rate", pct(bs["serverErrorRate"]), pct(rs["serverErrorRate"])],
                ["Timeout rate", pct(bs["timeoutRate"]), pct(rs["timeoutRate"])],
                ["DB queue (avg / max)", f"{q(bt, 'db_queue_avg')} / {q(bt, 'db_queue_max', 0)}", f"{q(rt, 'db_queue_avg')} / {q(rt, 'db_queue_max', 0)}"],
                ["Inventory queue (avg / max)", f"{q(bt, 'inv_queue_avg')} / {q(bt, 'inv_queue_max', 0)}", f"{q(rt, 'inv_queue_avg')} / {q(rt, 'inv_queue_max', 0)}"],
                ["In-flight requests (avg / max)", f"{q(bt, 'inflight_avg')} / {q(bt, 'inflight_max', 0)}", f"{q(rt, 'inflight_avg')} / {q(rt, 'inflight_max', 0)}"],
            ]))
            w("")
            qz = rt and rt.get("db_queue_max") == 0 and rt.get("inv_queue_max") == 0
            w(f"- **Did the system recover?** {'**Yes.**' if rec['recovered'] else '**No.**'} Rule: recovery P95 within "
              f"{rec['p95FactorAllowed']}x of baseline and error/timeout rates below the SLA.")
            w(f"- **Recovered P95 vs baseline P95:** {ms(rec['measured']['p95'])} ms vs {ms(rec['baseline']['p95'])} ms (x{rec['p95Ratio']}).")
            w(f"- **Did errors return to zero?** {'Yes' if rec['errorsReturnedToZero'] else 'No'} "
              f"(error rate {pct(rec['measured']['errorRate'])}, timeouts {pct(rec['measured']['timeoutRate'])}).")
            w(f"- **Did queues return to zero?** " + ("Yes: DB and inventory queue max 0 throughout the recovery window." if qz
                                                     else ("No: queues were still non-empty during the recovery window." if rt else "Not measured (no server telemetry).")))
            if rec_time and rec_time.get("seconds") == 0:
                w("- **How long did recovery take?** Nothing to recover from: server queues were already empty and latency at "
                  "baseline when the load started dropping (the stress levels did not build a backlog).")
            elif rec_time and rec_time.get("seconds") is not None:
                w(f"- **How long did recovery take?** {rec_time['seconds']} s from the moment load started dropping (this includes the "
                  f"{rec_time['rampSec']} s ramp from {sstages[-1]['vus']} to {rec['vus']} VUs) until both queues were empty and the "
                  f"server's average latency was <= {rec_time['serverMsLimit']} ms (2x the baseline {rec_time['baselineServerMs']} ms), "
                  f"sustained for 5 s. Measured from 1-second server telemetry.")
            elif rec_time:
                w("- **How long did recovery take?** The server did not meet the recovery condition within the recovery window.")
            else:
                w("- **How long did recovery take?** Not measurable without server-side telemetry.")
        w("")
        n += 1

    # -------------------------------------------------------------- knee
    if knee:
        kst = reached(knee)
        w(f"## {n}. Capacity Knee Refinement")
        w("")
        w(f"A separate load run (`LOAD_PROFILE=knee`) used finer stages ({', '.join(str(s['vus']) for s in kst)} VUs) to locate the "
          "knee between the last healthy and the first degraded stage of the main run. Its baseline is its own first stage.")
        w("")
        w(table(["VUs", "RPS", "Goodput", "P50", "P95", "P99", "Error %", "Goodput scaling", "SLA", "Zone"],
                [[s["vus"], num(s["rps"]), num(s["goodputRps"]), ms(s["latencyMs"]["p50"]), ms(s["latencyMs"]["p95"]),
                  ms(s["latencyMs"]["p99"]), pct(s["errorRate"], 3), num(s.get("throughputScaling"), 2),
                  "PASS" if s["sla"]["pass"] else "FAIL", f"**{s['zone']}**"] for s in kst]))
        w("")
        k_telem = stage_telemetry(knee, telemetry)
        kt = telemetry_table(kst, k_telem) if k_telem else None
        if kt:
            w(kt)
            w("")
        ka = knee["analysis"]
        w(f"Refinement result: highest healthy stage {vus(ka.get('highestHealthyVus'), 'none')}; highest stage meeting the SLA "
          f"{vus(ka.get('maxSlaCompliantVus'), 'none')}; latency degradation from {vus(ka.get('latencyDegradationVus'))}; "
          f"saturation from {vus(ka.get('saturationVus'))}.")
        w("")
        n += 1

    # -------------------------------------------------------------- recs
    w(f"## {n}. Recommendations")
    w("")
    recs = []
    hh = (knee["analysis"].get("highestHealthyVus") if knee else None) or a.get("highestHealthyVus")
    if hh:
        recs.append(f"On this {'mock' if mock else 'target'}, **{hh} VUs is the highest tested healthy stage**"
                    + (" (from the knee refinement run)" if knee and knee["analysis"].get("highestHealthyVus") else "")
                    + ". Treat it as an upper bound, not an operating target: plan expected peak demand comfortably below it.")
    if not knee:
        recs.append("Locate the knee precisely with `npm run load:knee` (stages 300, 350, 400, 450, 500) before quoting any limit.")
    if telem or s_telem:
        all_t = {**telem, **s_telem}
        if any(t["inv_util_avg"] >= 95 for t in all_t.values()):
            recs.append("Protect the inventory dependency (the first resource to saturate): cache availability for a few seconds, "
                        "add a circuit breaker with an 'availability unknown' fallback, and agree a capacity figure with the "
                        "store-systems team. Re-test with a higher `MOCK_INVENTORY_CONCURRENCY` to confirm cause and effect.")
        if any(t["db_util_avg"] >= 95 for t in all_t.values()):
            recs.append("The DB pool saturates next: cache hot reads (customer search, product detail) and review pool sizing "
                        "against database CPU and connection limits before simply raising it.")
    if a.get("rateLimitOnsetVus") is not None:
        recs.append("Agree a test quota with the API owner. Do not bypass a rate limit; report it as a client-side capacity constraint.")
    recs.append("Replace the example SLAs with the customer's real targets (per endpoint where possible) and re-run the same profile.")
    recs.append("Repeat each run at least 3 times and compare. Single runs on a laptop have noticeable run-to-run variance.")
    recs.append("Run the load generator on separate infrastructure from the system under test (here both share one machine).")
    recs.append("Next tests: soak at the highest healthy stage (hours) and a spike test (sudden surge) on authorised staging.")
    for r in recs:
        w(f"- {r}")
    w("")
    n += 1

    w(f"## {n}. Limitations")
    w("")
    lim = []
    if mock:
        lim += ["The target is a local mock with synthetic data and simulated resource limits. It demonstrates the method; it "
                "says nothing about the real product's capacity.",
                "k6 and the target share one machine, so they compete for CPU and network stack. Load-generator CPU was not measured."]
    lim += ["Closed workload model (ramping VUs with think time): throughput depends on response time. An open model "
            "(arrival-rate executor) is better for testing a fixed request rate and avoids coordinated omission.",
            "Holds of 30-60 s find the knee but not leaks, GC pressure, cache expiry or connection churn; a soak test is needed.",
            f"Low stages have few samples (e.g. {stages[0]['totalRequests']} requests at {stages[0]['vus']} VUs), so their P99 rests "
            "on a handful of requests.",
            "Single run: no statistical repetition.",
            "Mostly read traffic (writes limited to an in-memory cart). Checkout/payment paths were deliberately not tested.",
            "Network latency and bandwidth were not measured."]
    if not telem:
        lim.append("No server-side infrastructure metrics were collected, so bottlenecks are inferred from client-side signals only.")
    if smoke:
        sm = smoke["stages"][0]
        lim.append(f"Smoke test before the runs: {sm['totalRequests']} requests, checks pass rate "
                   f"{pct(smoke['meta']['totals']['checksPassRate'], 1)}, error rate {pct(sm['errorRate'])}.")
    for x in lim:
        w(f"- {x}")
    w("")
    n += 1

    w(f"## {n}. What Real Staging Testing Should Add")
    w("")
    w(table(["Area", "What to collect / do"], [
        ["APM & distributed tracing", "Per-endpoint and per-span latency (OpenTelemetry, Datadog, New Relic); trace slow requests to the responsible service or query"],
        ["CPU & memory", "Per service, pod and node (Prometheus node-exporter / cAdvisor, CloudWatch); GC pauses, OOM kills, restarts"],
        ["Database", "DB CPU, IOPS, slow queries, lock waits, replication lag (Performance Insights, pg_stat_statements)"],
        ["Connection pools", "Active / idle / waiting connections and acquire time for DB and HTTP client pools; max connections on the DB side"],
        ["Load balancer", "Request count, target response time, surge queue, 5xx from LB vs targets, connection errors"],
        ["Network", "Throughput, retransmits, cross-AZ latency; place load generators in the same region as real users"],
        ["Downstream dependencies", "Latency, error rate and quotas of payments, inventory, search, tax, CRM; circuit-breaker state"],
        ["Autoscaling", "Scaling events and lag (HPA / ASG); whether capacity was added in time"],
        ["Production-like data", "Seeded synthetic customers, products, stores and orders at production volume and distribution"],
        ["Realistic traffic", "Action weights, think times and peak concurrency derived from production analytics, per channel (web, app, store, call center)"],
        ["Monitoring dashboards", "One Grafana/Datadog dashboard with k6 metrics (`--out experimental-prometheus-rw`) and server metrics on a shared timeline; filter by `X-Load-Test` header"],
    ]))
    w("")
    n += 1

    w(f"## {n}. Applying This Methodology to a Real Enterprise Staging Environment")
    w("")
    w("""1. **Authorisation & scope**: written approval from the system owner; agree the environment, time window, maximum
   load, stop conditions and an on-call contact. Never point this at production. The framework refuses remote targets
   unless `CONFIRM_AUTHORIZED_TARGET=true` is set.
2. **Production-like staging**: same instance types, autoscaling rules, DB size and data volume as production (or a
   documented ratio). Replace `k6/data/test-data.json` with IDs of seeded synthetic test records.
3. **Workload model from real data**: derive weights, think time and peak concurrency from production analytics.
4. **Real SLAs**: per-endpoint latency and error budgets from the business; set them in `.env`.
5. **Point the framework at staging**: `TARGET_BASE_URL`, `AUTH_TYPE`, `API_TOKEN` (from a secrets manager in CI).
6. **Observe server-side** during every stage (section above), correlated by the stage time windows in the results JSON.
7. **Run order**: smoke -> incremental load -> knee refinement -> stress with recovery -> soak -> spike.
8. **Repeat and compare** after each fix; gate releases in CI with `SLA_GATE_VUS`.""")
    w("")

    os.makedirs(report_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md).replace("\n\n\n", "\n\n"))
    return out_path, charts, stress_charts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", default="retail-mock", help="target profile whose results to report (retail-mock | quickpizza)")
    ap.add_argument("--load")
    ap.add_argument("--stress")
    ap.add_argument("--smoke")
    ap.add_argument("--knee", help="knee refinement load results (default results/knee/latest-load-test.json)")
    ap.add_argument("--telemetry", default=os.path.join(ROOT, "results", "mock-server-telemetry.csv"))
    ap.add_argument("--no-stress", action="store_true", help="ignore stress results even if present")
    ap.add_argument("--no-knee", action="store_true", help="ignore knee refinement results even if present")
    ap.add_argument("--out")
    ap.add_argument("--charts-dir", default=os.path.join(ROOT, "reports", "charts"))
    args = ap.parse_args()

    mock = args.profile == "retail-mock"
    rdir = os.path.join(ROOT, "results") if mock else os.path.join(ROOT, "results", args.profile)
    args.load = args.load or os.path.join(rdir, "latest-load-test.json")
    args.stress = args.stress or os.path.join(rdir, "latest-stress-test.json")
    args.smoke = args.smoke or os.path.join(rdir, "latest-smoke-test.json")
    args.knee = args.knee or os.path.join(ROOT, "results", "knee" if mock else f"{args.profile}-knee", "latest-load-test.json")
    args.out = args.out or os.path.join(ROOT, "reports", "performance-report.md" if mock else f"{args.profile}-performance-report.md")

    load = load_json(args.load)
    if not load:
        sys.exit(f"No load-test results at {args.load}. Run the load test for profile '{args.profile}' first.")
    stress = None if args.no_stress else load_json(args.stress)
    knee = None if args.no_knee else load_json(args.knee)
    # Mock telemetry only describes the local mock: never join it to a remote target's results.
    telemetry = load_telemetry(args.telemetry) if mock else []
    out, charts, stress_charts = build_report(load, stress, load_json(args.smoke), knee, telemetry,
                                              os.path.abspath(args.out), os.path.abspath(args.charts_dir),
                                              "" if mock else f"{args.profile}-")
    print(f"Report written: {out}")
    if not HAVE_MPL:
        print("matplotlib not installed: charts skipped (pip install -r scripts/requirements.txt)")
    for c in list(charts.values()) + list(stress_charts.values()):
        print(f"Chart: {c}")


if __name__ == "__main__":
    main()
