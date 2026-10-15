import type { Lead } from '@lre/shared';
import type { InsertResult, LeadRepository, StoredLead } from '../src/lead-repository.ts';
import type { LeadPublisher } from '../src/publisher.ts';

export class InMemoryLeadRepository implements LeadRepository {
  readonly byKey = new Map<string, StoredLead>();
  readonly payloads = new Map<string, Lead>();
  now = new Date('2026-10-15T10:00:00Z');

  insertOrGet(input: { id: string; idempotencyKey: string; payloadHash: string; lead: Lead }): Promise<InsertResult> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return Promise.resolve({ lead: existing, created: false });
    const lead: StoredLead = {
      id: input.id,
      payloadHash: input.payloadHash,
      status: 'received',
      receivedAt: this.now,
      publishedAt: null,
    };
    this.byKey.set(input.idempotencyKey, lead);
    this.payloads.set(input.id, input.lead);
    return Promise.resolve({ lead, created: true });
  }

  markPublished(id: string): Promise<void> {
    for (const lead of this.byKey.values()) if (lead.id === id) lead.publishedAt ??= this.now;
    return Promise.resolve();
  }

  findById(id: string): Promise<StoredLead | null> {
    return Promise.resolve([...this.byKey.values()].find((l) => l.id === id) ?? null);
  }

  findUnpublished(_olderThanMs: number, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.byKey.values()]
        .filter((l) => l.publishedAt === null)
        .slice(0, limit)
        .map((l) => l.id),
    );
  }
}

export class FakePublisher implements LeadPublisher {
  readonly published: string[] = [];
  failing = false;

  publishReceived(leadId: string): Promise<void> {
    if (this.failing) return Promise.reject(new Error('redis down'));
    this.published.push(leadId);
    return Promise.resolve();
  }
}
