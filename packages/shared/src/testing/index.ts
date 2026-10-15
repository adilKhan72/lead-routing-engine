import type { Lead } from '../lead.ts';

/** A valid lead; override any top-level field. Shared by unit and integration tests. */
export function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    product: 'personal_loan',
    state: 'TX',
    zip: '73301',
    amountCents: 1_500_000,
    creditBand: 'good',
    contact: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+15555550123' },
    consent: { tcpa: true, capturedAt: '2026-10-15T09:30:00Z' },
    source: { publisherId: 'pub-1' },
    ...overrides,
  };
}
export * from './integration.ts';
