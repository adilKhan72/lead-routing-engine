import { withTransaction, type Pool } from '@lre/shared';
import type { Buyer } from './buyer.ts';

export type WindowKind = 'hour' | 'day';

export interface CapWindow {
  kind: WindowKind;
  start: Date;
  limit: number;
}

export interface Reservation {
  buyerId: string;
  windows: CapWindow[];
}

export interface CapStore {
  /** Atomically takes one slot in every capped window of the buyer, or none. null = a cap is full. */
  reserve(buyer: Buyer, now: Date): Promise<Reservation | null>;
  /** Gives the slots back (buyer rejected / timed out / lead not sold). */
  release(reservation: Reservation): Promise<void>;
}

/** Windows are UTC hours and UTC days (ADR-0002); buyer-local day boundaries are a roadmap item. */
export function capWindows(buyer: Buyer, now: Date): CapWindow[] {
  const windows: CapWindow[] = [];
  if (buyer.hourlyCap !== null) {
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    windows.push({ kind: 'hour', start, limit: buyer.hourlyCap });
  }
  if (buyer.dailyCap !== null) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    windows.push({ kind: 'day', start, limit: buyer.dailyCap });
  }
  return windows;
}

class CapFull extends Error {}

export class PgCapStore implements CapStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async reserve(buyer: Buyer, now: Date): Promise<Reservation | null> {
    const windows = capWindows(buyer, now);
    if (windows.length === 0) return { buyerId: buyer.id, windows };
    try {
      await withTransaction(this.pool, async (tx) => {
        // Always hour before day: a consistent lock order means concurrent reservations can't deadlock.
        for (const w of windows) {
          // The row lock taken by ON CONFLICT DO UPDATE serializes concurrent reservers, and the WHERE
          // clause is re-evaluated against the latest committed value, so the cap can never be exceeded.
          const res = await tx.query(
            `INSERT INTO buyer_cap_usage (buyer_id, window_kind, window_start, used)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (buyer_id, window_kind, window_start)
             DO UPDATE SET used = buyer_cap_usage.used + 1
             WHERE buyer_cap_usage.used < $4
             RETURNING used`,
            [buyer.id, w.kind, w.start, w.limit],
          );
          if (res.rowCount === 0) throw new CapFull();
        }
      });
    } catch (err) {
      if (err instanceof CapFull) return null;
      throw err;
    }
    return { buyerId: buyer.id, windows };
  }

  async release(reservation: Reservation): Promise<void> {
    for (const w of reservation.windows) {
      await this.pool.query(
        `UPDATE buyer_cap_usage SET used = used - 1
         WHERE buyer_id = $1 AND window_kind = $2 AND window_start = $3 AND used > 0`,
        [reservation.buyerId, w.kind, w.start],
      );
    }
  }
}
