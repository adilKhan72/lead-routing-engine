-- Run after a load test: what the routers did with the leads, and how long it took.
-- psql -f loadtest/report.sql   (against the same database the stack used)

-- Outcomes.
SELECT status, count(*) AS leads FROM leads GROUP BY status ORDER BY status;

-- Time inside the router (claim -> commit, includes buyer calls) and end to end
-- (HTTP accept -> decision committed, includes queueing), in milliseconds.
SELECT
  count(*)                                                                       AS decisions,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY d.latency_ms)                     AS router_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY d.latency_ms)                     AS router_p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY d.latency_ms)                     AS router_p99_ms,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM l.decided_at - l.received_at) * 1000) AS e2e_p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM l.decided_at - l.received_at) * 1000) AS e2e_p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM l.decided_at - l.received_at) * 1000) AS e2e_p99_ms
FROM routing_decisions d JOIN leads l ON l.id = d.lead_id
WHERE d.outcome IN ('sold', 'unsold');

-- Invariants: these must all return zero rows.
SELECT 'lead with more than one decision' AS violation, lead_id FROM routing_decisions GROUP BY lead_id HAVING count(*) > 1;
SELECT 'daily cap exceeded' AS violation, b.name, u.used, b.daily_cap
FROM buyer_cap_usage u JOIN buyers b ON b.id = u.buyer_id
WHERE u.window_kind = 'day' AND u.used > b.daily_cap;
SELECT 'hourly cap exceeded' AS violation, b.name, u.used, b.hourly_cap
FROM buyer_cap_usage u JOIN buyers b ON b.id = u.buyer_id
WHERE u.window_kind = 'hour' AND u.used > b.hourly_cap;
SELECT 'cap counter differs from sales ledger' AS violation, b.name, u.used, count(d.id) AS sold
FROM buyer_cap_usage u
JOIN buyers b ON b.id = u.buyer_id
LEFT JOIN routing_decisions d ON d.buyer_id = u.buyer_id AND d.outcome = 'sold'
  AND d.created_at >= u.window_start
  AND d.created_at < u.window_start + CASE u.window_kind WHEN 'hour' THEN interval '1 hour' ELSE interval '1 day' END
GROUP BY b.name, u.used, u.window_kind, u.window_start
HAVING u.used <> count(d.id);
