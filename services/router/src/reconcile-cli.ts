import { createLogger, createPool, createRedis, loadConfig } from '@lre/shared';
import { z } from 'zod';
import { reconcile } from './reconcile.ts';

// One-shot: run by a Kubernetes CronJob (deploy/k8s/base/reconciler.yaml) or by hand with DRY_RUN=true.
const config = loadConfig({
  STUCK_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  LEASE_GRACE_MS: z.coerce.number().int().nonnegative().default(60_000),
  MAX_REPUBLISH_PER_RUN: z.coerce.number().int().positive().default(500),
  MAX_REPUBLISH_PER_LEAD: z.coerce.number().int().positive().default(5),
  DRY_RUN: z.stringbool().default(false),
});

const log = createLogger('reconciler', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, 2);
const redis = createRedis(config.REDIS_URL);

try {
  const report = await reconcile(pool, redis, {
    now: new Date(),
    stuckAfterMs: config.STUCK_AFTER_MS,
    leaseGraceMs: config.LEASE_GRACE_MS,
    maxRepublishPerRun: config.MAX_REPUBLISH_PER_RUN,
    maxRepublishPerLead: config.MAX_REPUBLISH_PER_LEAD,
    dryRun: config.DRY_RUN,
  });
  const level = report.exhausted > 0 || report.slotsReleased > 0 ? 'warn' : 'info';
  log[level](
    { republished: report.republished.length, exhausted: report.exhausted, slotsReleased: report.slotsReleased, capRepairs: report.capRepairs, dryRun: report.dryRun },
    'reconciliation finished',
  );
} finally {
  await Promise.allSettled([pool.end(), redis.quit()]);
}
