import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decidePing, decidePost, latency, PROFILES } from './profiles.ts';

const Params = z.object({ profile: z.string(), phase: z.enum(['ping', 'post']) });
const Body = z.looseObject({ leadId: z.string(), creditBand: z.string().optional() });

export interface MockBuyerOptions {
  rng?: () => number;
  /** Replace real sleeping in tests. */
  delay?: (ms: number) => Promise<unknown>;
}

export function buildMockBuyer(opts: MockBuyerOptions = {}): FastifyInstance {
  const rng = opts.rng ?? Math.random;
  const delay = opts.delay ?? sleep;
  const app = Fastify({ logger: false });

  app.post('/:profile/:phase', async (req, reply) => {
    const params = Params.safeParse(req.params);
    const profile = params.success ? PROFILES[params.data.profile] : undefined;
    if (!params.success || !profile) return reply.code(404).send({ error: 'unknown profile or phase' });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'leadId required' });

    await delay(latency(profile, rng));
    const answer =
      params.data.phase === 'ping' ? decidePing(profile, body.data.creditBand, rng) : decidePost(profile, rng);
    if (answer.kind === 'error') return reply.code(503).send({ error: 'temporarily unavailable' });
    return { accept: answer.accept, ...(answer.reason ? { reason: answer.reason } : {}) };
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  return app;
}
