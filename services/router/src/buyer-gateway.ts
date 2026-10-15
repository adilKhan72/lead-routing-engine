import type { Buyer } from './buyer.ts';
import type { RoutableLead } from './eligibility.ts';

export type DeliveryResult =
  | { result: 'accepted' }
  | { result: 'rejected' | 'timeout' | 'error'; reason: string };

/**
 * Talks to a buyer (ping then post). Implementations must not throw for buyer-side problems: a slow,
 * failing or rejecting buyer is a normal outcome that sends the router to the next candidate (ADR-0004).
 */
export interface BuyerGateway {
  deliver(buyer: Buyer, lead: RoutableLead, budgetMs: number): Promise<DeliveryResult>;
}

/** Stand-in until the HTTP ping-post gateway lands (M3): every buyer accepts instantly. */
export class AcceptAllGateway implements BuyerGateway {
  deliver(): Promise<DeliveryResult> {
    return Promise.resolve({ result: 'accepted' });
  }
}
