import type { Buyer } from './buyer.ts';
import type { ClaimedLead } from './eligibility.ts';

export type DeliveryResult =
  | { result: 'accepted' }
  | { result: 'rejected' | 'timeout' | 'error'; reason: string };

/**
 * Talks to a buyer (ping then post). Implementations must not throw for buyer-side problems: a slow,
 * failing or rejecting buyer is a normal outcome that sends the router to the next candidate (ADR-0004).
 */
export interface BuyerGateway {
  deliver(buyer: Buyer, lead: ClaimedLead, budgetMs: number): Promise<DeliveryResult>;
}

/** Every buyer accepts instantly. For tests and for isolating the engine from buyer latency in load tests. */
export class AcceptAllGateway implements BuyerGateway {
  deliver(): Promise<DeliveryResult> {
    return Promise.resolve({ result: 'accepted' });
  }
}
