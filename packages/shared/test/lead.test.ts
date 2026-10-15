import { describe, expect, it } from 'vitest';
import { canonicalJson, LeadSchema, payloadHash } from '../src/index.ts';
import { makeLead } from '../src/testing/index.ts';

describe('LeadSchema', () => {
  it('accepts a valid loan lead', () => {
    expect(LeadSchema.safeParse(makeLead()).success).toBe(true);
  });

  it('requires an amount for personal loans but not for insurance', () => {
    const { amountCents: _omit, ...noAmount } = makeLead();
    const loan = LeadSchema.safeParse(noAmount);
    expect(loan.success).toBe(false);
    expect(loan.error?.issues[0]?.path).toEqual(['amountCents']);

    expect(LeadSchema.safeParse({ ...noAmount, product: 'auto_insurance' }).success).toBe(true);
  });

  it('rejects a lead without TCPA consent', () => {
    const lead = { ...makeLead(), consent: { tcpa: false, capturedAt: '2026-10-15T09:30:00Z' } };
    expect(LeadSchema.safeParse(lead).success).toBe(false);
  });

  it.each([
    ['unknown state', { state: 'XX' }],
    ['bad zip', { zip: '1234' }],
    ['non-E.164 phone', { contact: { ...makeLead().contact, phone: '555-0123' } }],
    ['amount below minimum', { amountCents: 50 }],
    ['unknown field', { favouriteColour: 'blue' }],
  ])('rejects %s', (_name, patch) => {
    expect(LeadSchema.safeParse({ ...makeLead(), ...patch }).success).toBe(false);
  });
});

describe('payloadHash', () => {
  it('ignores key order', () => {
    const a = makeLead();
    const b = JSON.parse(canonicalJson(a)) as typeof a; // same data, keys re-ordered alphabetically
    expect(Object.keys(b)).not.toEqual(Object.keys(a));
    expect(payloadHash(b)).toBe(payloadHash(a));
  });

  it('changes when any value changes', () => {
    expect(payloadHash(makeLead({ zip: '73302' }))).not.toBe(payloadHash(makeLead()));
  });
});
