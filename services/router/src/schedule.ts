import type { Schedule } from './buyer.ts';

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** ISO weekday (1 = Monday) and hour (0-23) of `instant` in `timeZone`, DST-aware via Intl. */
export function localWeekdayHour(instant: Date, timeZone: string): { weekday: number; hour: number } {
  let weekday = 0;
  let hour = 0;
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type === 'weekday') weekday = WEEKDAYS[part.value] ?? 0;
    if (part.type === 'hour') hour = Number(part.value);
  }
  return { weekday, hour };
}

export function isOpen(schedule: Schedule | null, timeZone: string, instant: Date): boolean {
  if (!schedule) return true;
  const { weekday, hour } = localWeekdayHour(instant, timeZone);
  return schedule.days.includes(weekday) && hour >= schedule.startHour && hour < schedule.endHour;
}
