import { publishLeadReceived, withTransaction, type Pool, type Redis } from '@lre/shared';

/**
 * Reconciler (ADR-0006): repairs the two kinds of drift that the hot path can't prevent on its own.
 *
 * 1. Stuck leads: published and not decided, with no live lease and nothing re-delivering them (stream entry lost
 *    to Redis data loss or MAXLEN trimming). They're re-published; routers are idempotent on lead id, so a duplicate
 *    delivery is harmless.
 * 2. Leaked cap slots: a router that dies between reserve and release leaves a slot counted as used, so the buyer
 *    is under-filled. Repairs only ever DECREASE `used`, and never below what sales plus in-flight leads could
 *    account for, so a repair can't enable an oversell.
 */

export interface ReconcileOptions {
  now: Date;
  /** A lead must be at least this old (and not re-published this recently) to count as stuck. */
  stuckAfterMs: number;
  /** Leads whose lease expired within this grace period still count as in flight. */
  leaseGraceMs: number;
  maxRepublishPerRun: number;
  /** After this many re-publishes a lead is reported for a human instead of retried forever. */
  maxRepublishPerLead: number;
  dryRun: boolean;
}

export interface CapRepair {
  buyerId: string;
  windowKind: 'hour' | 'day';
  windowStart: string;
  used: number;
  sold: number;
  inFlight: number;
  released: number;
}

export interface ReconcileReport {
  republished: string[];
  exhausted: number;
  capRepairs: CapRepair[];
  slotsReleased: number;
  dryRun: boolean;
}

/** Upper bound on slots that can't be explained by sales or in-flight work. Never negative. */
export function leakedSlots(used: number, sold: number, inFlight: number): number {
  return Math.max(0, used - sold - inFlight);
}

export function currentWindows(now: Date): { kind: 'hour' | 'day'; start: Date; end: Date }[] {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return [
    { kind: 'hour', start: hour, end: new Date(hour.getTime() + 3_600_000) },
    { kind: 'day', start: day, end: new Date(day.getTime() + 86_400_000) },
  ];
}

export async function republishStuckLeads(pool: Pool, redis: Redis, o: ReconcileOptions): Promise<{ republished: string[]; exhausted: number }> {
  const cutoff = new Date(o.now.getTime() - o.stuckAfterMs);
  const leaseCutoff = new Date(o.now.getTime() - o.leaseGraceMs);

  const { rows: exhaustedRows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM leads
     WHERE status IN ('received', 'routing') AND published_at IS NOT NULL AND republish_count >= $1`,
    [o.maxRepublishPerLead],
  );

  const republished = await withTransaction(pool, async (tx) => {
    // SKIP LOCKED: two reconciler runs never pick the same lead.
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM leads
       WHERE status IN ('received', 'routing')
         AND published_at IS NOT NULL
         AND received_at < $1
         AND (lease_until IS NULL OR lease_until < $2)
         AND (last_republished_at IS NULL OR last_republished_at < $1)
         AND republish_count < $3
       ORDER BY received_at
       LIMIT $4
       FOR UPDATE SKIP LOCKED`,
      [cutoff, leaseCutoff, o.maxRepublishPerLead, o.maxRepublishPerRun],
    );
    const ids = rows.map((r) => r.id);
    if (o.dryRun || ids.length === 0) return ids;

    // Record first, publish second: if publishing fails the transaction rolls back and the next run retries.
    await tx.query(
      `UPDATE leads SET republish_count = republish_count + 1, last_republished_at = $2 WHERE id = ANY($1)`,
      [ids, o.now],
    );
    for (const id of ids) await publishLeadReceived(redis, id);
    return ids;
  });

  return { republished, exhausted: Number(exhaustedRows[0]?.n ?? 0) };
}

export async function repairCaps(pool: Pool, o: ReconcileOptions): Promise<CapRepair[]> {
  const leaseCutoff = new Date(o.now.getTime() - o.leaseGraceMs);

  return withTransaction(pool, async (tx) => {
    // Sequential ping-post: a lead holds at most one reservation at a time, so the number of in-flight leads
    // bounds the number of legitimately outstanding reservations (across all buyers, which is conservative).
    const { rows: inflightRows } = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM leads WHERE status = 'routing' AND lease_until > $1`,
      [leaseCutoff],
    );
    const inFlight = Number(inflightRows[0]?.n ?? 0);
    const repairs: CapRepair[] = [];

    for (const w of currentWindows(o.now)) {
      // FOR UPDATE: concurrent reserve/release wait for this transaction, so the counts can't shift underneath.
      const { rows } = await tx.query<{ buyer_id: string; used: number; sold: string }>(
        `SELECT u.buyer_id, u.used,
                (SELECT count(*) FROM routing_decisions d
                  WHERE d.outcome = 'sold' AND d.buyer_id = u.buyer_id
                    AND d.created_at >= $2 AND d.created_at < $3) AS sold
         FROM buyer_cap_usage u
         WHERE u.window_kind = $1 AND u.window_start = $2
         ORDER BY u.buyer_id
         FOR UPDATE OF u`,
        [w.kind, w.start, w.end],
      );
      for (const row of rows) {
        const sold = Number(row.sold);
        const released = leakedSlots(row.used, sold, inFlight);
        if (released === 0) continue;
        repairs.push({ buyerId: row.buyer_id, windowKind: w.kind, windowStart: w.start.toISOString(), used: row.used, sold, inFlight, released });
        if (!o.dryRun) {
          await tx.query(
            `UPDATE buyer_cap_usage SET used = used - $4 WHERE buyer_id = $1 AND window_kind = $2 AND window_start = $3`,
            [row.buyer_id, w.kind, w.start, released],
          );
        }
      }
    }
    return repairs;
  });
}

export async function reconcile(pool: Pool, redis: Redis, o: ReconcileOptions): Promise<ReconcileReport> {
  const started = new Date();
  const { republished, exhausted } = await republishStuckLeads(pool, redis, o);
  const capRepairs = await repairCaps(pool, o);
  const slotsReleased = capRepairs.reduce((sum, r) => sum + r.released, 0);

  await pool.query(
    `INSERT INTO reconciliation_runs
       (started_at, finished_at, dry_run, leads_republished, leads_exhausted, cap_rows_repaired, cap_slots_released, details)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7)`,
    [started, o.dryRun, republished.length, exhausted, capRepairs.length, slotsReleased, JSON.stringify({ capRepairs })],
  );

  return { republished, exhausted, capRepairs, slotsReleased, dryRun: o.dryRun };
}
