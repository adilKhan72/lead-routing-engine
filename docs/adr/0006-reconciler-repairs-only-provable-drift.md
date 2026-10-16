# ADR-0006: The reconciler repairs only provable drift

**Status:** Accepted (M5)

## Context
Two failure modes escape the hot path's guarantees:
1. **Stuck leads.** A lead is published and undecided, but nothing will deliver it again: its stream entry was lost
   to Redis data loss or `MAXLEN ~` trimming, and the outbox sweeper only covers leads that were never published.
2. **Leaked cap slots.** A router that dies between reserving a cap slot and releasing it leaves the slot counted
   as used. The cap is never exceeded (ADR-0002), but the buyer is under-filled until the window rolls over.

## Decision
A one-shot reconciler, run every minute by a Kubernetes CronJob (`concurrencyPolicy: Forbid`):

- **Stuck leads:** status `received`/`routing`, published, older than `STUCK_AFTER_MS`, with no live lease, and not
  re-published within that window are **re-published** (`FOR UPDATE SKIP LOCKED`, at most `MAX_REPUBLISH_PER_RUN`).
  Routers are idempotent on lead id (claims, leases and fencing from ADR-0003), so a duplicate delivery is harmless.
  After `MAX_REPUBLISH_PER_LEAD` attempts a lead is **reported, not retried**: it needs a human.
- **Leaked slots:** for each current hour/day cap row, under a row lock:
  `released = max(0, used − sold_in_window − leads_in_flight)`, then `used -= released`.
  - Repairs only ever **decrease** `used`.
  - Ping-post is sequential, so each in-flight lead holds at most one reservation. `used − sold − in_flight` is
    therefore a lower bound on leaked slots, and a repair can never enable an oversell.
  - Leads whose lease expired within `LEASE_GRACE_MS` still count as in flight, so a slow worker that releases
    its slot just after its lease ends can't cause a double decrement.
  - Boundary effects (a sale decided in the window after it reserved) only make the repair more conservative.
- Every run is recorded in `reconciliation_runs` (including dry runs) for audit and alerting. `DRY_RUN=true` reports
  without changing anything.

## Consequences
- Stuck leads recover within minutes, not never. Leaked slots are recovered within the window, not at its end.
- In-flight leads are counted across **all** buyers, which is conservative: with heavy concurrent traffic some leaked
  slots may wait for a quieter run. That's the price of never risking an oversell.
- A worker that outlives its lease by more than the grace period and *then* releases its slot can still
  double-decrement. With a 2 s routing budget and a 60 s grace, that needs a ~1 minute stall. That's documented, not eliminated.

## Operational note
The reconciler is its own workload, so anything that allow-lists database clients must include it. The demo
overlay's NetworkPolicies initially admitted only `ingest` and `router`; on a NetworkPolicy-enforcing cluster the
reconciler's connections hung until `activeDeadlineSeconds` killed the Job. The kind smoke test caught this.
