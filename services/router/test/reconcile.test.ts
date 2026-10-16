import { describe, expect, it } from 'vitest';
import { currentWindows, leakedSlots } from '../src/reconcile.ts';

describe('leakedSlots', () => {
  it('releases only what sales and in-flight leads cannot explain', () => {
    expect(leakedSlots(10, 7, 1)).toBe(2);
  });

  it('never goes negative, so a repair can only decrease usage', () => {
    expect(leakedSlots(5, 6, 0)).toBe(0); // a sale counted in the next window at a boundary
    expect(leakedSlots(3, 0, 5)).toBe(0); // plenty in flight: nothing provably leaked
  });
});

describe('currentWindows', () => {
  it('returns the UTC hour and day containing now, with exclusive ends', () => {
    const [hour, day] = currentWindows(new Date('2026-10-16T13:45:10Z'));

    expect(hour).toEqual({ kind: 'hour', start: new Date('2026-10-16T13:00:00Z'), end: new Date('2026-10-16T14:00:00Z') });
    expect(day).toEqual({ kind: 'day', start: new Date('2026-10-16T00:00:00Z'), end: new Date('2026-10-17T00:00:00Z') });
  });
});
