import { describe, expect, it } from 'vitest';
import { orderCandidates, seededRng } from '../src/selection.ts';
import { makeBuyer } from './fakes.ts';

describe('orderCandidates', () => {
  it('orders strictly by price, highest first, regardless of weight', () => {
    const cheap = makeBuyer({ priceCents: 500, weight: 100 });
    const mid = makeBuyer({ priceCents: 1_000 });
    const top = makeBuyer({ priceCents: 2_500 });
    for (let seed = 0; seed < 50; seed++) {
      expect(orderCandidates([cheap, mid, top], seededRng(seed))).toEqual([top, mid, cheap]);
    }
  });

  it('is deterministic for a given random source', () => {
    const buyers = Array.from({ length: 6 }, () => makeBuyer());
    expect(orderCandidates(buyers, seededRng(7))).toEqual(orderCandidates(buyers, seededRng(7)));
  });

  it('puts equal-price buyers first in proportion to their weight', () => {
    const a = makeBuyer({ weight: 3 });
    const b = makeBuyer({ weight: 1 });
    const rng = seededRng(1234);
    const runs = 20_000;
    let aFirst = 0;
    for (let i = 0; i < runs; i++) if (orderCandidates([a, b], rng)[0] === a) aFirst++;
    // Expected 0.75; a 1.5-point tolerance is about 5 standard deviations at n = 20k.
    expect(aFirst / runs).toBeGreaterThan(0.735);
    expect(aFirst / runs).toBeLessThan(0.765);
  });

  it('keeps every candidate exactly once (it is a permutation)', () => {
    const buyers = Array.from({ length: 10 }, (_, i) => makeBuyer({ priceCents: 100 * (i % 3) + 100, weight: i + 1 }));
    const ordered = orderCandidates(buyers, seededRng(99));
    expect(new Set(ordered)).toEqual(new Set(buyers));
    expect(ordered).toHaveLength(buyers.length);
  });
});
