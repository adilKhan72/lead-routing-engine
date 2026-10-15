# ADR-0001: Redis Streams instead of Kafka

- Status: Accepted
- Date: 2026-10-15

## Context

Ingest and routing are decoupled by a queue so that publishers get a fast `202`, routers can scale
horizontally, and a slow buyer does not back-pressure the HTTP edge. We need consumer groups,
per-message acknowledgement, redelivery of unacknowledged work, and a dead-letter path. Expected
volume is thousands of leads per minute, not millions per second, and every lead is processed
independently (no ordering requirement between leads).

## Decision

Use **Redis Streams** with a consumer group (`XADD`, `XREADGROUP`, `XACK`, `XPENDING`, `XCLAIM`).
A second stream, `leads.dead-letter`, receives messages that exceeded the delivery limit.

## Consequences

- One small dependency that most teams already run; trivial local setup and CI service container.
- Per-message ack and the pending entries list (PEL) give us redelivery and delivery counts for free,
  which maps directly onto retry-with-backoff and dead-lettering. Kafka acks are offset-based per
  partition, so a single slow lead would hold back its partition or force an external retry topic.
- Durability depends on Redis persistence (AOF `everysec` can lose up to a second of writes). This is
  acceptable because Postgres is the source of truth: a lead whose stream entry is lost is still
  `published_at IS NULL` or stuck in `received`, and the sweeper republishes it (ADR-0003).
- Retention and replay are weaker than Kafka's. We trim the stream by length; the audit trail lives
  in `routing_decisions`, not in the stream.
- If volume grows by orders of magnitude, or other teams need to consume `lead.received` with
  independent retention, Kafka (or Redpanda) becomes the better fit. The publisher and consumer sit
  behind small interfaces so the transport can be swapped.
