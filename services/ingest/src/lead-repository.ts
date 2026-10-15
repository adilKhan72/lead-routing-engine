import type { Lead, Pool } from '@lre/shared';

export type LeadStatus = 'received' | 'routing' | 'sold' | 'unsold' | 'failed';

export interface StoredLead {
  id: string;
  payloadHash: string;
  status: LeadStatus;
  receivedAt: Date;
  publishedAt: Date | null;
}

export interface InsertResult {
  lead: StoredLead;
  /** false when the idempotency key already existed and `lead` is the original. */
  created: boolean;
}

export interface LeadRepository {
  insertOrGet(input: { id: string; idempotencyKey: string; payloadHash: string; lead: Lead }): Promise<InsertResult>;
  markPublished(id: string): Promise<void>;
  findById(id: string): Promise<StoredLead | null>;
  /** Leads that were stored but never made it onto the stream, oldest first. */
  findUnpublished(olderThanMs: number, limit: number): Promise<string[]>;
}

interface LeadRow {
  id: string;
  payload_hash: string;
  status: LeadStatus;
  received_at: Date;
  published_at: Date | null;
}

const COLUMNS = 'id, payload_hash, status, received_at, published_at';

function toStored(row: LeadRow): StoredLead {
  return {
    id: row.id,
    payloadHash: row.payload_hash,
    status: row.status,
    receivedAt: row.received_at,
    publishedAt: row.published_at,
  };
}

export class PgLeadRepository implements LeadRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async insertOrGet({ id, idempotencyKey, payloadHash, lead }: Parameters<LeadRepository['insertOrGet']>[0]) {
    const inserted = await this.pool.query<LeadRow>(
      `INSERT INTO leads (id, idempotency_key, payload_hash, product, state, amount_cents, credit_band, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [id, idempotencyKey, payloadHash, lead.product, lead.state, lead.amountCents ?? null, lead.creditBand, lead],
    );
    const row = inserted.rows[0];
    if (row) return { lead: toStored(row), created: true };

    // Conflict: the row is committed by the winning transaction (ON CONFLICT waits for it), so it is visible.
    const existing = await this.pool.query<LeadRow>(`SELECT ${COLUMNS} FROM leads WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    const original = existing.rows[0];
    if (!original) throw new Error('idempotency conflict but no existing lead found');
    return { lead: toStored(original), created: false };
  }

  async markPublished(id: string): Promise<void> {
    await this.pool.query('UPDATE leads SET published_at = now() WHERE id = $1 AND published_at IS NULL', [id]);
  }

  async findById(id: string): Promise<StoredLead | null> {
    const { rows } = await this.pool.query<LeadRow>(`SELECT ${COLUMNS} FROM leads WHERE id = $1`, [id]);
    return rows[0] ? toStored(rows[0]) : null;
  }

  async findUnpublished(olderThanMs: number, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM leads
       WHERE published_at IS NULL AND received_at < now() - make_interval(secs => $1::double precision / 1000)
       ORDER BY received_at
       LIMIT $2`,
      [olderThanMs, limit],
    );
    return rows.map((r) => r.id);
  }
}
