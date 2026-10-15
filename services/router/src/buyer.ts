import { z } from 'zod';
import { CREDIT_BANDS, PRODUCTS, US_STATES } from '@lre/shared';

export const BuyerCriteriaSchema = z
  .strictObject({
    products: z.array(z.enum(PRODUCTS)).min(1).optional(),
    states: z.array(z.enum(US_STATES)).min(1).optional(),
    creditBands: z.array(z.enum(CREDIT_BANDS)).min(1).optional(),
    minAmountCents: z.int().nonnegative().optional(),
    maxAmountCents: z.int().positive().optional(),
  })
  .refine((c) => c.minAmountCents === undefined || c.maxAmountCents === undefined || c.minAmountCents <= c.maxAmountCents, {
    message: 'minAmountCents must not exceed maxAmountCents',
  });

/** Open on the given ISO weekdays (1 = Monday) from startHour (inclusive) to endHour (exclusive), buyer-local. */
export const ScheduleSchema = z
  .strictObject({
    days: z.array(z.int().min(1).max(7)).min(1),
    startHour: z.int().min(0).max(23),
    endHour: z.int().min(1).max(24),
  })
  .refine((s) => s.startHour < s.endHour, { message: 'startHour must be before endHour' });

export type BuyerCriteria = z.infer<typeof BuyerCriteriaSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;

export interface Buyer {
  id: string;
  name: string;
  priceCents: number;
  weight: number;
  criteria: BuyerCriteria;
  schedule: Schedule | null;
  timezone: string;
  hourlyCap: number | null;
  dailyCap: number | null;
  endpointUrl: string | null;
  pingTimeoutMs: number;
  postTimeoutMs: number;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
