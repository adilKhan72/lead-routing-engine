import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { createLogger, createPool, createRedis, loadConfig, ROUTER_GROUP, STREAMS } from '@lre/shared';
import { AcceptAllGateway } from './buyer-gateway.ts';
import { CachedBuyerSource, PgBuyerSource } from './buyer-source.ts';
import { PgCapStore } from './caps.ts';
import { PgLeadStore } from './lead-store.ts';
import { assertLeaseFitsRetryWindow } from './retry-policy.ts';
import { StreamConsumer } from './stream-consumer.ts';
import { routerHooks } from './worker.ts';

const config = loadConfig({
  CONSUMER_NAME: z.string().min(1).default(hostname()),
  PG_POOL_SIZE: z.coerce.number().int().positive().default(20),
  BATCH_SIZE: z.coerce.number().int().positive().default(16),
  ROUTING_BUDGET_MS: z.coerce.number().int().positive().default(2_000),
  LEASE_MS: z.coerce.number().int().positive().default(10_000),
  BUYER_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(5_000),
  MAX_DELIVERIES: z.coerce.number().int().min(2).default(5),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
  RETRY_MAX_MS: z.coerce.number().int().positive().default(30_000),
});

const log = createLogger('router', config.LOG_LEVEL);
const retry = { maxDeliveries: config.MAX_DELIVERIES, baseMs: config.RETRY_BASE_MS, maxMs: config.RETRY_MAX_MS };
assertLeaseFitsRetryWindow(config.LEASE_MS, retry);

const pool = createPool(config.DATABASE_URL, config.PG_POOL_SIZE);
const redis = createRedis(config.REDIS_URL);

const hooks = routerHooks({
  leads: new PgLeadStore(pool),
  buyers: new CachedBuyerSource(new PgBuyerSource(pool, log), config.BUYER_CACHE_TTL_MS),
  caps: new PgCapStore(pool),
  gateway: new AcceptAllGateway(),
  log,
  now: () => new Date(),
  monotonicMs: () => performance.now(),
  rng: Math.random,
  workerName: config.CONSUMER_NAME,
  budgetMs: config.ROUTING_BUDGET_MS,
  leaseMs: config.LEASE_MS,
});

const consumer = new StreamConsumer(
  redis,
  {
    stream: STREAMS.leadReceived,
    deadLetterStream: STREAMS.deadLetter,
    group: ROUTER_GROUP,
    consumer: config.CONSUMER_NAME,
    batchSize: config.BATCH_SIZE,
    blockMs: 2_000,
    reclaimIntervalMs: Math.min(config.RETRY_BASE_MS, 5_000),
    retry,
  },
  hooks,
  log,
);

const running = consumer.run();
log.info({ consumer: config.CONSUMER_NAME }, 'router started');

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down; finishing in-flight batch');
  consumer.stop();
  await running; // unacked messages left behind are reclaimed by other consumers
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
