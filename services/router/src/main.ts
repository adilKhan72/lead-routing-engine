import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { createLogger, createPool, createRedis, loadConfig, ROUTER_GROUP, STREAMS } from '@lre/shared';
import { AcceptAllGateway, type BuyerGateway } from './buyer-gateway.ts';
import { CachedBuyerSource, PgBuyerSource } from './buyer-source.ts';
import { PgCapStore } from './caps.ts';
import { HttpPingPostGateway } from './http-gateway.ts';
import { PgLeadStore } from './lead-store.ts';
import { RouterMetrics, startMetricsServer } from './metrics.ts';
import { assertLeaseFitsRetryWindow } from './retry-policy.ts';
import { StreamConsumer } from './stream-consumer.ts';
import { routerHooks } from './worker.ts';

const config = loadConfig({
  CONSUMER_NAME: z.string().min(1).default(hostname()),
  PG_POOL_SIZE: z.coerce.number().int().positive().default(20),
  CONCURRENCY: z.coerce.number().int().positive().default(32),
  ROUTING_BUDGET_MS: z.coerce.number().int().positive().default(2_000),
  LEASE_MS: z.coerce.number().int().positive().default(10_000),
  BUYER_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(5_000),
  MAX_DELIVERIES: z.coerce.number().int().min(2).default(5),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
  RETRY_MAX_MS: z.coerce.number().int().positive().default(30_000),
  // `accept-all` isolates the engine from buyer latency (load tests); `http` is real ping-post.
  ROUTER_GATEWAY: z.enum(['http', 'accept-all']).default('http'),
  METRICS_PORT: z.coerce.number().int().default(9100),
});

const log = createLogger('router', config.LOG_LEVEL);
const retry = { maxDeliveries: config.MAX_DELIVERIES, baseMs: config.RETRY_BASE_MS, maxMs: config.RETRY_MAX_MS };
assertLeaseFitsRetryWindow(config.LEASE_MS, retry);

const pool = createPool(config.DATABASE_URL, config.PG_POOL_SIZE);
const redis = createRedis(config.REDIS_URL);
const metrics = new RouterMetrics();
metrics.trackStream(redis, STREAMS.leadReceived, ROUTER_GROUP);
const metricsServer = startMetricsServer(metrics.registry, config.METRICS_PORT);
const monotonicMs = () => performance.now();
const gateway: BuyerGateway =
  config.ROUTER_GATEWAY === 'http'
    ? new HttpPingPostGateway({ monotonicMs, observe: metrics.observeBuyerCall })
    : new AcceptAllGateway();

const routerDeps = {
  leads: new PgLeadStore(pool),
  buyers: new CachedBuyerSource(new PgBuyerSource(pool, log), config.BUYER_CACHE_TTL_MS),
  caps: new PgCapStore(pool),
  gateway,
  log,
  now: () => new Date(),
  monotonicMs,
  rng: Math.random,
  workerName: config.CONSUMER_NAME,
  budgetMs: config.ROUTING_BUDGET_MS,
  leaseMs: config.LEASE_MS,
};
const hooks = routerHooks(routerDeps, metrics);

// The consumer gets its own connection: XREADGROUP BLOCK would stall the metrics' XINFO/XPENDING calls.
const consumerRedis = createRedis(config.REDIS_URL);
const consumer = new StreamConsumer(
  consumerRedis,
  {
    stream: STREAMS.leadReceived,
    deadLetterStream: STREAMS.deadLetter,
    group: ROUTER_GROUP,
    consumer: config.CONSUMER_NAME,
    concurrency: config.CONCURRENCY,
    blockMs: 2_000,
    reclaimIntervalMs: Math.min(config.RETRY_BASE_MS, 5_000),
    retry,
  },
  hooks,
  log,
);

const running = consumer.run();
log.info({ consumer: config.CONSUMER_NAME, gateway: config.ROUTER_GATEWAY }, 'router started');

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down; finishing in-flight batch');
  consumer.stop();
  await running; // unacked messages left behind are reclaimed by other consumers
  metricsServer.close();
  await Promise.allSettled([pool.end(), redis.quit(), consumerRedis.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
