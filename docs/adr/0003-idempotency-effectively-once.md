# ADR-0003: Idempotency and effectively-once processing

- Status: Accepted
- Date: 2026-10-15

## Context

Exactly-once *delivery* across a network is not achievable. Publishers retry on timeouts, Redis
redelivers unacknowledged messages, and workers crash mid-flight. What the business needs is that a
lead is stored once and sold at most once, and that no lead is silently lost.

## Decision

**At the edge (ingest):**

- `Idempotency-Key` header is required. `leads.idempotency_key` is unique. Insert with
  `ON CONFLICT DO NOTHING`; on conflict, compare a SHA-256 hash of the canonical payload: same
  payload returns the original lead id (`202`, `Idempotent-Replayed: true`), a different payload
  returns `409`.
- **The `leads` table is the outbox.** A lead is inserted with `published_at = NULL`, then `XADD`ed,
  then marked published. If the process dies between the insert and the `XADD`, a sweeper republishes
  leads that have stayed unpublished longer than a grace period. This avoids a separate outbox table
  while keeping the dual write safe; the cost is that the stream may receive duplicates, which the
  consumer tolerates by design.

**In the router (idempotent consumer):**

- Claim: `UPDATE leads SET status = 'routing', claim_token = $new, lease_until = now() + lease
  WHERE id = $1 AND (status = 'received' OR (status = 'routing' AND lease_until < now()))`. Zero rows
  means another worker owns it or it is already final: ack and move on.
- The final decision is written in the same transaction that moves the lead to `sold` / `unsold`.
  That update is fenced on `claim_token`, so a worker whose lease expired and was taken over cannot
  commit a stale decision. `routing_decisions.lead_id` is unique as a last line of defence.
- The stream message is acked only after that transaction commits.
- A lead held by another worker's live lease is reported *busy* and its message is **not** acked: if
  we acked it and that worker then crashed, nothing would ever route the lead. The message is
  retried with backoff; by then the lead is final (ack) or the lease has expired (re-claim). This
  only works if a lease is shorter than the whole retry window, otherwise a busy lead could be
  dead-lettered while it is still being routed, so the router checks that at startup.

## Consequences

- Effectively-once from the business's point of view: duplicates are absorbed at both the edge and
  the consumer.
- A buyer endpoint can be called twice for the same lead if a worker crashes after the buyer accepted
  but before the commit. We send the lead id with every ping and post so buyers can de-duplicate, and
  record it as a known limitation rather than pretending otherwise.
- Idempotency keys are scoped globally in this version; per-publisher scoping arrives with publisher
  authentication.
