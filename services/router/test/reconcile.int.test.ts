import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STREAMS, parseLeadReceived } from '@lre/shared';
import { setupIntegration, type IntegrationContext } from '@lre/shared/testing';
import { reconcile, type ReconcileOptions } from '../src/reconcile.ts';
import { insertBuyer, insertLeads } from './seed.ts';

const NOW = new Date('2026-10-16T13:30:00Z');
const HOUR = new Date('2026-10-16T13:00:00Z');

function options(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return { now: NOW, stuckAfterMs: 120_000, leaseGraceMs: 60_000, maxRepublishPerRun: 100, maxRepublishPerLead: 3, dryRun: false, ...overrides };
}

describe('reconciler (Postgres + Redis)', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await setupIntegration(5);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE leads, buyers, reconciliation_runs CASCADE');
    await ctx.redis.flushdb();
  });

  async function streamedLeadIds(): Promise<string[]> {
    const entries = (await ctx.redis.xrange(STREAMS.leadReceived, '-', '+')) as [string, string[]][];
    return entries.map(([, fields]) => parseLeadReceived(fields)!.leadId);
  }

  async function setLead(id: string, sql: string, params: unknown[] = []): Promise<void> {
    await ctx.pool.query(`UPDATE leads SET ${sql} WHERE id = $1`, [id, ...params]);
  }

  it('re-publishes old undecided leads with no live lease, and leaves the rest alone', async () => {
    // The 3rd lead was received just now, so it isn't stuck yet and must be left alone.
    const [stuck, routingDead, , leased, sold] = await insertLeads(ctx.pool, 5);
    const old = new Date(NOW.getTime() - 10 * 60_000);
    for (const id of [stuck!, routingDead!, leased!, sold!]) await setLead(id, 'received_at = $2', [old]);
    await setLead(routingDead!, "status = 'routing', lease_until = $2", [new Date(NOW.getTime() - 5 * 60_000)]);
    await setLead(leased!, "status = 'routing', lease_until = $2", [new Date(NOW.getTime() + 5_000)]);
    await setLead(sold!, "status = 'sold'");

    const report = await reconcile(ctx.pool, ctx.redis, options());

    expect(new Set(report.republished)).toEqual(new Set([stuck, routingDead]));
    expect(new Set(await streamedLeadIds())).toEqual(new Set([stuck, routingDead]));
    const { rows } = await ctx.pool.query<{ republish_count: number }>('SELECT republish_count FROM leads WHERE id = $1', [stuck]);
    expect(rows[0]?.republish_count).toBe(1);
  });

  it('does not re-publish the same lead again within the stuck window, and gives up after the limit', async () => {
    const [id] = await insertLeads(ctx.pool, 1);
    await setLead(id!, 'received_at = $2', [new Date(NOW.getTime() - 60 * 60_000)]);

    await reconcile(ctx.pool, ctx.redis, options());
    const again = await reconcile(ctx.pool, ctx.redis, options({ now: new Date(NOW.getTime() + 30_000) }));
    expect(again.republished).toEqual([]);

    await setLead(id!, 'republish_count = 3');
    const exhausted = await reconcile(ctx.pool, ctx.redis, options({ now: new Date(NOW.getTime() + 60 * 60_000) }));
    expect(exhausted.republished).toEqual([]);
    expect(exhausted.exhausted).toBe(1);
  });

  it('dry run reports without changing anything', async () => {
    const [id] = await insertLeads(ctx.pool, 1);
    await setLead(id!, 'received_at = $2', [new Date(NOW.getTime() - 60 * 60_000)]);

    const report = await reconcile(ctx.pool, ctx.redis, options({ dryRun: true }));

    expect(report.republished).toEqual([id]);
    expect(await streamedLeadIds()).toEqual([]);
    const { rows } = await ctx.pool.query<{ republish_count: number }>('SELECT republish_count FROM leads WHERE id = $1', [id]);
    expect(rows[0]?.republish_count).toBe(0);
  });

  it('releases leaked cap slots down to sales plus in-flight leads, never below', async () => {
    const buyer = await insertBuyer(ctx.pool, { priceCents: 1000, hourlyCap: 10 });
    const leads = await insertLeads(ctx.pool, 4);
    // 3 sales this hour…
    for (const id of leads.slice(0, 3)) {
      await ctx.pool.query(
        `INSERT INTO routing_decisions (lead_id, outcome, buyer_id, price_cents, decided_by, created_at) VALUES ($1, 'sold', $2, 1000, 't', $3)`,
        [id, buyer, new Date(NOW.getTime() - 60_000)],
      );
    }
    // …1 lead legitimately in flight (live lease)…
    await setLead(leads[3]!, "status = 'routing', lease_until = $2", [new Date(NOW.getTime() + 5_000)]);
    // …but the counter says 7: 3 slots leaked by crashed routers.
    await ctx.pool.query(`INSERT INTO buyer_cap_usage VALUES ($1, 'hour', $2, 7)`, [buyer, HOUR]);

    const report = await reconcile(ctx.pool, ctx.redis, options());

    expect(report.slotsReleased).toBe(3);
    expect(report.capRepairs).toEqual([expect.objectContaining({ buyerId: buyer, used: 7, sold: 3, inFlight: 1, released: 3 })]);
    const { rows } = await ctx.pool.query<{ used: number }>('SELECT used FROM buyer_cap_usage WHERE buyer_id = $1', [buyer]);
    expect(rows[0]?.used).toBe(4);

    const second = await reconcile(ctx.pool, ctx.redis, options());
    expect(second.slotsReleased).toBe(0); // idempotent
  });

  it('counts recently expired leases as in flight (grace), so a late release cannot double-decrement', async () => {
    const buyer = await insertBuyer(ctx.pool, { priceCents: 1000, hourlyCap: 10 });
    const [late] = await insertLeads(ctx.pool, 1);
    await setLead(late!, "status = 'routing', lease_until = $2", [new Date(NOW.getTime() - 30_000)]); // within 60s grace
    await ctx.pool.query(`INSERT INTO buyer_cap_usage VALUES ($1, 'hour', $2, 1)`, [buyer, HOUR]);

    const report = await reconcile(ctx.pool, ctx.redis, options());

    expect(report.slotsReleased).toBe(0);
  });

  it('records every run for audit', async () => {
    await reconcile(ctx.pool, ctx.redis, options({ dryRun: true }));

    const { rows } = await ctx.pool.query('SELECT dry_run, leads_republished FROM reconciliation_runs');
    expect(rows).toEqual([{ dry_run: true, leads_republished: 0 }]);
  });
});
