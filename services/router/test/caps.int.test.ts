import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupIntegration, type IntegrationContext } from '@lre/shared/testing';
import { PgCapStore } from '../src/caps.ts';
import { makeBuyer } from './fakes.ts';
import { insertBuyer } from './seed.ts';

const now = new Date('2026-10-15T15:20:00Z');

describe('PgCapStore under concurrency', () => {
  let ctx: IntegrationContext;
  let caps: PgCapStore;

  beforeAll(async () => {
    ctx = await setupIntegration(30);
    caps = new PgCapStore(ctx.pool);
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE buyers CASCADE');
  });

  async function usage(buyerId: string) {
    const { rows } = await ctx.pool.query<{ window_kind: string; used: number }>(
      'SELECT window_kind, used FROM buyer_cap_usage WHERE buyer_id = $1 ORDER BY window_kind',
      [buyerId],
    );
    return Object.fromEntries(rows.map((r) => [r.window_kind, r.used]));
  }

  it('grants exactly `cap` of 60 concurrent reservations', async () => {
    const id = await insertBuyer(ctx.pool, { priceCents: 1_000, dailyCap: 10 });
    const buyer = makeBuyer({ id, dailyCap: 10 });
    const results = await Promise.all(Array.from({ length: 60 }, () => caps.reserve(buyer, now)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await usage(id)).toEqual({ day: 10 });
  });

  it('reserves hour and day together or not at all', async () => {
    const id = await insertBuyer(ctx.pool, { priceCents: 1_000, hourlyCap: 10, dailyCap: 4 });
    const buyer = makeBuyer({ id, hourlyCap: 10, dailyCap: 4 });
    const results = await Promise.all(Array.from({ length: 30 }, () => caps.reserve(buyer, now)));
    expect(results.filter(Boolean)).toHaveLength(4);
    // The 26 failed attempts incremented the hour counter inside a transaction that rolled back.
    expect(await usage(id)).toEqual({ day: 4, hour: 4 });
  });

  it('frees a slot on release, and windows roll over', async () => {
    const id = await insertBuyer(ctx.pool, { priceCents: 1_000, hourlyCap: 1 });
    const buyer = makeBuyer({ id, hourlyCap: 1 });
    const first = await caps.reserve(buyer, now);
    expect(first).not.toBeNull();
    expect(await caps.reserve(buyer, now)).toBeNull();
    await caps.release(first!);
    expect(await caps.reserve(buyer, now)).not.toBeNull();
    expect(await caps.reserve(buyer, new Date('2026-10-15T16:00:00Z'))).not.toBeNull();
  });

  it('needs no database round trip for an uncapped buyer', async () => {
    const id = await insertBuyer(ctx.pool, { priceCents: 1_000 });
    expect(await caps.reserve(makeBuyer({ id }), now)).toEqual({ buyerId: id, windows: [] });
    expect(await usage(id)).toEqual({});
  });
});
