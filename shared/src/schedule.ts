import { DateTime } from 'luxon';
import { z } from 'zod';

export const SendingWindowSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1), // ISO weekday 1=Mon … 7=Sun
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
});
export type SendingWindow = z.infer<typeof SendingWindowSchema>;

export const DEFAULT_WINDOW: SendingWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  return DateTime.now().setZone(zone).isValid;
}

function parseHm(s: string): { hour: number; minute: number } {
  const [h, m] = s.split(':').map(Number);
  return { hour: h, minute: m };
}

/** True if `at` falls inside the window in `zone`. */
export function isInWindow(at: Date, window: SendingWindow, zone: string): boolean {
  const t = DateTime.fromJSDate(at).setZone(zone);
  if (!window.days.includes(t.weekday)) return false;
  const s = parseHm(window.start);
  const e = parseHm(window.end);
  const mins = t.hour * 60 + t.minute;
  return mins >= s.hour * 60 + s.minute && mins < e.hour * 60 + e.minute;
}

/**
 * Returns the earliest instant >= `from` that is inside the window, evaluated in `zone`.
 * Business-day scheduling falls out of `days` (default Mon–Fri).
 */
export function nextWindowStart(from: Date, window: SendingWindow, zone: string): Date {
  const z = isValidZone(zone) ? zone : 'UTC';
  if (isInWindow(from, window, z)) return from;
  const s = parseHm(window.start);
  const e = parseHm(window.end);
  let day = DateTime.fromJSDate(from).setZone(z);
  for (let i = 0; i < 15; i++) {
    const startOfWindow = day.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 });
    const endOfWindow = day.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
    if (window.days.includes(day.weekday)) {
      if (DateTime.fromJSDate(from) < startOfWindow) return startOfWindow.toJSDate();
      if (DateTime.fromJSDate(from) < endOfWindow) return from;
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  throw new Error('Sending window has no valid days');
}

/** When should the next step go out, given the last send time and the step delay in days? */
export function computeNextStepAt(lastSentAt: Date, delayDays: number, window: SendingWindow, zone: string): Date {
  const due = DateTime.fromJSDate(lastSentAt).plus({ days: delayDays }).toJSDate();
  return nextWindowStart(due, window, zone);
}

/** Start of "today" for daily-limit counting in a given zone. */
export function startOfDayIn(zone: string, now: Date = new Date()): Date {
  return DateTime.fromJSDate(now).setZone(isValidZone(zone) ? zone : 'UTC').startOf('day').toJSDate();
}
