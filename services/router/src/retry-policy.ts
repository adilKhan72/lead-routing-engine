export interface RetryPolicy {
  /** Deliveries (including the first) after which a message is dead-lettered. */
  maxDeliveries: number;
  baseMs: number;
  maxMs: number;
}

/** Exponential backoff before the next delivery: base, 2*base, 4*base ... capped at maxMs. */
export function backoffMs(deliveries: number, policy: RetryPolicy): number {
  return Math.min(policy.baseMs * 2 ** Math.max(0, deliveries - 1), policy.maxMs);
}

/** What to do with a pending (delivered, unacked) message, given how often it was delivered and how long it has sat. */
export function pendingAction(deliveries: number, idleMs: number, policy: RetryPolicy): 'dead-letter' | 'retry' | 'wait' {
  if (deliveries >= policy.maxDeliveries) return 'dead-letter';
  return idleMs >= backoffMs(deliveries, policy) ? 'retry' : 'wait';
}

/** Total time a message can stay in the retry loop before it is dead-lettered. */
export function retryWindowMs(policy: RetryPolicy): number {
  let total = 0;
  for (let d = 1; d < policy.maxDeliveries; d++) total += backoffMs(d, policy);
  return total;
}

/**
 * A lead held by a live lease is reported "busy" and left pending. If the retry window were shorter than
 * the lease, a busy lead could be dead-lettered while its owner is still routing it, so refuse to start.
 */
export function assertLeaseFitsRetryWindow(leaseMs: number, policy: RetryPolicy): void {
  const window = retryWindowMs(policy);
  if (leaseMs >= window) {
    throw new Error(`lease (${leaseMs} ms) must be shorter than the retry window (${window} ms)`);
  }
}
