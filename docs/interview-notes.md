# Interview Cheat Sheet

## 30-second explanation

"The customer's question is whether our product can handle their enterprise workload, and how we'd prove it. I
don't jump straight to 500 users. I build a capacity curve. k6 raises concurrency in stages from 10 to 500, measures
latency, throughput, goodput, errors and dependency saturation on steady-state traffic, then refines around the
knee, stresses beyond it, and checks recovery. On a controlled mock it showed the full arc: healthy, degraded,
saturated, graceful failure, recovery. For the real answer, the same test runs on authorised, production-like
staging with the customer's workload and SLAs."

## 2-minute explanation

- **Target:** a local mock omnichannel API (customers, products, inventory, carts, orders, tracking) with realistic
  limits: an 8-connection DB pool and a slow store-inventory dependency allowing 5 concurrent calls. Safe to push,
  and it emits server telemetry. The target URL and auth are configuration, so the same scripts run on staging.
- **Workload:** each VU is a simulated customer doing weighted actions (search 40%, product 20%, inventory 20%,
  order status 15%, cart 5%) with 0.5-1.5 s think time.
- **Method:** smoke first. Then incremental load, each stage ramp → hold → ramp down → cool-down, measured only
  during the hold. Then a knee run, a stress run that never drops back to zero, and a recovery window.
- **Analysis:** every stage gets an SLA verdict and a zone. The report adds per-endpoint latency, status-code
  breakdown and telemetry, so the bottleneck is backed by evidence, not guessed.
- **Safety:** remote targets are refused without explicit authorisation, abort valves stop runaway stages, and
  rate limits are reported, never bypassed.
- **Browser:** Playwright validates the real user journey with 2 browsers; k6 does the load.

## 5-minute walkthrough

1. **Problem (30 s):** "Can you handle us?" needs a curve plus a repeatable method, not one number.
2. **Smoke (30 s):** `npm run smoke`: pre-checks pass, 100% of checks, all 8 endpoints measured.
3. **Load (1 min):** console table. 10-300 VUs healthy (P95 86-94 ms). At 500, P95 1,631 ms while P50 is 22 ms:
   only part of the traffic is queueing.
4. **Knee (30 s):** 350 healthy, 400 degraded, 450 saturated: "the limit on this mock is between 350 and 400."
5. **Report (1 min):** throughput chart against the dashed linear-scaling line, then the endpoint chart:
   `inventory_get` climbs 16× while the rest stay within 1.5×. The telemetry table shows inventory at 100%.
6. **Stress + recovery (1 min):** goodput flat at ~535-538 req/s at 750-1000 VUs, ~4% HTTP 504, 0 timeouts, P99
   ≤ 2.7 s. Back at 100 VUs, P95 86.9 vs 88.6 ms baseline, queues empty in 15 s.
7. **Close (30 s):** what this proves (the method) and what it doesn't (real capacity), and the staging plan.

## Results I should quote

All from the **controlled local mock**, not a real product.

| Finding | Number |
|---|---|
| Healthy range | 10-300 VUs, P95 86-94 ms, 0 errors |
| Knee | healthy at 350 (P95 119 ms) → degraded at 400 (P95 371 ms) → saturated at 450 |
| 500 VUs | P95 1,631 ms (SLA breach), P50 22 ms, goodput gain 49% of expected |
| Stress 750-1000 | goodput ~535-538 req/s, 3.78% / 4.03% HTTP 504, 0 timeouts, P99 ≤ 2,666 ms |
| Bottleneck | inventory dependency 100% from 500 VUs; DB pool 100% from 750 VUs (secondary, no timeouts) |
| Recovery | P95 86.9 vs 88.6 ms baseline, 0 errors, queues drained in 15 s |

## What the results actually mean

| Zone | Plain meaning | On the mock |
|---|---|---|
| **Healthy** | Meets SLA, latency near baseline, more users → proportionally more work | 10-350 VUs |
| **Degraded** | Slower, but still scaling and correct | 400 VUs |
| **Saturated** | More users add queueing, not work: goodput stops scaling | 450-500, and 750-1000 in stress |
| **Breaking** | Users failing at a material rate (≥ 5%) or throughput falling | not reached |

500 VUs sits on the line between degraded and saturated: goodput scaling 0.49 in the load run, 0.50 in the stress run.

## Terminology

| Term | Plain meaning |
|---|---|
| **VU** (virtual user) | One simulated concurrent customer: request → think time → next request. A concurrency unit, not a real person |
| **Think time** | Pause between a VU's actions (0.5-1.5 s here); sets how much work each VU generates |
| **Stage / hold / steady state** | One concurrency level; the hold is the stable period after the ramp, the only part measured |
| **P50 / P95 / P99** | Latency 50 / 95 / 99% of requests beat; P95/P99 describe the tail customers actually feel |
| **Throughput vs goodput** | All responses/s vs successful responses/s; capacity is measured in goodput |
| **Knee** | Where latency starts rising faster than load; here between 350 and 400 VUs |
| **Saturation** | Adding users no longer adds goodput, only queueing |
| **Closed vs open model** | Closed: fixed users, rate depends on latency (`ramping-vus`). Open: fixed arrival rate (`ramping-arrival-rate`) |
| **Coordinated omission** | A slow server slows a closed-model generator, so bad periods get under-sampled |
| **Smoke / load / stress / soak / spike** | Validity check / expected range / beyond range / hours at steady load / sudden surge |

## Most likely interviewer questions

**Why didn't you just test 500?** You'd get one pass/fail point, not the shape. You couldn't say where it starts
degrading or why, couldn't tell a quota from a crash, and you might knock over a shared environment.

**What is a VU?** A virtual user: one simulated concurrent customer that makes a request, waits (think time), and
repeats. It is a concurrency unit, not a real person.

**VU vs RPS?** VUs are concurrency, RPS is work. With think time, requests/s is an output: when latency rises,
the same VUs produce fewer requests. I report both, plus goodput.

**Why P95/P99 instead of average?** Averages hide the tail. At 500 VUs here the median stayed at 22 ms while
P95 was 1.6 s. The average would have looked acceptable while one in twenty requests was slow.

**What is goodput?** Successful responses per second. Under overload a service can answer fast with errors, so
total throughput can rise while useful work doesn't. At 1,000 VUs throughput was 560 req/s but goodput 538.

**How did you find the bottleneck?** Three signals that agree. The per-endpoint split: only `inventory_get`
degraded (16×). The error signature: HTTP 504, which the mock returns when the inventory call times out. The
telemetry: inventory utilisation at 100% with a growing queue, while CPU stayed ≤ 13%.

**Why inventory?** It models a legacy store-inventory system: 40-90 ms per call and only 5 concurrent calls,
about 75 calls/s capacity. Inventory checks are ~20% of actions, so it fills up first, around 400-450 VUs.

**Why the DB pool?** Every request needs one of 8 connections. It reached 81-85% at 500 VUs and 100% from 750,
which pushed the median up (570 ms at 1,000 VUs). It never hit its 1.5 s acquire timeout, so it caused no errors.

**What is coordinated omission?** In a closed model, a slow server slows the load generator, so you under-sample
the bad periods. Arrival-rate executors keep the request rate fixed regardless of response time.

**What if the load generator becomes the bottleneck?** Then you're measuring your own laptop. Watch generator CPU
(stay under ~70%) and k6's `dropped_iterations`, and distribute generators (k6 Operator / Grafana Cloud). Here k6
and the mock shared a machine, which I list as a limitation.

**Why k6?** Scriptable in JavaScript, very efficient (one machine drives thousands of VUs), with tags, thresholds,
scenarios and CI-friendly exit codes. Tests are code you can review and version.

**Why Playwright?** It validates the real end-to-end journey in a browser (rendering, front-end calls), which an
API test can't see. It's not a load generator: a browser costs 100-300 MB, a VU a few MB.

**Why not HubSpot/Freshdesk?** No API key was available, and it's someone else's production SaaS with a 100-190
requests per 10 s quota. 500 users would only measure their rate limiter. The right use is a low-rate integration
test in a developer test account. To show a real remote API, I used Grafana's QuickPizza, which permits load tests.

**Why a local mock?** It's safe, repeatable, and has real constraints to discover. Public test APIs are shared and
rate-limited, and I had no authorisation to load-test my employer's systems.

**Does this prove Clarwiz can handle 500 users?** No. It proves the method works and what this mock can do. Real
capacity needs the same test on authorised, production-like staging with real workload and SLAs.

**How would you test the real customer environment?** Written authorisation and scope. Production-like staging and
seeded data. Workload and peak from their analytics, and their SLAs. Then smoke → load → knee → stress + recovery →
soak → spike, with APM, DB and load-balancer dashboards aligned to the stage windows.

**How would you test 2,000 RPS?** Switch to an open model: k6 `ramping-arrival-rate` targeting 2,000 iterations/s,
with enough pre-allocated VUs, watching `dropped_iterations`. Run distributed generators in the same region.

**What would you improve next?** Live Grafana dashboards, arrival-rate scenarios, soak and spike tests,
per-endpoint SLAs, repeated runs with variance, and a CI gate (`SLA_GATE_VUS`).

**How did you make it safe?** Any non-local target is refused before a VU starts unless
`CONFIRM_AUTHORIZED_TARGET=true`. Per-stage aborts: > 50% errors in load, > 20% in stress, > 10% 429. Writes off
by default, credentials only from env, `X-Load-Test` header on every request.

**What happens when the system starts failing?** The mock sheds load: requests waiting too long for the inventory
dependency get a fast 504 instead of hanging. Errors stayed ~4%, no client timeouts, and P99 was bounded at ~2.7 s.

**How did you test recovery?** After the 1,000-VU step the stress test drops to 100 VUs for 60 s and compares
with the original 100-VU stage: P95 within 1.5× and errors below SLA. It recovered: 86.9 vs 88.6 ms, 0 errors.
Telemetry shows the queues drained 15 s after the load started dropping.

## Difficult follow-up questions

**"Isn't a mock API cheating?"** The constraints are deliberate, but the results aren't scripted: they're
measured queueing. Change the pool size and the knee moves. The framework treats the target as a black box and
finds the bottleneck from client-side signals; the telemetry only confirms it.

**"Why not directly generate 500 RPS?"** That's a different question ("can it sustain a rate?"). The customer
asked about concurrent customers, so I modelled users. For a rate target I'd add an arrival-rate scenario.

**"Why VUs instead of users?"** A VU is a modelled user with 0.5-1.5 s think time, much busier than a real
shopper. Mapping VUs to real customers needs their analytics (session length, think time).

**"How do you know it's inventory?"** Only `inventory_get` degraded, the errors are 504 (the dependency-timeout
signature), and telemetry shows inventory at 100% with a queue while CPU was ≤ 13%. Three independent signals.

**"How do you distinguish application failure from infrastructure failure?"** From the status-code signature (503
pool, 504 dependency, timeout = hang, 429 = quota) plus server metrics: CPU, memory, pools, dependency latency. On
staging that comes from APM and infrastructure dashboards. Here CPU was low, so it wasn't compute.

**"Why wasn't the 5% error rate reached?"** Only inventory calls fail, and they are ~17% of requests. At 1,000
VUs roughly a quarter of inventory calls timed out, which is ~4% overall. The system degraded severely, but by
shedding one dependency's excess rather than collapsing.

**"Why call 500 saturated if there are almost no errors?"** Saturation means goodput stopped scaling: from 300 to
500 VUs it gained only 49% of the expected throughput. Errors come later. It's the point where adding users
adds queueing, not work.

**"Can you guarantee production capacity?"** No test guarantees it. A staging test against production-like
infrastructure, real workload and agreed SLAs gives an evidence-based capacity figure with headroom, re-validated
after each significant change.

## What NOT to say

| Don't say | Say instead |
|---|---|
| "Clarwiz supports 350 users." | "On the controlled mock, the highest healthy stage was 350 VUs. Real capacity needs staging." |
| "The product can handle 500 users." | "The mock saturated at 500 VUs. This run says nothing about the product's capacity." |
| "500 VUs means 500 real customers." | "500 VUs is 500 concurrent simulated sessions with 0.5-1.5 s think time. Mapping to real customers needs analytics." |
| "The mock results prove production capacity." | "The mock validates the methodology. Production capacity comes from authorised staging." |
| "It broke at 750." | "Severe degradation from 750 VUs (~4% 504s); the formal 5% breaking threshold wasn't reached." |

## Demo flow

| # | Show | Command / file | Point at |
|---|---|---|---|
| 1 | Project | `README.md` §1-2 | the customer question and what was built |
| 2 | Architecture | `README.md` §6 | k6 → API → dependencies → telemetry → report; Playwright separate |
| 3 | Smoke | `npm run mock`, then `npm run smoke` | pre-checks, 100% checks, verdict PASS |
| 4 | Load | `npm run load:quick` live (~3.5 min), or the saved run | healthy rows, the 500-VU jump, P50 vs P95 |
| 5 | Knee | report § "Capacity Knee Refinement" | 350 healthy / 400 degraded / 450 saturated |
| 6 | Report | `reports/performance-report.md` | executive summary, what it proves / doesn't, charts |
| 7 | Stress | report § "Stress Test" | zones 750-1000, goodput flat, 504s only |
| 8 | Bottleneck telemetry | report stress telemetry + endpoint tables | inventory 100% at 500, DB 100% at 750 |
| 9 | Recovery | report § "Recovery After Stress" | 86.9 vs 88.6 ms, 0 errors, 15 s |
| 10 | Safety guard | `TARGET_BASE_URL=https://staging.example.test npm run load` | "REFUSED" before any VU, exit 107 |
