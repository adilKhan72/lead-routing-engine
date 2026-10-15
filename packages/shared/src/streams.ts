import type { Redis } from 'ioredis';

export const STREAMS = {
  leadReceived: 'leads.received',
  deadLetter: 'leads.dead-letter',
} as const;

export const ROUTER_GROUP = 'router';

// Approximate trimming keeps XADD O(1); the audit trail lives in Postgres, not in the stream.
const MAX_STREAM_LENGTH = 100_000;

export interface LeadReceivedEvent {
  type: 'lead.received';
  leadId: string;
}

/**
 * Only the lead id travels through Redis: the router reads the lead from Postgres (the source of truth),
 * which keeps contact details out of the broker and makes redelivered messages harmless.
 */
export async function publishLeadReceived(redis: Redis, leadId: string): Promise<string> {
  const id = await redis.xadd(
    STREAMS.leadReceived, 'MAXLEN', '~', String(MAX_STREAM_LENGTH), '*',
    'type', 'lead.received', 'leadId', leadId,
  );
  if (id === null) throw new Error('XADD returned no id');
  return id;
}

export function parseLeadReceived(fields: string[]): LeadReceivedEvent | null {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i] as string, fields[i + 1] as string);
  const leadId = map.get('leadId');
  if (map.get('type') !== 'lead.received' || !leadId) return null;
  return { type: 'lead.received', leadId };
}
