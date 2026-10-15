import { withTransaction, type CreditBand, type Pool, type Product, type UsState } from '@lre/shared';
import type { RoutableLead } from './eligibility.ts';

export type ClaimResult =
  | { kind: 'claimed'; lead: RoutableLead }
  /** Already sold / unsold / failed: the message is a duplicate, ack it. */
  | { kind: 'final'; status: string }
  /** Another worker holds a live lease: don't ack, let the retry path look again later. */
  | { kind: 'busy' }
  | { kind: 'missing' };

export interface AttemptLog {
  buyerId: string;
  result: 'accepted' | 'rejected' | 'timeout' | 'error' | 'cap_full';
  reason?: string;
  latencyMs?: number;
}

export interface Decision {
  outcome: 'sold' | 'unsold';
  buyerId: string | null;
  priceCents: number | null;
  attempts: AttemptLog[];
  latencyMs: number;
}

export interface LeadStore {
  claim(leadId: string, token: string, leaseMs: number): Promise<ClaimResult>;
  /** Commits the decision iff we still hold the claim. false = fenced out (lease lost to another worker). */
  finalize(leadId: string, token: string, decision: Decision, decidedBy: string): Promise<boolean>;
  /** Terminal failure after the retry budget is spent (dead-lettered). Idempotent. */
  markFailed(leadId: string, decidedBy: string, reason: string): Promise<void>;
}

interface ClaimRow {
  id: string;
  product: Product;
  state: UsState;
  amount_cents: string | null;
  credit_band: CreditBand;
}

export class PgLeadStore implements LeadStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async claim(leadId: string, token: string, leaseMs: number): Promise<ClaimResult> {
    const claimed = await this.pool.query<ClaimRow>(
      `UPDATE leads
       SET status = 'routing', claim_token = $2, routing_attempts = routing_attempts + 1,
           lease_until = now() + make_interval(secs => $3::double precision / 1000)
       WHERE id = $1 AND (status = 'received' OR (status = 'routing' AND lease_until < now()))
       RETURNING id, product, state, amount_cents, credit_band`,
      [leadId, token, leaseMs],
    );
    const row = claimed.rows[0];
    if (row) {
      return {
        kind: 'claimed',
        lead: {
          id: row.id,
          product: row.product,
          state: row.state,
          amountCents: row.amount_cents === null ? null : Number(row.amount_cents), // bigint arrives as string
          creditBand: row.credit_band,
        },
      };
    }
    const current = await this.pool.query<{ status: string }>('SELECT status FROM leads WHERE id = $1', [leadId]);
    const status = current.rows[0]?.status;
    if (status === undefined) return { kind: 'missing' };
    return status === 'routing' ? { kind: 'busy' } : { kind: 'final', status };
  }

  async finalize(leadId: string, token: string, d: Decision, decidedBy: string): Promise<boolean> {
    return withTransaction(this.pool, async (tx) => {
      const updated = await tx.query(
        `UPDATE leads SET status = $3, decided_at = now(), lease_until = NULL
         WHERE id = $1 AND claim_token = $2 AND status = 'routing'`,
        [leadId, token, d.outcome],
      );
      if (updated.rowCount === 0) return false;
      await tx.query(
        `INSERT INTO routing_decisions (lead_id, outcome, buyer_id, price_cents, attempts, latency_ms, decided_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [leadId, d.outcome, d.buyerId, d.priceCents, JSON.stringify(d.attempts), Math.round(d.latencyMs), decidedBy],
      );
      return true;
    });
  }

  async markFailed(leadId: string, decidedBy: string, reason: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const updated = await tx.query(
        `UPDATE leads SET status = 'failed', decided_at = now(), lease_until = NULL
         WHERE id = $1 AND (status = 'received' OR (status = 'routing' AND lease_until < now()))`,
        [leadId],
      );
      // Already final, unknown, or owned by a live lease (whose owner will finalize it): nothing to do.
      if (updated.rowCount === 0) return;
      await tx.query(
        `INSERT INTO routing_decisions (lead_id, outcome, attempts, decided_by)
         VALUES ($1, 'failed', $2, $3)`,
        [leadId, JSON.stringify([{ reason }]), decidedBy],
      );
    });
  }
}
