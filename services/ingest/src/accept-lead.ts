import { randomUUID } from 'node:crypto';
import { payloadHash, type Lead, type Logger } from '@lre/shared';
import type { LeadRepository, StoredLead } from './lead-repository.ts';
import type { LeadPublisher } from './publisher.ts';

export type AcceptResult =
  | { kind: 'accepted'; lead: StoredLead; replayed: boolean }
  | { kind: 'conflict'; leadId: string };

export interface AcceptDeps {
  repo: LeadRepository;
  publisher: LeadPublisher;
  log: Logger;
  newId?: () => string;
}

/**
 * Stores the lead (idempotently) and then publishes it. The publish is best-effort: if it fails the lead
 * is still durably accepted with published_at NULL and the outbox sweeper publishes it later (ADR-0003).
 */
export async function acceptLead(deps: AcceptDeps, idempotencyKey: string, lead: Lead): Promise<AcceptResult> {
  const hash = payloadHash(lead);
  const { lead: stored, created } = await deps.repo.insertOrGet({
    id: (deps.newId ?? randomUUID)(),
    idempotencyKey,
    payloadHash: hash,
    lead,
  });

  if (!created && stored.payloadHash !== hash) {
    return { kind: 'conflict', leadId: stored.id };
  }

  // Also covers a replay of a lead whose first publish failed: the retry gets a second chance to publish.
  if (stored.publishedAt === null) {
    try {
      await deps.publisher.publishReceived(stored.id);
      await deps.repo.markPublished(stored.id);
    } catch (err) {
      deps.log.warn({ err, leadId: stored.id }, 'publish failed; outbox sweeper will retry');
    }
  }

  return { kind: 'accepted', lead: stored, replayed: !created };
}
