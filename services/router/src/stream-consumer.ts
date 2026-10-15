import type { Logger, Redis } from '@lre/shared';
import { parseLeadReceived } from '@lre/shared';
import { pendingAction, type RetryPolicy } from './retry-policy.ts';

export type HandlerResult = 'ack' | 'retry' | { deadLetter: string };

export interface StreamConsumerOptions {
  stream: string;
  deadLetterStream: string;
  group: string;
  consumer: string;
  /** Maximum messages being handled at once. New messages are read as soon as a slot frees up. */
  concurrency: number;
  blockMs: number;
  reclaimIntervalMs: number;
  retry: RetryPolicy;
}

export interface StreamConsumerHooks {
  handle(leadId: string): Promise<HandlerResult>;
  /** Called before a message is moved to the dead-letter stream (e.g. to mark the lead failed). */
  onDeadLetter?(leadId: string | null, reason: string): Promise<void>;
}

type StreamEntry = [id: string, fields: string[]];

export class StreamConsumer {
  private readonly redis: Redis;
  private readonly opts: StreamConsumerOptions;
  private readonly hooks: StreamConsumerHooks;
  private readonly log: Logger;
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private lastReclaim = 0;

  constructor(redis: Redis, opts: StreamConsumerOptions, hooks: StreamConsumerHooks, log: Logger) {
    this.redis = redis;
    this.opts = opts;
    this.hooks = hooks;
    this.log = log.child({ consumer: opts.consumer });
  }

  async ensureGroup(): Promise<void> {
    try {
      // Start from 0 so leads published before the first router came up are not skipped.
      await this.redis.xgroup('CREATE', this.opts.stream, this.opts.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err;
    }
  }

  stop(): void {
    this.stopping = true;
  }

  /**
   * Runs until stop(), then waits for in-flight messages. Messages are handled in a sliding window of
   * `concurrency`: a slow lead (a buyer timing out) holds one slot, not a whole batch.
   */
  async run(): Promise<void> {
    await this.ensureGroup();
    // A dedicated connection for the blocking XREADGROUP, so acks from finished handlers never queue behind it.
    const reader = this.redis.duplicate();
    try {
      while (!this.stopping) {
        try {
          const free = this.opts.concurrency - this.inFlight.size;
          if (free <= 0) {
            await Promise.race(this.inFlight);
            continue;
          }
          await this.readNew(reader, free);
          if (Date.now() - this.lastReclaim >= this.opts.reclaimIntervalMs) await this.reclaim();
        } catch (err) {
          this.log.error({ err }, 'consumer loop error; backing off');
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      await Promise.allSettled(this.inFlight);
    } finally {
      reader.disconnect();
    }
  }

  private async readNew(reader: Redis, count: number): Promise<void> {
    const reply = (await reader.xreadgroup(
      'GROUP', this.opts.group, this.opts.consumer,
      'COUNT', count,
      'BLOCK', this.opts.blockMs,
      'STREAMS', this.opts.stream, '>',
    )) as [string, StreamEntry[]][] | null;
    for (const [id, fields] of reply?.[0]?.[1] ?? []) this.track(this.process(id, fields));
  }

  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((err: unknown) => {
        // Only Redis failures (ack / dead-letter) land here; the message stays pending and is retried.
        this.log.error({ err }, 'failed to settle message');
      })
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * Retry path: looks at messages that were delivered but not acked (a handler failed, or a consumer died),
   * claims those whose backoff has elapsed and processes them again, or dead-letters them once they have
   * been delivered maxDeliveries times.
   */
  async reclaim(): Promise<number> {
    this.lastReclaim = Date.now();
    const free = this.opts.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const pending = (await this.redis.xpending(
      this.opts.stream, this.opts.group, 'IDLE', this.opts.retry.baseMs, '-', '+', 100,
    )) as [id: string, consumer: string, idleMs: number, deliveries: number][];

    let handled = 0;
    for (const [id, , idleMs, deliveries] of pending) {
      if (handled >= free) break;
      const action = pendingAction(deliveries, idleMs, this.opts.retry);
      if (action === 'wait') continue;
      // XCLAIM with a min-idle equal to what we just observed: if another consumer claimed it in the
      // meantime its idle time was reset, so this returns nothing and we leave it alone.
      const claimed = (await this.redis.xclaim(
        this.opts.stream, this.opts.group, this.opts.consumer, idleMs, id,
      )) as StreamEntry[];
      const entry = claimed[0];
      if (!entry) continue;
      handled++;
      if (action === 'dead-letter') {
        await this.deadLetter(entry[0], entry[1], `max deliveries (${deliveries}) exceeded`, deliveries);
      } else {
        this.track(this.process(entry[0], entry[1]));
      }
    }
    return handled;
  }

  private async process(id: string, fields: string[]): Promise<void> {
    const event = parseLeadReceived(fields);
    if (!event) {
      await this.deadLetter(id, fields, 'unparseable message', 1);
      return;
    }
    let result: HandlerResult;
    try {
      result = await this.hooks.handle(event.leadId);
    } catch (err) {
      // Not acked: the message stays in the pending list and reclaim() retries it with backoff.
      this.log.warn({ err, leadId: event.leadId, messageId: id }, 'handler failed; will retry');
      return;
    }
    if (result === 'ack') {
      await this.redis.xack(this.opts.stream, this.opts.group, id);
    } else if (result !== 'retry') {
      await this.deadLetter(id, fields, result.deadLetter, 1);
    }
  }

  private async deadLetter(id: string, fields: string[], reason: string, deliveries: number): Promise<void> {
    const leadId = parseLeadReceived(fields)?.leadId ?? null;
    await this.hooks.onDeadLetter?.(leadId, reason);
    // One MULTI so the message is never both acked-and-lost or dead-lettered-and-still-pending.
    await this.redis
      .multi()
      .xadd(
        this.opts.deadLetterStream, '*',
        'originalId', id, 'leadId', leadId ?? '', 'reason', reason,
        'deliveries', String(deliveries), 'consumer', this.opts.consumer, 'fields', JSON.stringify(fields),
      )
      .xack(this.opts.stream, this.opts.group, id)
      .exec();
    this.log.error({ messageId: id, leadId, reason }, 'message dead-lettered');
  }
}
