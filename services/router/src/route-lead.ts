import { randomUUID } from 'node:crypto';
import type { Logger } from '@lre/shared';
import type { BuyerGateway } from './buyer-gateway.ts';
import type { BuyerSource } from './buyer-source.ts';
import type { CapStore } from './caps.ts';
import { eligibleBuyers } from './eligibility.ts';
import type { AttemptLog, LeadStore } from './lead-store.ts';
import { orderCandidates, type Rng } from './selection.ts';

export interface RouterDeps {
  leads: LeadStore;
  buyers: BuyerSource;
  caps: CapStore;
  gateway: BuyerGateway;
  log: Logger;
  /** Wall clock for schedules and cap windows. */
  now: () => Date;
  /** Monotonic milliseconds for latency and budget. */
  monotonicMs: () => number;
  rng: Rng;
  newToken?: () => string;
  /** Name recorded on decisions (pod / consumer name). */
  workerName: string;
  budgetMs: number;
  leaseMs: number;
}

export type RouteOutcome =
  | { kind: 'sold'; buyerId: string; priceCents: number }
  | { kind: 'unsold'; reason: 'no_eligible_buyer' | 'all_declined' | 'budget_exhausted' }
  /** Duplicate message for a lead that is already final. Safe to ack. */
  | { kind: 'duplicate' }
  /** Another worker owns the lead right now. Do not ack; the retry path will look again. */
  | { kind: 'busy' }
  /** Our lease expired and another worker took over before we could commit. Safe to ack. */
  | { kind: 'lost_lease' }
  | { kind: 'missing' };

export async function routeLead(deps: RouterDeps, leadId: string): Promise<RouteOutcome> {
  const started = deps.monotonicMs();
  const token = (deps.newToken ?? randomUUID)();
  const claim = await deps.leads.claim(leadId, token, deps.leaseMs);
  if (claim.kind === 'final') return { kind: 'duplicate' };
  if (claim.kind === 'busy') return { kind: 'busy' };
  if (claim.kind === 'missing') return { kind: 'missing' };
  const lead = claim.lead;

  const now = deps.now();
  const candidates = orderCandidates(eligibleBuyers(await deps.buyers.activeBuyers(), lead, now), deps.rng);
  const attempts: AttemptLog[] = [];
  let unsoldReason: 'no_eligible_buyer' | 'all_declined' | 'budget_exhausted' =
    candidates.length === 0 ? 'no_eligible_buyer' : 'all_declined';

  for (const buyer of candidates) {
    const remaining = deps.budgetMs - (deps.monotonicMs() - started);
    if (remaining <= 0) {
      unsoldReason = 'budget_exhausted';
      break;
    }

    const reservation = await deps.caps.reserve(buyer, now);
    if (!reservation) {
      attempts.push({ buyerId: buyer.id, result: 'cap_full' });
      continue;
    }

    let committed = false;
    try {
      const callStarted = deps.monotonicMs();
      const delivery = await deps.gateway.deliver(buyer, lead, remaining);
      const latencyMs = Math.round(deps.monotonicMs() - callStarted);
      if (delivery.result !== 'accepted') {
        attempts.push({ buyerId: buyer.id, result: delivery.result, reason: delivery.reason, latencyMs });
        continue;
      }
      attempts.push({ buyerId: buyer.id, result: 'accepted', latencyMs });
      const won = await deps.leads.finalize(
        lead.id,
        token,
        {
          outcome: 'sold',
          buyerId: buyer.id,
          priceCents: buyer.priceCents,
          attempts,
          latencyMs: deps.monotonicMs() - started,
        },
        deps.workerName,
      );
      if (!won) {
        deps.log.warn({ leadId: lead.id, buyerId: buyer.id }, 'lease lost after buyer accepted; not recording sale');
        return { kind: 'lost_lease' };
      }
      committed = true;
      return { kind: 'sold', buyerId: buyer.id, priceCents: buyer.priceCents };
    } finally {
      // Any path that did not commit the sale (reject, timeout, lost lease, or an exception such as the
      // database going away mid-flight) gives the cap slot back.
      if (!committed) {
        await deps.caps.release(reservation).catch((err: unknown) => {
          deps.log.error({ err, buyerId: buyer.id }, 'cap release failed; slot leaks until the window rolls over');
        });
      }
    }
  }

  const won = await deps.leads.finalize(
    lead.id,
    token,
    { outcome: 'unsold', buyerId: null, priceCents: null, attempts, latencyMs: deps.monotonicMs() - started },
    deps.workerName,
  );
  return won ? { kind: 'unsold', reason: unsoldReason } : { kind: 'lost_lease' };
}
