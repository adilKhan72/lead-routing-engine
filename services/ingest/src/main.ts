import { z } from 'zod';
import { createLogger, createPool, createRedis, createRegistry, loadConfig } from '@lre/shared';
import { buildApp } from './app.ts';
import { PgLeadRepository } from './lead-repository.ts';
import { RedisStreamPublisher } from './publisher.ts';
import { startSweeper } from './sweeper.ts';

const config = loadConfig({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  PG_POOL_SIZE: z.coerce.number().int().positive().default(10),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  SWEEP_GRACE_MS: z.coerce.number().int().positive().default(10_000),
});

const log = createLogger('ingest', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, config.PG_POOL_SIZE);
const redis = createRedis(config.REDIS_URL);
const repo = new PgLeadRepository(pool);
const publisher = new RedisStreamPublisher(redis);

const app = buildApp(
  {
    repo,
    publisher,
    log,
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
    },
  },
  { logger: log, registry: createRegistry('ingest') },
);

const stopSweeper = startSweeper(repo, publisher, log, {
  intervalMs: config.SWEEP_INTERVAL_MS,
  graceMs: config.SWEEP_GRACE_MS,
  batchSize: 500,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  await app.close(); // stops accepting connections, drains in-flight requests
  await stopSweeper();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
