import { describe, expect, it } from 'vitest';
import { routeLead } from '../src/route-lead.ts';
import { makeBuyer, makeDeps, makeRoutableLead } from './fakes.ts';

describe('routeLead', () => {
  it('sells to the highest-paying eligible buyer and records the decision', async () => {
    const low = makeBuyer({ priceCents: 800 });
    const high = makeBuyer({ priceCents: 1_200 });
    const notInTexas = makeBuyer({ priceCents: 5_000, criteria: { states: ['CA'] } });
    const { deps, leads, gateway } = makeDeps([low, high, notInTexas]);
    leads.add(makeRoutableLead());

    expect(await routeLead(deps, 'lead-1')).toEqual({ kind: 'sold', buyerId: high.id, priceCents: 1_200 });
    expect(gateway.calls).toEqual([high.id]);
    expect(leads.decisions.get('lead-1')).toMatchObject({ outcome: 'sold', buyerId: high.id, priceCents: 1_200 });
  });

  it('falls back to the next buyer on reject, timeout or error, releasing each cap slot', async () => {
    const a = makeBuyer({ priceCents: 4_000, dailyCap: 10 });
    const b = makeBuyer({ priceCents: 3_000, dailyCap: 10 });
    const c = makeBuyer({ priceCents: 2_000, dailyCap: 10 });
    const d = makeBuyer({ priceCents: 1_000, dailyCap: 10 });
    const { deps, leads, gateway, caps } = makeDeps([a, b, c, d]);
    gateway.script.set(a.id, { result: 'rejected', reason: 'not buying today' });
    gateway.script.set(b.id, { result: 'timeout', reason: 'ping exceeded 300ms' });
    gateway.script.set(c.id, { result: 'error', reason: 'HTTP 502' });
    leads.add(makeRoutableLead());

    expect(await routeLead(deps, 'lead-1')).toMatchObject({ kind: 'sold', buyerId: d.id });
    expect(gateway.calls).toEqual([a.id, b.id, c.id, d.id]);
    expect(caps.used.get(`${a.id}:day`)).toBe(0);
    expect(caps.used.get(`${d.id}:day`)).toBe(1);
    expect(leads.decisions.get('lead-1')?.attempts.map((x) => x.result)).toEqual([
      'rejected',
      'timeout',
      'error',
      'accepted',
    ]);
  });

  it('skips buyers whose cap is full without calling them', async () => {
    const full = makeBuyer({ priceCents: 2_000, hourlyCap: 1 });
    const open = makeBuyer({ priceCents: 1_000 });
    const { deps, leads, gateway, caps } = makeDeps([full, open]);
    caps.used.set(`${full.id}:hour`, 1);
    leads.add(makeRoutableLead());

    expect(await routeLead(deps, 'lead-1')).toMatchObject({ kind: 'sold', buyerId: open.id });
    expect(gateway.calls).toEqual([open.id]);
    expect(leads.decisions.get('lead-1')?.attempts[0]).toEqual({ buyerId: full.id, result: 'cap_full' });
  });

  it('records unsold with a reason when nobody is eligible or everyone declines', async () => {
    const picky = makeBuyer({ criteria: { creditBands: ['excellent'] } });
    const one = makeDeps([picky]);
    one.leads.add(makeRoutableLead());
    expect(await routeLead(one.deps, 'lead-1')).toEqual({ kind: 'unsold', reason: 'no_eligible_buyer' });
    expect(one.leads.leads.get('lead-1')?.status).toBe('unsold');

    const decliner = makeBuyer();
    const two = makeDeps([decliner]);
    two.gateway.script.set(decliner.id, { result: 'rejected', reason: 'no' });
    two.leads.add(makeRoutableLead());
    expect(await routeLead(two.deps, 'lead-1')).toEqual({ kind: 'unsold', reason: 'all_declined' });
  });

  it('stops walking the list when the latency budget is spent', async () => {
    const slow = makeBuyer({ priceCents: 2_000 });
    const never = makeBuyer({ priceCents: 1_000 });
    const { deps, leads, gateway, clock } = makeDeps([slow, never]);
    gateway.script.set(slow.id, { result: 'timeout', reason: 'slow' });
    gateway.onCall = () => (clock.ms += 2_500);
    leads.add(makeRoutableLead());

    expect(await routeLead(deps, 'lead-1')).toEqual({ kind: 'unsold', reason: 'budget_exhausted' });
    expect(gateway.calls).toEqual([slow.id]);
  });

  it('treats a duplicate message for a final lead as a no-op', async () => {
    const { deps, leads, gateway } = makeDeps([makeBuyer()]);
    leads.add(makeRoutableLead(), 'sold');
    expect(await routeLead(deps, 'lead-1')).toEqual({ kind: 'duplicate' });
    expect(gateway.calls).toEqual([]);
  });

  it('reports busy (do not ack) while another worker holds the lease', async () => {
    const { deps, leads } = makeDeps([makeBuyer()]);
    leads.add(makeRoutableLead(), 'routing');
    expect(await routeLead(deps, 'lead-1')).toEqual({ kind: 'busy' });
  });

  it('does not record a sale and releases the cap when fenced out by a newer claim', async () => {
    const buyer = makeBuyer({ dailyCap: 5 });
    const { deps, leads, caps } = makeDeps([buyer]);
    leads.add(makeRoutableLead());
    leads.stealLeaseOnFinalize = true;

    expect(await routeLead(deps, 'lead-1')).toEqual({ kind: 'lost_lease' });
    expect(leads.decisions.size).toBe(0);
    expect(caps.used.get(`${buyer.id}:day`)).toBe(0);
  });

  it('releases the cap and propagates infrastructure errors so the message is retried', async () => {
    const buyer = makeBuyer({ dailyCap: 5 });
    const { deps, leads, caps, gateway } = makeDeps([buyer]);
    gateway.script.set(buyer.id, new Error('socket hang up in gateway'));
    leads.add(makeRoutableLead());

    await expect(routeLead(deps, 'lead-1')).rejects.toThrow('socket hang up');
    expect(caps.used.get(`${buyer.id}:day`)).toBe(0);
  });
});
