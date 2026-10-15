import { describe, expect, it } from 'vitest';
import { assertLeaseFitsRetryWindow, backoffMs, pendingAction, retryWindowMs } from '../src/retry-policy.ts';
import { toHandlerResult } from '../src/worker.ts';

const policy = { maxDeliveries: 5, baseMs: 1_000, maxMs: 6_000 };

describe('retry policy', () => {
  it('backs off exponentially up to the cap', () => {
    expect([1, 2, 3, 4, 5].map((d) => backoffMs(d, policy))).toEqual([1_000, 2_000, 4_000, 6_000, 6_000]);
  });

  it('waits, retries, then dead-letters', () => {
    expect(pendingAction(2, 1_999, policy)).toBe('wait');
    expect(pendingAction(2, 2_000, policy)).toBe('retry');
    expect(pendingAction(5, 0, policy)).toBe('dead-letter');
  });

  it('refuses a lease longer than the retry window', () => {
    expect(retryWindowMs(policy)).toBe(13_000);
    expect(() => {
      assertLeaseFitsRetryWindow(10_000, policy);
    }).not.toThrow();
    expect(() => {
      assertLeaseFitsRetryWindow(13_000, policy);
    }).toThrow(/lease/);
  });
});

describe('toHandlerResult', () => {
  it('acks everything except busy (retry) and missing (dead-letter)', () => {
    expect(toHandlerResult({ kind: 'sold', buyerId: 'b', priceCents: 1 })).toBe('ack');
    expect(toHandlerResult({ kind: 'unsold', reason: 'all_declined' })).toBe('ack');
    expect(toHandlerResult({ kind: 'duplicate' })).toBe('ack');
    expect(toHandlerResult({ kind: 'lost_lease' })).toBe('ack');
    expect(toHandlerResult({ kind: 'busy' })).toBe('retry');
    expect(toHandlerResult({ kind: 'missing' })).toEqual({ deadLetter: 'lead not found' });
  });
});
