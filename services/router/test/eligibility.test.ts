import { describe, expect, it } from 'vitest';
import { ineligibilityReason } from '../src/eligibility.ts';
import { isOpen, localWeekdayHour } from '../src/schedule.ts';
import { makeBuyer, makeRoutableLead } from './fakes.ts';

const thursday3pmUtc = new Date('2026-10-15T15:00:00Z');

describe('ineligibilityReason', () => {
  const lead = makeRoutableLead();

  it('accepts a buyer without filters', () => {
    expect(ineligibilityReason(makeBuyer(), lead, thursday3pmUtc)).toBeNull();
  });

  it.each([
    ['product', { products: ['auto_insurance' as const] }],
    ['state', { states: ['CA' as const, 'NY' as const] }],
    ['credit_band', { creditBands: ['excellent' as const] }],
    ['amount_range', { minAmountCents: 2_000_000 }],
    ['amount_range', { maxAmountCents: 1_000_000 }],
  ])('rejects on %s', (reason, criteria) => {
    expect(ineligibilityReason(makeBuyer({ criteria }), lead, thursday3pmUtc)).toBe(reason);
  });

  it('treats range bounds as inclusive', () => {
    const buyer = makeBuyer({ criteria: { minAmountCents: 1_500_000, maxAmountCents: 1_500_000 } });
    expect(ineligibilityReason(buyer, lead, thursday3pmUtc)).toBeNull();
  });

  it('does not sell amount-less leads to buyers that filter on amount', () => {
    const insurance = makeRoutableLead({ product: 'auto_insurance', amountCents: null });
    expect(ineligibilityReason(makeBuyer({ criteria: { minAmountCents: 0 } }), insurance, thursday3pmUtc)).toBe(
      'amount_missing',
    );
  });

  it('rejects outside the buyer schedule', () => {
    const buyer = makeBuyer({
      schedule: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 },
      timezone: 'America/Los_Angeles',
    });
    // 15:00 UTC = 08:00 in Los Angeles (PDT): one hour before opening.
    expect(ineligibilityReason(buyer, lead, thursday3pmUtc)).toBe('outside_schedule');
    expect(ineligibilityReason(buyer, lead, new Date('2026-10-15T16:00:00Z'))).toBeNull();
  });
});

describe('schedule', () => {
  it('converts to the buyer time zone including the day boundary', () => {
    // 02:30 UTC Friday is still Thursday 22:30 in New York (EDT).
    expect(localWeekdayHour(new Date('2026-10-16T02:30:00Z'), 'America/New_York')).toEqual({ weekday: 4, hour: 22 });
  });

  it('follows daylight saving time', () => {
    // New York switches from EDT (UTC-4) to EST (UTC-5) on 1 Nov 2026.
    expect(localWeekdayHour(new Date('2026-10-31T13:00:00Z'), 'America/New_York').hour).toBe(9);
    expect(localWeekdayHour(new Date('2026-11-02T13:00:00Z'), 'America/New_York').hour).toBe(8);
  });

  it('is closed on excluded days and at endHour (exclusive)', () => {
    const weekdays9to17 = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
    expect(isOpen(weekdays9to17, 'UTC', new Date('2026-10-17T12:00:00Z'))).toBe(false); // Saturday
    expect(isOpen(weekdays9to17, 'UTC', new Date('2026-10-15T16:59:59Z'))).toBe(true);
    expect(isOpen(weekdays9to17, 'UTC', new Date('2026-10-15T17:00:00Z'))).toBe(false);
    expect(isOpen(null, 'UTC', new Date('2026-10-17T03:00:00Z'))).toBe(true);
  });
});
