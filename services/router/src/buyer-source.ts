import type { Logger, Pool } from '@lre/shared';
import { BuyerCriteriaSchema, isValidTimeZone, ScheduleSchema, type Buyer } from './buyer.ts';

export interface BuyerSource {
  activeBuyers(): Promise<Buyer[]>;
}

interface BuyerRow {
  id: string;
  name: string;
  price_cents: number;
  weight: number;
  criteria: unknown;
  schedule: unknown;
  timezone: string;
  hourly_cap: number | null;
  daily_cap: number | null;
  endpoint_url: string | null;
  ping_timeout_ms: number;
  post_timeout_ms: number;
}

export class PgBuyerSource implements BuyerSource {
  private readonly pool: Pool;
  private readonly log: Logger;

  constructor(pool: Pool, log: Logger) {
    this.pool = pool;
    this.log = log;
  }

  async activeBuyers(): Promise<Buyer[]> {
    const { rows } = await this.pool.query<BuyerRow>(
      `SELECT id, name, price_cents, weight, criteria, schedule, timezone, hourly_cap, daily_cap,
              endpoint_url, ping_timeout_ms, post_timeout_ms
       FROM buyers WHERE active ORDER BY price_cents DESC, id`,
    );
    const buyers: Buyer[] = [];
    for (const row of rows) {
      const criteria = BuyerCriteriaSchema.safeParse(row.criteria);
      const schedule = row.schedule === null ? null : ScheduleSchema.safeParse(row.schedule);
      // A misconfigured buyer is skipped loudly rather than allowed to match everything.
      if (!criteria.success || (schedule && !schedule.success) || !isValidTimeZone(row.timezone)) {
        this.log.error({ buyerId: row.id }, 'buyer has invalid criteria, schedule or timezone; skipping');
        continue;
      }
      buyers.push({
        id: row.id,
        name: row.name,
        priceCents: row.price_cents,
        weight: row.weight,
        criteria: criteria.data,
        schedule: schedule ? schedule.data : null,
        timezone: row.timezone,
        hourlyCap: row.hourly_cap,
        dailyCap: row.daily_cap,
        endpointUrl: row.endpoint_url,
        pingTimeoutMs: row.ping_timeout_ms,
        postTimeoutMs: row.post_timeout_ms,
      });
    }
    return buyers;
  }
}

/** Buyers change rarely and are read for every lead: serve them from memory for a few seconds. */
export class CachedBuyerSource implements BuyerSource {
  private readonly inner: BuyerSource;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private cached: { at: number; buyers: Promise<Buyer[]> } | null = null;

  constructor(inner: BuyerSource, ttlMs: number, nowMs: () => number = Date.now) {
    this.inner = inner;
    this.ttlMs = ttlMs;
    this.nowMs = nowMs;
  }

  activeBuyers(): Promise<Buyer[]> {
    const now = this.nowMs();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.buyers;
    // Cache the promise, not the result, so concurrent misses share one query.
    const buyers = this.inner.activeBuyers();
    this.cached = { at: now, buyers };
    buyers.catch(() => {
      this.cached = null;
    });
    return buyers;
  }
}
