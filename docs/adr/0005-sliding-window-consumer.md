# ADR-0005: Sliding-window consumer concurrency

- Status: Accepted
- Date: 2026-10-15

## Context

The first router read a batch with `XREADGROUP COUNT n`, handled it with `Promise.all`, and only
then read the next batch. Routing time per lead is dominated by buyer calls and varies from a few
milliseconds to the full latency budget (a slow buyer times out, the router falls back). With batch
processing, throughput is roughly `n / slowest lead in the batch`, not `n / average lead`.

The first k6 run (100 leads/s, real ping-post against simulated buyers, 2 routers) confirmed it: the
consumer group's lag grew throughout the run and the median time from accept to decision was about
18 seconds, while the median routing time per lead was under 100 ms.

## Decision

Each router keeps up to `CONCURRENCY` messages in flight (default 32) and reads new ones as soon as a
slot frees up (`COUNT` = free slots). The blocking `XREADGROUP` runs on a dedicated Redis connection,
because a blocked connection would otherwise hold back the `XACK`s of handlers that just finished.
The retry pass (`XPENDING` / `XCLAIM`) only claims as many messages as there are free slots.

## Consequences

- At the same 100 leads/s the lag stays at zero and the median accept-to-decision time drops to
  0.4 s (see the README's load test table).
- In-flight work is bounded per process, so Postgres connections and buyer sockets stay bounded:
  `CONCURRENCY` and `PG_POOL_SIZE` are tuned together.
- Ordering between leads is not preserved (it was not a requirement, see ADR-0001).
- Shutdown waits for the window to drain; anything still unacked is reclaimed by other routers.
