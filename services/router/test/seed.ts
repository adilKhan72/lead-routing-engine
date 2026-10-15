import { randomUUID } from 'node:crypto';
import type { Pool } from '@lre/shared';
import { makeLead } from '@lre/shared/testing';
import type { Buyer } from '../src/buyer.ts';

export async function insertBuyer(pool: Pool, b: Partial<Buyer> & { priceCents: number }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO buyers (name, price_cents, weight, criteria, schedule, timezone, hourly_cap, daily_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      b.name ?? `buyer-${b.priceCents}`,
      b.priceCents,
      b.weight ?? 1,
      JSON.stringify(b.criteria ?? {}),
      b.schedule ? JSON.stringify(b.schedule) : null,
      b.timezone ?? 'UTC',
      b.hourlyCap ?? null,
      b.dailyCap ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function insertLeads(pool: Pool, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const lead = makeLead();
    await pool.query(
      `INSERT INTO leads (id, idempotency_key, payload_hash, product, state, amount_cents, credit_band, payload, published_at)
       VALUES ($1, $2, 'h', $3, $4, $5, $6, $7, now())`,
      [id, `seed-${id}`, lead.product, lead.state, lead.amountCents, lead.creditBand, lead],
    );
    ids.push(id);
  }
  return ids;
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
