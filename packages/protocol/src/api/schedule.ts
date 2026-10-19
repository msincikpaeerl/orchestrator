import { z } from 'zod';

// A Claude account's schedule windows and daily budget, and the Orchestrator's time zone they are
// read in (01, section 3.9; 07, sections 5.3 and 5.4; lot 4 step C).

/** Days of a window, Monday first as on screen. */
export const Weekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
export type Weekday = z.infer<typeof Weekday>;

/** Most windows on one account: a week of two windows a day. */
export const SCHEDULE_WINDOWS_MAX = 14;

const time = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A weekly window in which runs may start: on each of `days`, from `start` to `end` (`HH:MM`,
 * `24:00` for midnight at the end of the day). An end not after the start ends the next day.
 */
export const ScheduleWindow = z
  .object({
    days: z
      .array(Weekday)
      .min(1, 'choose at least one day')
      .refine((days) => new Set(days).size === days.length, 'a day is listed twice'),
    start: z.string().regex(time, 'must be a time from 00:00 to 23:59'),
    end: z
      .string()
      .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'must be a time from 00:01 to 24:00'),
  })
  .refine((window) => window.start !== window.end, 'the start and the end must differ');
export type ScheduleWindow = z.infer<typeof ScheduleWindow>;

/** No window means always (07, section 5.3). */
export const Schedule = z
  .array(ScheduleWindow)
  .max(SCHEDULE_WINDOWS_MAX, `at most ${String(SCHEDULE_WINDOWS_MAX)} windows`);
export type Schedule = z.infer<typeof Schedule>;

/** Ranges of a daily budget: working time in minutes, estimated usage in US dollars. */
export const DAILY_BUDGET = {
  minutes: { min: 1, max: 1440 },
  usd: { min: 0.01, max: 10_000 },
} as const;

/** None (null), working time or estimated usage, per day in the Orchestrator's time zone (07, 5.4). */
export const DailyBudget = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('working_time'),
      minutes: z
        .int('must be a whole number of minutes')
        .min(DAILY_BUDGET.minutes.min, 'must be between 1 and 1,440 minutes')
        .max(DAILY_BUDGET.minutes.max, 'must be between 1 and 1,440 minutes'),
    }),
    z.object({
      kind: z.literal('estimated_usage'),
      usd: z
        .number()
        .min(DAILY_BUDGET.usd.min, 'must be between $0.01 and $10,000')
        .max(DAILY_BUDGET.usd.max, 'must be between $0.01 and $10,000')
        .refine((usd) => Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-6, 'use whole cents'),
    }),
  ])
  .nullable();
export type DailyBudget = z.infer<typeof DailyBudget>;

/** Whether `name` is a time zone this runtime knows (an IANA name such as `Europe/Paris`). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneName = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, 'is not a time zone name, such as Europe/Paris');

/**
 * `GET /api/time-zone` (02, section 10): the saved time zone, or UTC with `saved` false while the
 * owner has saved none.
 */
export const TimeZoneResponse = z.object({ timeZone: z.string(), saved: z.boolean() });
export type TimeZoneResponse = z.infer<typeof TimeZoneResponse>;

/** `PUT /api/time-zone`. */
export const SaveTimeZoneRequest = z.object({ timeZone: TimeZoneName });
export type SaveTimeZoneRequest = z.infer<typeof SaveTimeZoneRequest>;
