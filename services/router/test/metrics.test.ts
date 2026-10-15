import { describe, expect, it } from 'vitest';
import { Registry } from '@lre/shared';
import { RouterMetrics } from '../src/metrics.ts';
import { routerHooks } from '../src/worker.ts';
import { makeBuyer, makeDeps, makeRoutableLead } from './fakes.ts';

describe('router metrics', () => {
  it('counts outcomes, routing latency, errors and dead letters', async () => {
    const metrics = new RouterMetrics(new Registry());
    const buyer = makeBuyer();
    const { deps, leads, gateway } = makeDeps([buyer]);
    leads.add(makeRoutableLead({ id: 'sold-lead' }));
    leads.add(makeRoutableLead({ id: 'done-lead' }), 'sold');
    const hooks = routerHooks(deps, metrics);

    await hooks.handle('sold-lead');
    await hooks.handle('done-lead');
    leads.add(makeRoutableLead({ id: 'broken-lead' }));
    gateway.script.set(buyer.id, new Error('db down'));
    await expect(hooks.handle('broken-lead')).rejects.toThrow();
    await hooks.onDeadLetter?.('broken-lead', 'max deliveries');

    const text = await metrics.registry.metrics();
    expect(text).toContain('lre_routing_outcomes_total{outcome="sold",reason=""} 1');
    expect(text).toContain('lre_routing_outcomes_total{outcome="duplicate",reason=""} 1');
    expect(text).toContain('lre_routing_duration_seconds_count{outcome="sold"} 1');
    expect(text).toContain('lre_routing_errors_total 1');
    expect(text).toContain('lre_dead_lettered_total 1');
    expect(leads.leads.get('broken-lead')?.status).toBe('failed');
  });
});
