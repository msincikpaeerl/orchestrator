import type { DailyBudget, ScheduleWindow, Weekday } from '@orchestrator/protocol';

// Wall-clock time in the Orchestrator's time zone (07, section 5.3; owner's answer 6, lot 4
// step A): the account's windows, the budget's day and "runs today" are read in it, daylight
// saving changes included. Built on `Intl`, so on the time zone data of Node.js's ICU.

/** A calendar date in the time zone. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** The wall-clock time at `at` in `timeZone`, as if it were UTC, in milliseconds. */
function wallClock(at: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = parts;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** The time zone's offset from UTC at `at`, in milliseconds (whole seconds). */
function offset(at: number, timeZone: string): number {
  return wallClock(at - (at % 1000), timeZone) - (at - (at % 1000));
}

/** Whether `timeZone` is a name `Intl` knows. */
export function knownTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The date at `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): LocalDate {
  const wall = new Date(wallClock(at.getTime(), timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** `YYYY-MM-DD`. */
export function dateText(date: LocalDate): string {
  return `${String(date.year)}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function weekday(date: LocalDate): Weekday {
  const day = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
  if (!day) throw new Error('no weekday');
  return day;
}

/**
 * The instant at `minutes` after midnight of `date` in `timeZone` (1,440 is the next midnight).
 * A time the clocks skip (spring forward) is moved forward by the gap, so 02:00 on that night
 * is 03:00; a time they show twice (fall back) is its first occurrence.
 */
export function zonedInstant(date: LocalDate, minutes: number, timeZone: string): Date {
  const wanted = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const before = offset(wanted - 86_400_000, timeZone);
  const after = offset(wanted + 86_400_000, timeZone);
  const shown = [wanted - before, wanted - after].filter(
    (at) => wallClock(at, timeZone) === wanted,
  );
  // In the gap of a spring forward, the offset before the change moves the time forward.
  return new Date(shown.length === 0 ? wanted - before : Math.min(...shown));
}

/** The day of `at` in `timeZone`: its first instant and the next day's (23 or 25 hours apart on a change). */
export function dayBounds(at: Date, timeZone: string): { date: LocalDate; start: Date; end: Date } {
  const date = localDate(at, timeZone);
  return {
    date,
    start: zonedInstant(date, 0, timeZone),
    end: zonedInstant(addDays(date, 1), 0, timeZone),
  };
}

/** `HH:MM` (or `24:00`) as minutes after midnight. */
export function clockMinutes(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Where `now` is in the account's windows (07, section 5.3). */
export type WindowPosition =
  | { state: 'always' }
  /** `until` is null when the windows never close (every day all day). */
  | { state: 'inside'; until: Date | null }
  | { state: 'outside'; next: Date | null };

/** The days a window list is looked at around now: from yesterday, for a window crossing midnight. */
const HORIZON_DAYS = 8;

/**
 * Where `now` is in `windows`: none means always. A window belongs to the days it starts on; one
 * whose end is not after its start ends the next day. Windows that touch or overlap count as
 * one, so "inside until" is when runs can no longer start.
 */
export function windowPosition(
  windows: readonly ScheduleWindow[],
  timeZone: string,
  now: Date,
): WindowPosition {
  if (windows.length === 0) return { state: 'always' };
  const today = localDate(now, timeZone);
  const horizon = zonedInstant(addDays(today, HORIZON_DAYS), 0, timeZone).getTime();
  const intervals: { start: number; end: number }[] = [];
  for (let offsetDays = -1; offsetDays < HORIZON_DAYS; offsetDays += 1) {
    const date = addDays(today, offsetDays);
    const day = weekday(date);
    for (const window of windows) {
      if (!window.days.includes(day)) continue;
      const startMinutes = clockMinutes(window.start);
      const endMinutes = clockMinutes(window.end);
      const start = zonedInstant(date, startMinutes, timeZone).getTime();
      const end = zonedInstant(
        endMinutes > startMinutes ? date : addDays(date, 1),
        endMinutes,
        timeZone,
      ).getTime();
      // A window the clocks skip whole (02:00 to 03:00 on a spring forward) is empty.
      if (end > start) intervals.push({ start, end: Math.min(end, horizon) });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  const at = now.getTime();
  const inside = merged.find((interval) => interval.start <= at && at < interval.end);
  if (inside) {
    return { state: 'inside', until: inside.end >= horizon ? null : new Date(inside.end) };
  }
  const next = merged.find((interval) => interval.start > at);
  return { state: 'outside', next: next ? new Date(next.start) : null };
}

/** What the account used on one day: runs started that day, in progress included. */
export interface DayUsage {
  runs: number;
  workingMs: number;
  estimatedUsageUsd: number;
  /** Runs for which Claude Code gave no estimate yet: counted as nothing in `estimatedUsageUsd`. */
  runsWithoutEstimate: number;
}

/** Whether the day's use reached the daily budget (07, section 5.4); never with no budget. */
export function budgetUsed(budget: DailyBudget, usage: DayUsage): boolean {
  if (budget === null) return false;
  return budget.kind === 'working_time'
    ? usage.workingMs >= budget.minutes * 60_000
    : usage.estimatedUsageUsd >= budget.usd;
}
