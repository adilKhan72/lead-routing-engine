import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedis, ROUTER_GROUP, STREAMS, publishLeadReceived, type Redis } from '@lre/shared';
import { setupIntegration, type IntegrationContext } from '@lre/shared/testing';
import type { BuyerGateway, DeliveryResult } from '../src/buyer-gateway.ts';
import { PgBuyerSource } from '../src/buyer-source.ts';
import { PgCapStore } from '../src/caps.ts';
import { PgLeadStore } from '../src/lead-store.ts';
import type { RouterDeps } from '../src/route-lead.ts';
import { seededRng } from '../src/selection.ts';
import { StreamConsumer, type StreamConsumerHooks } from '../src/stream-consumer.ts';
import { routerHooks } from '../src/worker.ts';
import { silent } from './fakes.ts';
import { insertBuyer, insertLeads, waitFor } from './seed.ts';

const retry = { maxDeliveries: 6, baseMs: 50, maxMs: 400 };

/** Accepts every lead after a few milliseconds, so concurrent consumers genuinely overlap. */
class JitteryAcceptGateway implements BuyerGateway {
  async deliver(): Promise<DeliveryResult> {
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    return { result: 'accepted' };
  }
}

describe('router end to end (Postgres + Redis Streams)', () => {
  let ctx: IntegrationContext;
  const connections: Redis[] = [];

  beforeAll(async () => {
    ctx = await setupIntegration(30);
  });
  afterAll(async () => {
    await Promise.allSettled(connections.map((c) => c.quit()));
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE leads, buyers CASCADE');
    await ctx.redis.flushdb();
  });

  function deps(name: string, overrides: Partial<RouterDeps> = {}): RouterDeps {
    return {
      leads: new PgLeadStore(ctx.pool),
      buyers: new PgBuyerSource(ctx.pool, silent),
      caps: new PgCapStore(ctx.pool),
      gateway: new JitteryAcceptGateway(),
      log: silent,
      now: () => new Date(),
      monotonicMs: () => performance.now(),
      rng: seededRng(name.length),
      workerName: name,
      budgetMs: 2_000,
      leaseMs: 1_000,
      ...overrides,
    };
  }

  function consumer(name: string, hooks: StreamConsumerHooks): StreamConsumer {
    // Each consumer needs its own connection: XREADGROUP BLOCK holds the socket.
    const redis = createRedis(process.env.REDIS_URL!);
    connections.push(redis);
    return new StreamConsumer(
      redis,
      {
        stream: STREAMS.leadReceived,
        deadLetterStream: STREAMS.deadLetter,
        group: ROUTER_GROUP,
        consumer: name,
        concurrency: 4,
        blockMs: 100,
        reclaimIntervalMs: 50,
        retry,
      },
      hooks,
      silent,
    );
  }

  async function runUntil(consumers: StreamConsumer[], done: () => Promise<boolean>): Promise<void> {
    const loops = consumers.map((c) => c.run());
    try {
      await waitFor(done);
    } finally {
      consumers.forEach((c) => {
        c.stop();
      });
      await Promise.all(loops);
    }
  }

  async function countByStatus(): Promise<Record<string, number>> {
    const { rows } = await ctx.pool.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM leads GROUP BY status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async function pendingCount(): Promise<number> {
    const summary = (await ctx.redis.xpending(STREAMS.leadReceived, ROUTER_GROUP)) as [number, ...unknown[]];
    return summary[0];
  }

  it('never double-sells or exceeds caps with 4 consumers and every message delivered 3 times', async () => {
    const premium = await insertBuyer(ctx.pool, { priceCents: 2_000, dailyCap: 10, hourlyCap: 100 });
    const standard = await insertBuyer(ctx.pool, { priceCents: 1_500, dailyCap: 15 });
    await insertBuyer(ctx.pool, { priceCents: 9_999, criteria: { states: ['CA'] } }); // never eligible (leads are TX)
    const leadIds = await insertLeads(ctx.pool, 40);
    for (let copy = 0; copy < 3; copy++) for (const id of leadIds) await publishLeadReceived(ctx.redis, id);

    const consumers = ['r1', 'r2', 'r3', 'r4'].map((n) => consumer(n, routerHooks(deps(n))));
    await runUntil(consumers, async () => {
      const s = await countByStatus();
      return (s.sold ?? 0) + (s.unsold ?? 0) === 40 && (await pendingCount()) === 0;
    });

    const sales = await ctx.pool.query<{ buyer_id: string; n: number }>(
      `SELECT buyer_id, count(*)::int AS n FROM routing_decisions WHERE outcome = 'sold' GROUP BY buyer_id`,
    );
    expect(Object.fromEntries(sales.rows.map((r) => [r.buyer_id, r.n]))).toEqual({ [premium]: 10, [standard]: 15 });
    expect(await countByStatus()).toEqual({ sold: 25, unsold: 15 });

    const decisions = await ctx.pool.query<{ n: number; leads: number }>(
      'SELECT count(*)::int AS n, count(DISTINCT lead_id)::int AS leads FROM routing_decisions',
    );
    expect(decisions.rows[0]).toEqual({ n: 40, leads: 40 });

    // Counters agree with the sales ledger: nothing leaked, nothing oversold.
    const usage = await ctx.pool.query<{ buyer_id: string; window_kind: string; used: number }>(
      'SELECT buyer_id, window_kind, used FROM buyer_cap_usage',
    );
    const used = Object.fromEntries(usage.rows.map((r) => [`${r.buyer_id}:${r.window_kind}`, r.used]));
    expect(used).toEqual({ [`${premium}:day`]: 10, [`${premium}:hour`]: 10, [`${standard}:day`]: 15 });
    expect(await ctx.redis.xlen(STREAMS.deadLetter)).toBe(0);
  });

  it('retries a failing lead with backoff, then dead-letters it and marks it failed', async () => {
    await insertBuyer(ctx.pool, { priceCents: 1_000 });
    const [poison, healthy] = await insertLeads(ctx.pool, 2);
    await publishLeadReceived(ctx.redis, poison!);
    await publishLeadReceived(ctx.redis, healthy!);

    const real = routerHooks(deps('r1'));
    let poisonCalls = 0;
    const hooks: StreamConsumerHooks = {
      ...real,
      handle: (leadId) => {
        if (leadId === poison) {
          poisonCalls++;
          return Promise.reject(new Error('simulated transient failure'));
        }
        return real.handle(leadId);
      },
    };
    await runUntil([consumer('r1', hooks)], async () => (await ctx.redis.xlen(STREAMS.deadLetter)) === 1);

    expect(poisonCalls).toBe(retry.maxDeliveries); // every delivery was attempted, then the DLQ
    const [[, fields]] = (await ctx.redis.xrange(STREAMS.deadLetter, '-', '+')) as [string, string[]][] as [
      [string, string[]],
    ];
    expect(fields).toEqual(expect.arrayContaining(['leadId', poison, 'reason']));
    expect(await countByStatus()).toEqual({ failed: 1, sold: 1 });
    const failed = await ctx.pool.query('SELECT outcome FROM routing_decisions WHERE lead_id = $1', [poison]);
    expect(failed.rows).toEqual([{ outcome: 'failed' }]);
    expect(await pendingCount()).toBe(0);
  });

  it('recovers a lead from a consumer that crashed mid-routing (unacked message + held lease)', async () => {
    await insertBuyer(ctx.pool, { priceCents: 1_000, dailyCap: 5 });
    const [leadId] = await insertLeads(ctx.pool, 1);
    await publishLeadReceived(ctx.redis, leadId!);

    // The "crashed" worker read the message and claimed the lead, then died: no ack, no decision.
    const crashed = consumer('crashed', { handle: () => new Promise(() => undefined) });
    await crashed.ensureGroup();
    await ctx.redis.xreadgroup('GROUP', ROUTER_GROUP, 'crashed', 'COUNT', 1, 'STREAMS', STREAMS.leadReceived, '>');
    await new PgLeadStore(ctx.pool).claim(leadId!, crypto.randomUUID(), 300);

    await runUntil([consumer('survivor', routerHooks(deps('survivor')))], async () => {
      return (await countByStatus()).sold === 1 && (await pendingCount()) === 0;
    });

    const decision = await ctx.pool.query<{ decided_by: string }>('SELECT decided_by FROM routing_decisions');
    expect(decision.rows).toEqual([{ decided_by: 'survivor' }]);
  });

  it('keeps processing other leads while one lead is slow (no head-of-line blocking)', async () => {
    await insertBuyer(ctx.pool, { priceCents: 1_000 });
    const [slow, ...fast] = await insertLeads(ctx.pool, 11);
    for (const id of [slow!, ...fast]) await publishLeadReceived(ctx.redis, id);

    const real = routerHooks(deps('r1'));
    let releaseSlow: () => void = () => undefined;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const hooks: StreamConsumerHooks = {
      ...real,
      handle: async (leadId) => {
        if (leadId === slow) await slowGate;
        return real.handle(leadId);
      },
    };
    // Concurrency 4: the slow lead holds one slot while the other three slots drain the ten fast leads.
    const c = consumer('r1', hooks);
    const loop = c.run();
    try {
      await waitFor(async () => (await countByStatus()).sold === 10);
      expect((await countByStatus()).received).toBe(1);
      releaseSlow();
      await waitFor(async () => (await countByStatus()).sold === 11);
    } finally {
      releaseSlow();
      c.stop();
      await loop;
    }
  });
});

