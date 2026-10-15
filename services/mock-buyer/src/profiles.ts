/**
 * Behaviour profiles for the simulated buyer endpoints. Each buyer in the demo seed points at one profile
 * (e.g. http://mock-buyer:4000/flaky), so a local run exercises timeouts, errors and rejections.
 */
export interface Profile {
  /** Probability that a ping is answered with accept=true. */
  acceptRate: number;
  /** Probability of an HTTP 503 instead of an answer. */
  errorRate: number;
  /** Response delay range in ms, uniform. */
  latencyMs: [min: number, max: number];
  /** Only accept these credit bands (if set). */
  creditBands?: string[];
}

export const PROFILES: Record<string, Profile> = {
  fast: { acceptRate: 0.9, errorRate: 0, latencyMs: [5, 30] },
  picky: { acceptRate: 1, errorRate: 0, latencyMs: [10, 40], creditBands: ['excellent'] },
  flaky: { acceptRate: 0.8, errorRate: 0.3, latencyMs: [10, 60] },
  // Slower than the default 300 ms ping timeout most of the time.
  slow: { acceptRate: 1, errorRate: 0, latencyMs: [200, 900] },
  never: { acceptRate: 0, errorRate: 0, latencyMs: [5, 15] },
};

export type Answer = { kind: 'error' } | { kind: 'answer'; accept: boolean; reason?: string };

/** A ping carries the buyer's decision. */
export function decidePing(profile: Profile, creditBand: string | undefined, rng: () => number): Answer {
  if (rng() < profile.errorRate) return { kind: 'error' };
  if (profile.creditBands && (!creditBand || !profile.creditBands.includes(creditBand))) {
    return { kind: 'answer', accept: false, reason: 'credit band not wanted' };
  }
  const accept = rng() < profile.acceptRate;
  return accept ? { kind: 'answer', accept } : { kind: 'answer', accept, reason: 'declined' };
}

export function latency(profile: Profile, rng: () => number): number {
  const [min, max] = profile.latencyMs;
  return Math.round(min + rng() * (max - min));
}

/** A post follows an accepted ping, so it only fails on infrastructure errors. */
export function decidePost(profile: Profile, rng: () => number): Answer {
  return rng() < profile.errorRate ? { kind: 'error' } : { kind: 'answer', accept: true };
}
