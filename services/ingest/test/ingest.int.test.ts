import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STREAMS, parseLeadReceived } from '@lre/shared';
import { makeLead, setupIntegration, type IntegrationContext } from '@lre/shared/testing';
import { buildApp } from '../src/app.ts';
import { PgLeadRepository } from '../src/lead-repository.ts';
import { RedisStreamPublisher } from '../src/publisher.ts';
import { sweepUnpublished } from '../src/sweeper.ts';
import { FakePublisher } from './fakes.ts';

const silent = pino({ level: 'silent' });

describe('ingest against Postgres and Redis', () => {
  let ctx: IntegrationContext;
  let repo: PgLeadRepository;

  beforeAll(async () => {
    ctx = await setupIntegration();
    repo = new PgLeadRepository(ctx.pool);
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE leads CASCADE');
    await ctx.redis.flushdb();
  });

  async function streamLeadIds(): Promise<string[]> {
    const entries = await ctx.redis.xrange(STREAMS.leadReceived, '-', '+');
    return entries.map(([, fields]) => parseLeadReceived(fields)?.leadId ?? 'unparseable');
  }

  it('stores the lead, publishes its id and marks it published', async () => {
    const app = buildApp({ repo, publisher: new RedisStreamPublisher(ctx.redis), log: silent });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      payload: makeLead(),
      headers: { 'idempotency-key': 'int-key-0001' },
    });
    expect(res.statusCode).toBe(202);
    const { leadId } = res.json<{ leadId: string }>();

    expect(await streamLeadIds()).toEqual([leadId]);
    const { rows } = await ctx.pool.query<{ published_at: Date | null; state: string; payload: unknown }>(
      'SELECT published_at, state, payload FROM leads WHERE id = $1',
      [leadId],
    );
    expect(rows[0]?.published_at).toBeInstanceOf(Date);
    expect(rows[0]?.state).toBe('TX');
    expect(rows[0]?.payload).toEqual(makeLead());
  });

  it('creates exactly one lead when the same request races 25 times', async () => {
    const app = buildApp({ repo, publisher: new RedisStreamPublisher(ctx.redis), log: silent });
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        app.inject({
          method: 'POST',
          url: '/v1/leads',
          payload: makeLead(),
          headers: { 'idempotency-key': 'race-key-0001' },
        }),
      ),
    );
    expect(responses.every((r) => r.statusCode === 202)).toBe(true);
    const ids = new Set(responses.map((r) => r.json<{ leadId: string }>().leadId));
    expect(ids.size).toBe(1);
    expect((await ctx.pool.query('SELECT 1 FROM leads')).rowCount).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
  });

  it('recovers leads whose publish failed via the outbox sweeper', async () => {
    const broken = new FakePublisher();
    broken.failing = true;
    const app = buildApp({ repo, publisher: broken, log: silent });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/leads',
        payload: makeLead(),
        headers: { 'idempotency-key': `outage-key-000${i}` },
      });
      ids.push(res.json<{ leadId: string }>().leadId);
    }
    expect(await streamLeadIds()).toEqual([]);

    const swept = await sweepUnpublished(repo, new RedisStreamPublisher(ctx.redis), silent, {
      graceMs: 0,
      batchSize: 100,
    });
    expect(swept).toBe(3);
    expect((await streamLeadIds()).sort()).toEqual([...ids].sort());
    expect(await repo.findUnpublished(0, 100)).toEqual([]);
  });

  it('leaves recent unpublished leads to the in-flight request (grace period)', async () => {
    await repo.insertOrGet({ id: crypto.randomUUID(), idempotencyKey: 'fresh-0001', payloadHash: 'h', lead: makeLead() });
    expect(await repo.findUnpublished(60_000, 100)).toEqual([]);
  });
});
