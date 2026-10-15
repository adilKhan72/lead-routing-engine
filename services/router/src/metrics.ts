import { createServer, type Server } from 'node:http';
import { Counter, createRegistry, Gauge, Histogram, LATENCY_BUCKETS, type Redis, type Registry } from '@lre/shared';
import type { CallObserver } from './http-gateway.ts';
import type { RouteOutcome } from './route-lead.ts';

export class RouterMetrics {
  readonly registry: Registry;
  private readonly routingDuration: Histogram<'outcome'>;
  private readonly decisions: Counter<'outcome' | 'reason'>;
  private readonly buyerCalls: Histogram<'phase' | 'result'>;
  private readonly handlerErrors: Counter;
  private readonly deadLettered: Counter;

  constructor(registry: Registry = createRegistry('router')) {
    this.registry = registry;
    this.routingDuration = new Histogram({
      name: 'lre_routing_duration_seconds',
      help: 'Time to route one lead message, from claim to commit, by outcome',
      labelNames: ['outcome'],
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    });
    this.decisions = new Counter({
      name: 'lre_routing_outcomes_total',
      help: 'Lead messages handled, by outcome (sold, unsold, duplicate, busy, lost_lease, missing)',
      labelNames: ['outcome', 'reason'],
      registers: [registry],
    });
    this.buyerCalls = new Histogram({
      name: 'lre_buyer_call_duration_seconds',
      help: 'Ping and post calls to buyer endpoints, by phase and result',
      labelNames: ['phase', 'result'],
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    });
    this.handlerErrors = new Counter({
      name: 'lre_routing_errors_total',
      help: 'Handler exceptions (infrastructure errors); the message is retried',
      registers: [registry],
    });
    this.deadLettered = new Counter({
      name: 'lre_dead_lettered_total',
      help: 'Messages moved to the dead-letter stream',
      registers: [registry],
    });
  }

  observeRouting(outcome: RouteOutcome, seconds: number): void {
    const reason = outcome.kind === 'unsold' ? outcome.reason : '';
    this.routingDuration.observe({ outcome: outcome.kind }, seconds);
    this.decisions.inc({ outcome: outcome.kind, reason });
  }

  observeError(): void {
    this.handlerErrors.inc();
  }

  observeDeadLetter(): void {
    this.deadLettered.inc();
  }

  readonly observeBuyerCall: CallObserver = (phase, result, durationMs) => {
    this.buyerCalls.observe({ phase, result }, durationMs / 1000);
  };

  /** Consumer-group backlog, read from Redis at scrape time: the signal to autoscale routers on. */
  trackStream(redis: Redis, stream: string, group: string): void {
    new Gauge({
      name: 'lre_stream_group_lag',
      help: 'Entries in the stream not yet delivered to the consumer group (XINFO GROUPS lag)',
      registers: [this.registry],
      async collect() {
        // Before the first router creates the group, the stream may not exist: report nothing then.
        const groups = (await redis.xinfo('GROUPS', stream).catch(() => [])) as (string | number | null)[][];
        for (const g of groups) {
          const fields = new Map<unknown, unknown>();
          for (let i = 0; i + 1 < g.length; i += 2) fields.set(g[i], g[i + 1]);
          if (fields.get('name') === group) this.set(Number(fields.get('lag') ?? 0));
        }
      },
    });
    new Gauge({
      name: 'lre_stream_group_pending',
      help: 'Entries delivered but not yet acknowledged (in flight or awaiting retry)',
      registers: [this.registry],
      async collect() {
        const summary = (await redis.xpending(stream, group).catch(() => null)) as [number, ...unknown[]] | null;
        if (summary) this.set(summary[0]);
      },
    });
  }
}

export function startMetricsServer(registry: Registry, port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType }).end(body);
        })
        .catch((err: unknown) => {
          res.writeHead(500).end(String(err));
        });
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
