import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/index.ts';
import { setupIntegration, type IntegrationContext } from '../src/testing/index.ts';

describe('migrate', () => {
  let ctx: IntegrationContext;
  beforeAll(async () => {
    ctx = await setupIntegration();
  });
  afterAll(() => ctx.close());

  it('is idempotent and safe to run concurrently', async () => {
    const results = await Promise.all([migrate(ctx.pool), migrate(ctx.pool), migrate(ctx.pool)]);
    expect(results.flat()).toEqual([]);
    const { rows } = await ctx.pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(rows.map((r) => r.version)).toContain('0001_initial_schema');
  });

  it('enforces one routing decision per lead', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111';
    await ctx.pool.query(
      `INSERT INTO leads (id, idempotency_key, payload_hash, product, state, credit_band, payload)
       VALUES ($1, 'k', 'h', 'auto_insurance', 'TX', 'good', '{}')`,
      [leadId],
    );
    await ctx.pool.query(`INSERT INTO routing_decisions (lead_id, outcome, decided_by) VALUES ($1, 'unsold', 'a')`, [
      leadId,
    ]);
    await expect(
      ctx.pool.query(`INSERT INTO routing_decisions (lead_id, outcome, decided_by) VALUES ($1, 'unsold', 'b')`, [leadId]),
    ).rejects.toThrow(/duplicate key/);
  });
});
