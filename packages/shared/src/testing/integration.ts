import { createPool, type Pool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { createRedis, type Redis } from '../redis.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for integration tests (see README "Running tests")`);
  return value;
}

export interface IntegrationContext {
  pool: Pool;
  redis: Redis;
  close(): Promise<void>;
}

/** Fresh schema and empty Redis db. Integration test files run serially, so a full reset is safe. */
export async function setupIntegration(poolSize = 20): Promise<IntegrationContext> {
  const pool = createPool(requireEnv('DATABASE_URL'), poolSize);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const redis = createRedis(requireEnv('REDIS_URL'));
  await redis.flushdb();
  return {
    pool,
    redis,
    close: async () => {
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}
