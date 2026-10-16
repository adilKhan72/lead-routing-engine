# lead-routing-engine

An event-driven engine that routes inbound consumer leads (loan or insurance enquiries) to the best
eligible buyer, in a ping-post flow, within a latency budget, without ever selling the same lead twice
or letting a buyer exceed their cap, under concurrent load.

> **Status: in progress, built in public.** The design below is the target; the [roadmap](#roadmap)
> says what is actually implemented. Numbers in this README are only ever measured ones. Anything not
> yet measured or validated says so.

## The problem

A lead marketplace receives enquiries from publishers and sells each one to a single buyer. Buyers
configure:

- **Filters**: which leads they want (US state, requested amount range, credit band, product).
- **Price**: what they pay per lead. Higher-paying buyers are tried first.
- **Caps**: maximum leads per day and per hour. Overselling a cap is a billing dispute.
- **Schedules**: the hours, in their own time zone, during which they accept leads.
- **Weight**: how traffic is shared between buyers that pay the same price.

A lead is worth most in the first seconds after submission, so routing has a latency budget. Buyer
endpoints are slow or unreliable, so every call to one has a timeout and a fallback to the next buyer.
The hard requirements are business ones:

1. A publisher retrying a request must not create a second lead.
2. A lead is sold **at most once**, and every accepted lead eventually reaches a final state
   (sold, unsold, or dead-lettered for a human).
3. A buyer's cap is **never exceeded**, even with many router workers running concurrently.

## Architecture

```mermaid
flowchart LR
    P[Publisher] -->|POST /v1/leads<br/>Idempotency-Key| I[ingest<br/>Fastify]
    I -->|INSERT lead<br/>unique idempotency key| PG[(PostgreSQL)]
    I -->|XADD lead.received| RS[[Redis Stream<br/>leads.received]]
    I -.->|sweeper republishes<br/>unpublished leads| RS
    RS -->|XREADGROUP<br/>consumer group| R1[router worker 1]
    RS --> R2[router worker N]
    R1 -->|claim lead, reserve cap,<br/>record decision| PG
    R1 -->|ping / post<br/>timeout + fallback| B1[Buyer A]
    R1 --> B2[Buyer B]
    R1 -->|after N failed deliveries| DLQ[[leads.dead-letter]]
    R1 -->|/metrics| M[Prometheus]
```

| Component | Responsibility |
|---|---|
| `services/ingest` | Validates the lead (zod), enforces the idempotency key, persists the lead, publishes `lead.received`, answers `202 Accepted`. |
| `services/router` | Consumer-group worker. Claims a lead, finds eligible buyers, orders them, reserves cap, pings/posts with timeouts, records the decision, acks. Retries with backoff; dead-letters after N deliveries. |
| `packages/shared` | Lead schema, config, logging, Postgres/Redis clients, migrations. |
| PostgreSQL | Source of truth: buyers, leads, cap counters, routing decisions. |
| Redis Streams | Work queue between ingest and routers (consumer groups, pending entries list, DLQ stream). |

## Routing algorithm

For each lead the router:

1. **Claims** the lead with a conditional `UPDATE ... WHERE status = 'received' OR lease expired`.
   A duplicate message for a lead that is already final is acked. If another worker holds a live
   lease the message is left pending and looked at again later, so a crash of that worker can't
   strand the lead.
2. **Filters** buyers: active, inside their schedule (evaluated in the buyer's time zone), and matching
   every filter on the lead.
3. **Orders** candidates: by price descending; within an equal price, a weighted random shuffle
   (Efraimidis-Spirakis keys `u^(1/w)`), so a buyer with weight 3 is first three times as often as one
   with weight 1. The random source is injected, so tests are deterministic.
4. **Walks the list**. For each candidate: atomically reserve a slot in its hourly and daily cap
   counters (a conditional upsert that fails when the cap is full), ping/post with a timeout, and
   either commit the sale or release the reservation and move on to the next buyer.
5. **Records** the decision (sold to X at price P, or unsold with the reasons each buyer was skipped)
   and acks the stream message.

## Guarantees

| Guarantee | How |
|---|---|
| Publisher retries don't duplicate leads | `Idempotency-Key` header is unique in Postgres. A replay returns the original lead id; the same key with a different payload is a `409`. |
| No lead is lost between Postgres and Redis | The `leads` table doubles as the outbox: a lead is `published_at IS NULL` until `XADD` succeeds, and a sweeper republishes stragglers. |
| Delivery to the router | At-least-once: messages are acked only after the decision is committed; unacked messages are reclaimed. |
| Each lead sold at most once | Idempotent consumer: lead claim with a lease and fencing token, plus a unique constraint on `routing_decisions(lead_id)` (one final decision per lead). At-least-once delivery + idempotent consumer = **effectively-once** from the business's point of view. |
| Caps never exceeded | Cap counters are reserved with a single-statement conditional upsert in Postgres, so concurrent workers serialize on the counter row. A crash between reserve and release can *under*-fill a cap, never overfill it. |
| Poison messages don't block the stream | Unacked messages are re-claimed (`XPENDING` + `XCLAIM`) once their idle time exceeds an exponential backoff for their delivery count; after `MAX_DELIVERIES` they move to `leads.dead-letter` (`XADD` + `XACK` in one `MULTI`) and the lead is marked `failed`. The router refuses to start if a lease could outlive the retry window. |
| A crashed worker doesn't strand work | Its unacked messages are re-claimed by other consumers; its lease on the lead expires and the lead is re-claimed with a new fencing token. |

What is deliberately **not** guaranteed: exactly-once *delivery* (nobody has that; we de-duplicate
instead), and exactly-once calls to buyer endpoints (a crash after a buyer accepted but before the
decision is committed can lead to a second post on retry; buyers receive the lead id so they can
de-duplicate, which is the standard contract in ping-post integrations).

Design decisions and their trade-offs are in [`docs/adr/`](docs/adr):

- [ADR-0001: Redis Streams instead of Kafka](docs/adr/0001-redis-streams-over-kafka.md)
- [ADR-0002: Cap enforcement with conditional upserts in Postgres](docs/adr/0002-cap-enforcement.md)
- [ADR-0003: Idempotency and effectively-once processing](docs/adr/0003-idempotency-effectively-once.md)
- [ADR-0004: Ping-post timeouts and fallback](docs/adr/0004-ping-post-timeouts-fallback.md)
- [ADR-0005: Sliding-window consumer concurrency](docs/adr/0005-sliding-window-consumer.md)

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 | README, ADRs, licence | Done |
| M1 | npm-workspaces monorepo (TS strict, ESLint, Vitest), ingest service with validation and idempotency, Postgres migrations, docker-compose, CI with integration tests against Postgres and Redis | Done |
| M2 | Router worker: eligibility filters, atomic caps, tier + weighted selection, consumer group with ack / retry / DLQ, idempotent processing, concurrency tests | Done (buyer calls are simulated: every buyer accepts until M3) |
| M3 | Ping-post over HTTP with timeouts and fallback (mock buyer server), Prometheus metrics, k6 load test | Done (load test run on a laptop only, see below) |
| M4 | Kubernetes: kustomize base + demo/production overlays, KEDA autoscaling on stream lag, schema validation and a kind smoke test in CI | Done (multi-node load test not run) |
| M5 | Reconciliation: cap counters vs sales ledger, and re-publishing leads stuck in `received` / `routing` with no stream entry (Redis data loss, stream trimming); buyer admin API; OpenTelemetry tracing | Planned |

## Kubernetes

`deploy/k8s/` holds a kustomize **base**, two **overlays** and a **KEDA component**:

| | |
|---|---|
| `base/` | ingest + router Deployments, migrations as an **init container** (safe concurrently: the runner holds a Postgres advisory lock), probes on `/healthz` / `/readyz`, `preStop` delay + SIGTERM draining, non-root read-only containers, PodDisruptionBudgets, default-deny NetworkPolicies, CPU HPA for ingest |
| `components/keda/` | routers autoscale on **consumer-group backlog** (`max(lre_stream_group_lag)`, 200 entries per replica, 2–20 replicas), not CPU: a router waiting on slow buyers is idle on CPU while the stream grows |
| `overlays/demo/` | self-contained: in-cluster Postgres, Redis and mock buyers, with generated demo secrets |
| `overlays/production/` | managed Postgres/Redis, `lre-secrets` from an external secret store, a pinned image tag, KEDA |

Router pods get `CONSUMER_NAME` from their pod name (downward API), so every replica is a distinct consumer-group
member. CI validates both overlays with `kubeconform` (including the KEDA CRD schema) and runs **`scripts/k8s-smoke.sh` on a
kind cluster**: build the image, deploy the demo overlay, seed buyers, POST a lead through the ingest Service, and
require it to be **sold**.

```bash
kubectl apply -k deploy/k8s/overlays/demo && scripts/k8s-smoke.sh   # any local cluster (kind, k3d, minikube)
```

## Running locally

Requires Docker (and Node 22+ for development).

```bash
docker compose up --build -d          # postgres, redis, migrations, ingest on :3000, 2 routers, mock buyers
docker compose exec -T postgres psql -U lre lre < db/seed/demo-buyers.sql
curl -i -X POST http://localhost:3000/v1/leads \
  -H 'content-type: application/json' -H 'idempotency-key: demo-0001' \
  -d '{"product":"personal_loan","state":"TX","zip":"73301","amountCents":1500000,"creditBand":"good",
       "contact":{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com","phone":"+15555550123"},
       "consent":{"tcpa":true,"capturedAt":"2026-10-15T09:30:00Z"},"source":{"publisherId":"pub-1"}}'
# 202 {"leadId":"…","status":"received"}; repeat it and you get the same leadId with Idempotent-Replayed: true
curl -s http://localhost:3000/v1/leads/<leadId>   # {"status":"sold",...}
docker compose exec postgres psql -U lre lre -c 'SELECT outcome, buyer_id, price_cents, attempts FROM routing_decisions'
docker compose down -v
```

### API (ingest)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/leads` | Requires `Idempotency-Key` (8-255 chars). `202` with `leadId`; `400` with field-level issues; `409` if the key was used with a different payload; `413` over 16 KiB. |
| `GET` | `/v1/leads/:id` | Current lead status. |
| `GET` | `/healthz`, `/readyz` | Liveness; readiness checks Postgres and Redis. |

## Development

```
packages/shared     lead schema (zod), stream helpers, config, logger, pg/redis clients, migration runner
services/ingest     Fastify HTTP edge + outbox sweeper
services/router     consumer-group worker: eligibility, selection, caps, ping-post, retry/DLQ, metrics
services/mock-buyer simulated buyer endpoints (fast / picky / flaky / slow / never profiles)
loadtest            k6 script and the SQL report that checks invariants after a run
db/seed             demo buyers for local runs
db/migrations       plain SQL, applied in order under an advisory lock
scripts/build.mjs   esbuild: one bundle per service in dist/, so the runtime image has no node_modules
```

```bash
npm ci
npm run check                 # lint (typescript-eslint strict, type-aware) + typecheck + unit tests
npm run build                 # dist/ingest.js, dist/router.js, dist/mock-buyer.js, dist/migrate.js

# Integration tests need a real Postgres and Redis; they drop and recreate the public schema.
docker compose up -d postgres redis
DATABASE_URL=postgres://lre:lre@localhost:5432/lre REDIS_URL=redis://localhost:6379/1 npm run test:integration
```

Unit tests use in-memory fakes behind the same interfaces as the Postgres and Redis adapters, with the
clock and random source injected. Integration tests run the real adapters (CI uses Postgres 17 and
Redis 7 service containers). The ones that matter most:

- **No double-selling, caps exact:** 40 leads, every stream message published three times, four
  consumers racing; asserts one decision per lead, sales per buyer equal to their caps, and cap
  counters equal to the sales ledger.
- **Caps under contention:** 60 concurrent reservations against a cap of 10 grant exactly 10;
  hour and day windows are reserved together or not at all.
- **Retry and dead-letter:** a lead whose handler keeps failing is delivered `MAX_DELIVERIES` times
  with backoff, then dead-lettered and marked `failed`, without blocking the healthy lead behind it.
- **Crash recovery:** a consumer reads a message and claims the lead, then "dies"; another consumer
  re-claims the message, waits out the lease and sells the lead exactly once.

## Observability

Logs are structured JSON (pino) with contact details redacted. Metrics are Prometheus text format:
ingest on `GET /metrics` (same port as the API), router on `:9100/metrics`.

| Metric | Type | What it tells you |
|---|---|---|
| `lre_http_request_duration_seconds{method,route,status_code}` | histogram | Edge latency per route pattern. |
| `lre_leads_accepted_total{replayed}` | counter | Accepted leads, and how many were publisher retries. |
| `lre_routing_duration_seconds{outcome}` | histogram | Claim to commit, per outcome (`sold`, `unsold`, `duplicate`, `busy`, `lost_lease`). |
| `lre_routing_outcomes_total{outcome,reason}` | counter | Decisions, with the unsold reason. |
| `lre_buyer_call_duration_seconds{phase,result}` | histogram | Ping and post latency per result (`accepted`, `rejected`, `timeout`, `error`). |
| `lre_stream_group_lag` / `lre_stream_group_pending` | gauge | Undelivered backlog and in-flight/awaiting-retry messages, read from Redis at scrape time. Lag is the autoscaling signal. |
| `lre_routing_errors_total`, `lre_dead_lettered_total` | counter | Infrastructure errors (retried) and dead-lettered messages. |

## Load test results

[`loadtest/ingest.js`](loadtest/ingest.js) drives the HTTP edge with k6 at a constant arrival rate
(5% of requests are publisher retries re-sending an earlier key and body). Routing latency comes from
the decisions the routers record, via [`loadtest/report.sql`](loadtest/report.sql), which also checks
the invariants: no lead with two decisions, no cap exceeded, cap counters equal to the sales ledger.

**Setup, so the numbers can be judged:** one laptop (Intel i7-1165G7, 4 cores / 8 threads, 16 GB RAM,
about 1.5 GB of it free), with other workloads running. 1 ingest process, 2 router processes
(concurrency 32 each), 1 mock-buyer process, all on the host; Postgres 17 and Redis 7 in Docker
Desktop containers (256 MB / 64 MB memory limits), so every database and Redis call crosses the
Docker Desktop VM boundary; k6 v2.3.0 in a container reaching the API through `host.docker.internal`.
`LOG_LEVEL=warn`. Demo buyers from [`db/seed/demo-buyers.sql`](db/seed/demo-buyers.sql). This is a
smoke-level capacity check, not a benchmark of what the design can do on real infrastructure.

| Run | Offered rate | Accepted (HTTP p50 / p95 / p99) | Router time p50 / p95 / p99 | Accept → decision p50 / p95 / p99 | Stream lag after run | Invariants |
|---|---|---|---|---|---|---|
| Real ping-post (mock buyers), batch consumer (before fix) | 100/s for 30 s | 100% (14 / 114 / 205 ms) | 96 / 614 / 904 ms | 17.8 / 30.8 / 31.7 **s** | 1,145 | all hold |
| Real ping-post (mock buyers), sliding-window consumer | 100/s for 60 s | 100% (59 / 161 / 268 ms) | 175 / 1,128 / 1,565 ms | 0.40 / 1.87 / 2.40 s | 0 | all hold |
| Buyers out of the picture (`accept-all`) | 150/s for 60 s | 100% (24 / 87 / 214 ms) | 20 / 165 / 405 ms | 0.03 / 0.50 / 0.90 s | 0 | all hold |
| Buyers out of the picture (`accept-all`) | 300/s for 60 s | **only ~185/s achieved** (3.0 / 4.1 / 4.6 s) | 195 / 459 / 625 ms | 4.8 / 6.4 / 6.5 s | 84 | all hold |

What the runs showed:

- **The first run found a real bug in the design.** Routers read a batch, processed it with
  `Promise.all` and only then read again, so every batch waited for its slowest lead (a buyer timing
  out). At 100 leads/s the routers fell further behind every second. The consumer now keeps a sliding
  window of in-flight messages, with the blocking read on its own connection so acks never queue
  behind it, and the same load leaves no backlog.
- With real (simulated) buyers, routing time is dominated by buyer behaviour: the `slow` profile
  answers in 200-900 ms against a 300 ms ping timeout, and the `flaky` one returns 503s, so p95 sits
  around one second of fallbacks. That is the latency budget doing its job, not engine overhead.
- With buyers removed, two routers keep up with 150 leads/s at a 20 ms median. At 300/s offered, the
  single ingest process saturated at about 185 requests/s on this machine; this run is the
  machine's ceiling, not a sustainable operating point.
- Across all runs (about 28,000 leads), no lead was decided twice, no cap was exceeded, and every cap
  counter matched the sales ledger after the backlog drained.

One further run was discarded: a stray second k6 process from an interrupted invocation was hitting
the same stack, so its numbers measured double the stated load.

Not yet measured: multiple ingest replicas, Postgres on its own host, a hot buyer at scale, failure
injection (killing routers or Redis mid-run) under load.

## Licence

[MIT](LICENSE) © 2026 Adil Khan
