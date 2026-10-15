import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Counter, Histogram, LATENCY_BUCKETS, LeadSchema, type Logger, type Registry } from '@lre/shared';
import { acceptLead, type AcceptDeps } from './accept-lead.ts';

export interface AppDeps extends AcceptDeps {
  /** Readiness probe: resolves when dependencies are reachable. */
  ready?: () => Promise<void>;
}

const IdempotencyKey = z.string().min(8).max(255).regex(/^[\w.:-]+$/);
const LeadIdParam = z.strictObject({ id: z.uuid() });

export function buildApp(deps: AppDeps, opts: { logger?: Logger; registry?: Registry } = {}): FastifyInstance {
  // Widened to Fastify's logger type so the instance type matches FastifyInstance's defaults.
  const logger: FastifyBaseLogger | undefined = opts.logger;
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: false }),
    bodyLimit: 16 * 1024,
  });

  const registry = opts.registry;
  const accepted = registry
    ? new Counter({
        name: 'lre_leads_accepted_total',
        help: 'Leads answered with 202, split by whether the request was an idempotent replay',
        labelNames: ['replayed'],
        registers: [registry],
      })
    : null;
  if (registry) {
    const duration = new Histogram({
      name: 'lre_http_request_duration_seconds',
      help: 'HTTP request latency by route and status code',
      labelNames: ['method', 'route', 'status_code'],
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    });
    app.addHook('onResponse', async (req, reply) => {
      // routeOptions.url is the route pattern (/v1/leads/:id), which keeps label cardinality bounded.
      const route = req.routeOptions.url ?? 'unmatched';
      duration.observe({ method: req.method, route, status_code: reply.statusCode }, reply.elapsedTime / 1000);
    });
    app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  }

  app.post('/v1/leads', async (req, reply) => {
    const key = IdempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!key.success) {
      return reply.code(400).send({
        error: 'invalid_idempotency_key',
        message: 'Idempotency-Key header is required: 8-255 chars of [A-Za-z0-9_.:-]',
      });
    }
    const parsed = LeadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_lead',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const result = await acceptLead(deps, key.data, parsed.data);
    if (result.kind === 'conflict') {
      return reply.code(409).send({
        error: 'idempotency_key_reused',
        message: 'This Idempotency-Key was already used with a different payload',
        leadId: result.leadId,
      });
    }
    accepted?.inc({ replayed: String(result.replayed) });
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return reply
      .code(202)
      .header('location', `/v1/leads/${result.lead.id}`)
      .send({ leadId: result.lead.id, status: result.lead.status });
  });

  app.get('/v1/leads/:id', async (req, reply) => {
    const params = LeadIdParam.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const lead = await deps.repo.findById(params.data.id);
    if (!lead) return reply.code(404).send({ error: 'not_found' });
    return { leadId: lead.id, status: lead.status, receivedAt: lead.receivedAt.toISOString() };
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.ready?.();
      return { status: 'ready' };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}

