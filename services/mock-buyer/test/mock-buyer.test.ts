import { describe, expect, it } from 'vitest';
import { buildMockBuyer } from '../src/app.ts';
import { decidePing, PROFILES } from '../src/profiles.ts';

const constant = (v: number) => () => v;
const noDelay = () => Promise.resolve();

describe('mock buyer', () => {
  it('answers pings according to the profile', async () => {
    const app = buildMockBuyer({ rng: constant(0.5), delay: noDelay });
    const ping = (profile: string, creditBand = 'good') =>
      app.inject({ method: 'POST', url: `/${profile}/ping`, payload: { leadId: 'l1', creditBand } });

    expect((await ping('fast')).json()).toEqual({ accept: true });
    expect((await ping('never')).json()).toEqual({ accept: false, reason: 'declined' });
    expect((await ping('picky')).json()).toEqual({ accept: false, reason: 'credit band not wanted' });
    expect((await ping('picky', 'excellent')).json()).toEqual({ accept: true });
  });

  it('fails with 503 at the profile error rate and 404s unknown profiles', async () => {
    const app = buildMockBuyer({ rng: constant(0.1), delay: noDelay });
    expect((await app.inject({ method: 'POST', url: '/flaky/post', payload: { leadId: 'l1' } })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/nope/ping', payload: { leadId: 'l1' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/fast/ping', payload: {} })).statusCode).toBe(400);
  });

  it('decides deterministically for a given random source', () => {
    expect(decidePing(PROFILES.fast!, 'good', constant(0.95))).toEqual({ kind: 'answer', accept: false, reason: 'declined' });
    expect(decidePing(PROFILES.flaky!, 'good', constant(0.29))).toEqual({ kind: 'error' });
  });
});
