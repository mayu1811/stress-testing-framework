# Freshdesk API Validation Report

_Generated 2026-10-03 05:58 UTC by `scripts/generate-report.py --profile freshdesk` from `latest-validation.json`, `smoke-test-2026-10-03T05-55-44.json`, `load-test-2026-10-03T05-58-10.json`. All figures are measured values from those files._

|  |  |
|---|---|
| **Target** | Freshdesk trial account (`https://bicycle.freshdesk.com`) |
| **Test type** | Controlled authenticated API validation (read-only, low volume) |
| **Purpose** | Validate the load-testing framework against a real SaaS API |
| **Measured** | Latency, throughput, errors, HTTP 429 / rate-limit behaviour |

> **Important: this is NOT a Freshdesk capacity benchmark.** The account is a shared SaaS service with a per-account API rate limit, so load was kept deliberately small and the run is designed to stop when Freshdesk starts rate limiting. Nothing here says how many users or requests per second Freshdesk can handle. These numbers are **separate from, and not comparable with,** the local mock capacity / stress results in [performance-report.md](performance-report.md).

## 1. Summary

- **Authentication / connectivity:** validated: one authenticated `GET /api/v2/tickets` returned HTTP 200 in 186 ms, a valid JSON array of 3 tickets.
- **Smoke test:** PASS: 1 VU for 20s, 15 requests across 3 endpoints (15 x HTTP 200), checks passed 100.0%.
- **Controlled run:** 3 of 4 planned stages reached (1 -> 5 -> 10 -> 20 VUs planned; reached 1, 5, 10).
- **Safety stop:** the run was **stopped by the HTTP 429 safety rule** during the 10-VU stage (`rate_limited{stage:s03_10vus,phase:steady}: rate<0.05` crossed). Later stages were not run.
- **HTTP 429:** first seen in steady state at 10 VUs; 2 x 429 in the whole run. Freshdesk reported a quota of 50 requests/minute; the lowest remaining quota seen in a response header was 0.
- **Errors (steady state):** 0 x 4xx (excluding 429), 0 x 5xx, 0 timeouts.

## 2. Test Configuration

| Setting | Value |
|---|---|
| Base URL | `https://bicycle.freshdesk.com` (API under `/api/v2`) |
| Authentication | HTTP Basic; API key read from the `FRESHDESK_API_KEY` environment variable (value never logged or stored) |
| Operations | Read-only: `GET /api/v2/tickets`, `GET /api/v2/contacts`, `GET /api/v2/tickets/:id`. No create / update / delete. |
| Traffic mix | tickets 40%, contacts 30%, ticket_get 30% |
| Think time per VU | 3-6 s between requests |
| Stages | 1 VUs (30s) -> 5 VUs (30s) -> 10 VUs (30s) -> 20 VUs (30s) |
| Per stage | ramp 0 -> N over `15s`, hold, ramp down over `5s`, cool down `10s`; numbers from the hold only |
| 429 safety stop | abort when the 429 share reaches 5% in any stage's hold or over the whole run |
| On HTTP 429 | the VU pauses for `Retry-After` seconds (capped) before continuing: the limit is respected, never bypassed |
| Request timeout | 10s |
| Run window | 2026-10-03 05:55:46 UTC to 2026-10-03 05:58:10 UTC (144 s) |
| Load generator | k6 on one machine, over the public internet (latency includes that network path) |

## 3. Validation (one authenticated request)

| Check | Result |
|---|---|
| Request | `GET /api/v2/tickets` (exactly one request) |
| Domain reachable | yes |
| Authentication | accepted |
| Response valid | yes: JSON array, 3 tickets |
| Latency | 186 ms |
| Rate-limit headers | total 50/min, remaining 49, this request used 1 |
| UI path ignored | `/a/ask-freddy` |
| Credential in output | no: only `keyConfigured: true` is recorded |

## 4. Smoke Test

| VUs | Duration | Requests | Status codes | P50 | P95 | P99 | Max | 429 | Checks | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 20s | 15 | 15 x HTTP 200 | 154 | 329 | 359 | 366 | 0 | 100.0% | PASS |

## 5. Controlled Run Results

Steady-state (hold) samples only; latency in ms; throughput = requests / measured hold seconds.
Sample sizes are small (7-32 requests per stage), so P95 / P99 are effectively the slowest one or two requests of the stage; treat them as indicative.

| VUs | Hold | Requests | Successful | 4xx (excl. 429) | 429 | 5xx | Timeouts | P50 | P95 | P99 | Throughput |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 30 s | 7 | 7 | 0 | 0 | 0 | 0 | 165 | 418 | 424 | 0.23 req/s (14/min) |
| 5 | 30 s | 32 | 32 | 0 | 0 | 0 | 0 | 152 | 314 | 377 | 1.07 req/s (64/min) |
| 10 | 9 s | 20 | 18 | 0 | 2 | 0 | 0 | 147 | 264 | 289 | 2.30 req/s (138/min) |
| 20 | not run (test stopped earlier) |  |  |  |  |  |  |  |  |  |  |

**Whole run** (all phases including ramps and cool-downs; `Total requests` also counts the preflight request):

| Total requests | Successful | 4xx excl. 429 / no response | 429 | 5xx | Timeouts | P50 | P95 | P99 | Max | Avg throughput |
|---|---|---|---|---|---|---|---|---|---|---|
| 91 | 88 | 0 | 2 | 0 | 0 | 153 | 343 | 407 | 425 | 0.63 req/s |

### Latency by endpoint (P50 / P95 / P99 ms, steady state)

| Endpoint | 1 VUs | 5 VUs | 10 VUs |
|---|---|---|---|
| `contacts_list` | 403 / 423 / 424 | 313 / 387 / 401 | 263 / 292 / 295 |
| `ticket_get` | 154 / 155 / 156 | 140 / 179 / 186 | 146 / 192 / 198 |
| `tickets_list` | 151 / 164 / 165 | 152 / 197 / 207 | 145 / 163 / 168 |

## 6. Rate Limiting (HTTP 429)

| VUs | Approx. offered rate (VUs x 60 / mean think time) | Measured rate (hold) | 429 responses | 429 share |
|---|---|---|---|---|
| 1 | ~13/min | 14/min | 0 | 0.00% |
| 5 | ~67/min | 64/min | 0 | 0.00% |
| 10 | ~133/min | 138/min | 2 | 10.00% |

- Freshdesk's `X-Ratelimit-Total` header reported **50 requests per minute** for this account (the quota is per account, per minute, across all API clients).
- `X-Ratelimit-Remaining` over the run: max 49, median 29, **min 0** (the quota was fully used at least once).
- `Retry-After` on 429 responses: min 13 s, max 13 s. The VU that received it paused for `Retry-After` seconds, capped at `MAX_BACKOFF_SEC` (default 10 s), instead of retrying immediately.
- The configured 429 safety rule fired and k6 stopped the test (exit code 99). This is the intended behaviour: the run backs off when the provider says so and makes no attempt to get around the limit.
- 429s are counted separately from application errors: they show the account's API quota, not a Freshdesk failure.

## 7. Error Handling Observed

Status codes per stage (steady state):

| VUs | 200 | 429 |
|---|---|---|
| 1 | 7 | 0 |
| 5 | 32 | 0 |
| 10 | 18 | 2 |

- Response checks (status, JSON shape, ticket ID match) passed: 100.0% of checks run.
- Checks run after the 429 back-off pause. The VUs that received a 429 were still paused when the safety stop ended the test, so those responses have no check result; they are counted in the 429 column above.
- Error classes are tracked separately: 4xx (excluding 429), 429, 5xx, timeouts / no response.

## 8. What This Shows / Does Not Show

**Shows (measured):**
- The framework authenticates to a real SaaS API with a key taken only from the environment; the key never appears in output.
- Real request latency from this machine to the Freshdesk API, per endpoint, at the low concurrency levels listed above.
- Whether and where this account's API quota returned HTTP 429, and that the framework detects it, honours `Retry-After` and stops safely.

**Does not show:**
- Freshdesk's capacity. Any limit seen here is this trial account's API quota, not the service's throughput limit.
- Behaviour on paid plans (higher quotas), from other regions, or with write traffic (none was sent).
- Anything about the local mock results: those are a separate experiment on a different system.

## 9. Reproduce

```bash
# .env (git-ignored): FRESHDESK_BASE_URL=https://<your-domain>.freshdesk.com and FRESHDESK_API_KEY=<your key>
npm run freshdesk:validate   # one authenticated GET
npm run freshdesk:smoke      # 1 VU, 20 s
npm run freshdesk            # controlled 1 -> 5 -> 10 -> 20 VU run, stops on 429
npm run report:freshdesk     # this report
```
