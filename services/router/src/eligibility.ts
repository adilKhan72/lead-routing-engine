import type { CreditBand, Product, UsState } from '@lre/shared';
import type { Buyer } from './buyer.ts';
import { isOpen } from './schedule.ts';

/** The fields routing decisions depend on; contact details are deliberately not part of it. */
export interface RoutableLead {
  id: string;
  product: Product;
  state: UsState;
  amountCents: number | null;
  creditBand: CreditBand;
}

export type IneligibleReason = 'outside_schedule' | 'product' | 'state' | 'credit_band' | 'amount_missing' | 'amount_range';

export function ineligibilityReason(buyer: Buyer, lead: RoutableLead, now: Date): IneligibleReason | null {
  const c = buyer.criteria;
  if (c.products && !c.products.includes(lead.product)) return 'product';
  if (c.states && !c.states.includes(lead.state)) return 'state';
  if (c.creditBands && !c.creditBands.includes(lead.creditBand)) return 'credit_band';
  if (c.minAmountCents !== undefined || c.maxAmountCents !== undefined) {
    if (lead.amountCents === null) return 'amount_missing';
    if (c.minAmountCents !== undefined && lead.amountCents < c.minAmountCents) return 'amount_range';
    if (c.maxAmountCents !== undefined && lead.amountCents > c.maxAmountCents) return 'amount_range';
  }
  // Cheapest checks first; the schedule needs a time-zone conversion.
  if (!isOpen(buyer.schedule, buyer.timezone, now)) return 'outside_schedule';
  return null;
}

export function eligibleBuyers(buyers: readonly Buyer[], lead: RoutableLead, now: Date): Buyer[] {
  return buyers.filter((b) => ineligibilityReason(b, lead, now) === null);
}
