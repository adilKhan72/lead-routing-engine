import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { makeLead } from '@lre/shared/testing';
import { sweepUnpublished } from '../src/sweeper.ts';
import { FakePublisher, InMemoryLeadRepository } from './fakes.ts';

const silent = pino({ level: 'silent' });
const opts = { graceMs: 0, batchSize: 10 };

async function seed(repo: InMemoryLeadRepository, n: number) {
  for (let i = 0; i < n; i++) {
    await repo.insertOrGet({ id: `lead-${i}`, idempotencyKey: `key-${i}`, payloadHash: 'h', lead: makeLead() });
  }
}

describe('sweepUnpublished', () => {
  it('publishes unpublished leads and marks them', async () => {
    const repo = new InMemoryLeadRepository();
    const publisher = new FakePublisher();
    await seed(repo, 3);
    expect(await sweepUnpublished(repo, publisher, silent, opts)).toBe(3);
    expect(publisher.published).toEqual(['lead-0', 'lead-1', 'lead-2']);
    expect(await repo.findUnpublished(0, 10)).toEqual([]);
  });

  it('stops the pass at the first broker failure and leaves leads unpublished', async () => {
    const repo = new InMemoryLeadRepository();
    const publisher = new FakePublisher();
    publisher.failing = true;
    await seed(repo, 3);
    expect(await sweepUnpublished(repo, publisher, silent, opts)).toBe(0);
    expect(await repo.findUnpublished(0, 10)).toHaveLength(3);
  });
});
