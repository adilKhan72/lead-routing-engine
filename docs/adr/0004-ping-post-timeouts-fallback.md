# ADR-0004: Ping-post timeouts and fallback

- Status: Accepted
- Date: 2026-10-15

## Context

In ping-post, the router first **pings** a buyer with an anonymised lead (no contact details) and the
buyer answers with accept/reject and optionally a bid; on accept the router **posts** the full lead.
Buyer endpoints are third-party systems with unpredictable latency. A lead loses value quickly, so
the whole routing attempt has a budget (default 2 s), and one slow buyer must not consume all of it.

## Decision

- Each buyer has its own `timeout_ms` for ping and for post (default 300 ms ping / 500 ms post),
  further capped by the time remaining in the lead's overall budget. Calls use
  `AbortSignal.timeout` so a hung socket is actually torn down.
- Buyers are tried **sequentially** in the order from the selection step (price, then weighted
  random). A timeout, a non-2xx response, a malformed response or a reject all mean "move to the next
  buyer" and are recorded as a per-buyer attempt outcome.
- Cap reservation happens before the ping, and is released on any failure, so two workers cannot
  both ping a buyer for its last remaining slot.
- When the budget is exhausted the lead is recorded as `unsold` with reason `budget_exhausted`.
- Transport failures to Postgres or Redis are *not* treated as a buyer failure: they abort the
  attempt, the message is not acked, and the retry/backoff path (ADR-0003) takes over.

## Consequences

- Predictable worst-case latency: bounded by the budget, not by the slowest buyer.
- Sequential pinging leaves money on the table compared with a parallel auction (ping everyone,
  post to the best bid). A parallel "ping-all, post-best" mode is a natural extension: the selection
  step already produces an ordered list and the reservation model supports it, but it complicates cap
  handling (reserving a slot at every pinged buyer) and is deferred.
- A post that times out is ambiguous: the buyer may have received and kept the lead. We treat it as
  a failure, release the cap and fall back to the next buyer, so in the worst case two buyers hold
  the lead while only one is billed. Buyers get the lead id with every call so disputes can be
  traced. This is documented as a known limitation rather than hidden.
