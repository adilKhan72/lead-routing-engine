import { collectDefaultMetrics, Registry } from 'prom-client';

export { Counter, Gauge, Histogram, Registry } from 'prom-client';

/** A registry per service with process metrics and a `service` label on every series. */
export function createRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/** Latency buckets in seconds, from 1 ms to 5 s: the routing budget is 2 s and HTTP edge targets are tens of ms. */
export const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
