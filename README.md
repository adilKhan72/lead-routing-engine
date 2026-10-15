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

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 | README, ADRs, licence | Done |
| M1 | npm-workspaces monorepo (TS strict, ESLint, Vitest), ingest service with validation and idempotency, Postgres migrations, docker-compose, CI with integration tests against Postgres and Redis | Done |
| M2 | Router worker: eligibility filters, atomic caps, tier + weighted selection, consumer group with ack / retry / DLQ, idempotent processing, concurrency tests | Done (buyer calls are simulated: every buyer accepts until M3) |
| M3 | Ping-post over HTTP with timeouts and fallback (mock buyer server), Prometheus metrics, k6 load test | Planned |
| M4 | Kubernetes manifests (kustomize), HPA on stream lag, load test results in this README | Planned |
| M5 | Reconciliation: cap counters vs sales ledger, and re-publishing leads stuck in `received` / `routing` with no stream entry (Redis data loss, stream trimming); buyer admin API; OpenTelemetry tracing | Planned |

## Running locally

Requires Docker (and Node 22+ for development).

```bash
docker compose up --build -d          # postgres, redis, migrations, ingest on :3000, 2 router replicas
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
services/router     consumer-group worker: eligibility, selection, caps, retry/DLQ
db/seed             demo buyers for local runs
db/migrations       plain SQL, applied in order under an advisory lock
scripts/build.mjs   esbuild: one bundle per service in dist/, so the runtime image has no node_modules
```

```bash
npm ci
npm run check                 # lint (typescript-eslint strict, type-aware) + typecheck + unit tests
npm run build                 # dist/ingest.js, dist/migrate.js

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

## Load test results

Not yet run. This section will hold the k6 scenario, the hardware it ran on, and the measured
throughput and latency percentiles once M3 lands.

## Licence

[MIT](LICENSE) © 2026 Adil Khan
