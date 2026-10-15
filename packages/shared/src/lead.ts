import { createHash } from 'node:crypto';
import { z } from 'zod';

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export const PRODUCTS = ['personal_loan', 'auto_insurance'] as const;
export const CREDIT_BANDS = ['excellent', 'good', 'fair', 'poor'] as const;

export type UsState = (typeof US_STATES)[number];
export type Product = (typeof PRODUCTS)[number];
export type CreditBand = (typeof CREDIT_BANDS)[number];

export const LeadSchema = z
  .strictObject({
    product: z.enum(PRODUCTS),
    state: z.enum(US_STATES),
    zip: z.string().regex(/^\d{5}$/, 'must be a 5-digit ZIP code'),
    // Required for loans, meaningless for insurance (checked below).
    amountCents: z.int().min(10_000).max(10_000_000).optional(),
    creditBand: z.enum(CREDIT_BANDS),
    contact: z.strictObject({
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      email: z.email().max(254),
      phone: z.string().regex(/^\+1\d{10}$/, 'must be E.164 US format, e.g. +15555550123'),
    }),
    consent: z.strictObject({
      // A lead without recorded consent cannot legally be sold, so reject it at the edge.
      tcpa: z.literal(true),
      capturedAt: z.iso.datetime({ offset: true }),
    }),
    source: z.strictObject({
      publisherId: z.string().min(1).max(64),
      subId: z.string().max(64).optional(),
    }),
  })
  .superRefine((lead, ctx) => {
    if (lead.product === 'personal_loan' && lead.amountCents === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amountCents'], message: 'required for personal_loan' });
    }
  });

export type Lead = z.infer<typeof LeadSchema>;

/** JSON with object keys sorted recursively, so semantically equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function payloadHash(lead: Lead): string {
  return createHash('sha256').update(canonicalJson(lead)).digest('hex');
}
