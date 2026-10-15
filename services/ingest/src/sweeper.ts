import type { Logger } from '@lre/shared';
import type { LeadRepository } from './lead-repository.ts';
import type { LeadPublisher } from './publisher.ts';

export interface SweeperOptions {
  /** Only leads unpublished for longer than this are swept, so in-flight requests are left alone. */
  graceMs: number;
  batchSize: number;
}

/**
 * One pass of the outbox relay. Several ingest replicas may sweep the same lead and publish it twice;
 * that is fine because the router is an idempotent consumer.
 */
export async function sweepUnpublished(
  repo: LeadRepository,
  publisher: LeadPublisher,
  log: Logger,
  opts: SweeperOptions,
): Promise<number> {
  const ids = await repo.findUnpublished(opts.graceMs, opts.batchSize);
  let published = 0;
  for (const id of ids) {
    try {
      await publisher.publishReceived(id);
      await repo.markPublished(id);
      published++;
    } catch (err) {
      log.warn({ err, leadId: id }, 'sweeper publish failed');
      break; // The broker is probably down; try again next tick rather than hammering it.
    }
  }
  if (published > 0) log.info({ published }, 'sweeper republished leads');
  return published;
}

export function startSweeper(
  repo: LeadRepository,
  publisher: LeadPublisher,
  log: Logger,
  opts: SweeperOptions & { intervalMs: number },
): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return; // A slow pass must not overlap with the next one.
    running = sweepUnpublished(repo, publisher, log, opts)
      .catch((err: unknown) => {
        log.error({ err }, 'sweeper pass failed');
      })
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
