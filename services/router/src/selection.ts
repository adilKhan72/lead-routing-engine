import type { Buyer } from './buyer.ts';

/** Returns a float in [0, 1), like Math.random. Injected so tests are deterministic. */
export type Rng = () => number;

/**
 * Orders candidates for the fallback walk: strictly by price (highest first); buyers at the same price are
 * shuffled with probability proportional to weight.
 *
 * Weighted shuffle uses Efraimidis-Spirakis keys in their exponential form: key = -ln(u) / w, ascending.
 * The first element is buyer i with probability w_i / sum(w), and every later position follows the same rule
 * over the remaining buyers, which is exactly "weighted random, then fall back to the next weighted pick".
 */
export function orderCandidates(buyers: readonly Buyer[], rng: Rng): Buyer[] {
  const keyed = buyers.map((buyer) => ({ buyer, key: -Math.log(1 - rng()) / buyer.weight }));
  keyed.sort((a, b) => b.buyer.priceCents - a.buyer.priceCents || a.key - b.key);
  return keyed.map((k) => k.buyer);
}

/** Small seedable PRNG (mulberry32) for tests and reproducible simulations; not for anything security-related. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
