# ADR-0002: Cap enforcement with conditional upserts in Postgres

- Status: Accepted
- Date: 2026-10-15

## Context

Buyers have hourly and daily caps. Many router workers run concurrently and may be considering the
same buyer at the same moment. A read-then-write check (`SELECT count ... ; if count < cap then sell`)
oversells under concurrency. A ping-post round trip to the buyer takes hundreds of milliseconds, so we
cannot hold a lock for its duration.

Options considered:

1. **Redis Lua script** that checks and increments counters atomically. Fast and contention-free for
   Postgres, but the counter lives in a different store from the sale record, so the two can drift
   (Redis restart, failed release, crash between steps) and need reconciliation to be trusted for
   billing.
2. **`SELECT ... FOR UPDATE` on the buyer row** for the whole ping-post. Correct, but holds a row lock
   across a network call and serializes all traffic for a buyer.
3. **Conditional upsert on a counter row per (buyer, window)**, as a reservation that is later
   committed or released.

## Decision

Option 3. Reserve with one statement per window:

```sql
INSERT INTO buyer_cap_usage (buyer_id, window_kind, window_start, used)
VALUES ($1, $2, $3, 1)
ON CONFLICT (buyer_id, window_kind, window_start)
DO UPDATE SET used = buyer_cap_usage.used + 1
WHERE buyer_cap_usage.used < $4
RETURNING used;
```

No row returned means the cap is full. Hourly and daily reservations are taken in one short
transaction so that both succeed or neither does. If the buyer then rejects the lead or times out, a
compensating decrement releases the slot. The lock is held only for the duration of the statement,
never across the buyer call.

## Consequences

- Never oversells: the row lock taken by `ON CONFLICT DO UPDATE` serializes concurrent reservations.
- Can *under*-fill: if a worker crashes after reserving and before releasing, the slot stays used
  until the window rolls over. A reconciliation job (roadmap M5) can recompute usage from
  `routing_decisions`. For billing, under-filling is the safe failure direction.
- A very hot buyer serializes on one counter row. If that becomes the bottleneck, the counter can
  be sharded (N rows per window, sum on read) or moved to Redis with periodic reconciliation.
- Windows are UTC hours and UTC days in this version; buyer-local day boundaries are a roadmap item.
