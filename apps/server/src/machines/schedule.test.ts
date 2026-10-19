import type { ScheduleWindow } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { budgetUsed, dayBounds, windowPosition, zonedInstant } from './schedule.js';

// Windows and days in the Orchestrator's time zone (07, section 5.3; lot 4 step C). Each case
// gives `now` as a UTC instant around the clock change, so no test waits for a real time.

const PARIS = 'Europe/Paris';
const at = (iso: string) => new Date(iso);
const position = (windows: ScheduleWindow[], now: string, timeZone = PARIS) => {
  const found = windowPosition(windows, timeZone, at(now));
  return found.state === 'always'
    ? found
    : found.state === 'inside'
      ? { state: found.state, until: found.until?.toISOString() ?? null }
      : { state: found.state, next: found.next?.toISOString() ?? null };
};

describe('local times in a time zone', () => {
  it('turns a local time into its instant, summer and winter', () => {
    expect(zonedInstant({ year: 2026, month: 1, day: 15 }, 9 * 60, PARIS).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
    expect(zonedInstant({ year: 2026, month: 7, day: 15 }, 9 * 60, PARIS).toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    );
    expect(zonedInstant({ year: 2026, month: 7, day: 15 }, 24 * 60, PARIS).toISOString()).toBe(
      '2026-07-15T22:00:00.000Z',
    );
  });

  it('moves a time the clocks skip forward by the gap, and takes the first of one shown twice', () => {
    // 2026-03-29: 02:00 becomes 03:00 in Paris (01:00 UTC).
    expect(zonedInstant({ year: 2026, month: 3, day: 29 }, 2 * 60, PARIS).toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
    expect(zonedInstant({ year: 2026, month: 3, day: 29 }, 150, PARIS).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    // 2026-10-25: 03:00 becomes 02:00 again; 02:30 is first at 00:30 UTC.
    expect(zonedInstant({ year: 2026, month: 10, day: 25 }, 150, PARIS).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('gives a day of 23 hours and one of 25 at the changes', () => {
    const spring = dayBounds(at('2026-03-29T10:00:00Z'), PARIS);
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    const autumn = dayBounds(at('2026-10-25T10:00:00Z'), PARIS);
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3_600_000);
    // Just before midnight in Paris, it is still the day before.
    expect(dayBounds(at('2026-10-19T21:59:59Z'), PARIS).date).toEqual({
      year: 2026,
      month: 10,
      day: 19,
    });
    expect(dayBounds(at('2026-10-19T22:00:00Z'), PARIS).date.day).toBe(20);
  });
});

describe('schedule windows', () => {
  it('with none, runs may start at any time', () => {
    expect(position([], '2026-10-19T12:00:00Z')).toEqual({ state: 'always' });
  });

  it('reads a window crossing midnight on the day it starts', () => {
    // Monday 22:00 to Tuesday 06:00, Paris (UTC+2 in October).
    const windows: ScheduleWindow[] = [{ days: ['monday'], start: '22:00', end: '06:00' }];
    // Monday 2026-10-19 21:00 in Paris: outside, until 22:00.
    expect(position(windows, '2026-10-19T19:00:00Z')).toEqual({
      state: 'outside',
      next: '2026-10-19T20:00:00.000Z',
    });
    // Tuesday 03:00: inside, until 06:00.
    expect(position(windows, '2026-10-20T01:00:00Z')).toEqual({
      state: 'inside',
      until: '2026-10-20T04:00:00.000Z',
    });
    // Tuesday 07:00: outside until next Monday 22:00.
    expect(position(windows, '2026-10-20T05:00:00Z')).toEqual({
      state: 'outside',
      next: '2026-10-26T21:00:00.000Z',
    });
  });

  it('joins windows that touch, and has no end when they never close', () => {
    const weekdays: ScheduleWindow[] = [
      { days: ['monday', 'tuesday'], start: '00:00', end: '08:00' },
      { days: ['monday'], start: '08:00', end: '12:00' },
    ];
    expect(position(weekdays, '2026-10-19T05:00:00Z')).toEqual({
      state: 'inside',
      until: '2026-10-19T10:00:00.000Z',
    });
    const always: ScheduleWindow[] = [
      {
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        start: '00:00',
        end: '24:00',
      },
    ];
    expect(position(always, '2026-10-19T05:00:00Z')).toEqual({ state: 'inside', until: null });
  });

  it('opens a window from 02:00 at 03:00 on the night the clocks go forward', () => {
    // Sunday 2026-03-29, Paris: 02:00 local does not exist; the window opens at the change.
    const windows: ScheduleWindow[] = [{ days: ['sunday'], start: '02:00', end: '05:00' }];
    // 01:30 local (00:30 UTC): outside, next at 03:00 local (01:00 UTC).
    expect(position(windows, '2026-03-29T00:30:00Z')).toEqual({
      state: 'outside',
      next: '2026-03-29T01:00:00.000Z',
    });
    // 03:30 local (01:30 UTC): inside until 05:00 local (03:00 UTC): two hours, not three.
    expect(position(windows, '2026-03-29T01:30:00Z')).toEqual({
      state: 'inside',
      until: '2026-03-29T03:00:00.000Z',
    });
    // A window of 02:00 to 03:00 that night is skipped whole: the next one is a week later.
    expect(
      position([{ days: ['sunday'], start: '02:00', end: '03:00' }], '2026-03-29T00:30:00Z'),
    ).toEqual({ state: 'outside', next: '2026-04-05T00:00:00.000Z' });
  });

  it('keeps a window open through the hour shown twice when the clocks go back', () => {
    // Sunday 2026-10-25, Paris: 01:00 to 04:00 local lasts four hours.
    const windows: ScheduleWindow[] = [{ days: ['sunday'], start: '01:00', end: '04:00' }];
    expect(position(windows, '2026-10-24T23:30:00Z')).toEqual({
      state: 'inside',
      until: '2026-10-25T03:00:00.000Z',
    });
    // The second 02:30 local (01:30 UTC) is still inside.
    expect(position(windows, '2026-10-25T01:30:00Z')).toEqual({
      state: 'inside',
      until: '2026-10-25T03:00:00.000Z',
    });
  });

  it('reads the windows in the time zone given, UTC included', () => {
    const windows: ScheduleWindow[] = [{ days: ['monday'], start: '09:00', end: '10:00' }];
    expect(position(windows, '2026-10-19T09:30:00Z', 'UTC')).toEqual({
      state: 'inside',
      until: '2026-10-19T10:00:00.000Z',
    });
    expect(position(windows, '2026-10-19T09:30:00Z')).toEqual({
      state: 'outside',
      next: '2026-10-26T08:00:00.000Z',
    });
  });
});

describe('the daily budget', () => {
  const usage = (workingMs: number, estimatedUsageUsd: number) => ({
    runs: 1,
    workingMs,
    estimatedUsageUsd,
    runsWithoutEstimate: 0,
  });

  it('is used once the working time or the estimated usage reaches it, never with none', () => {
    const minutes = { kind: 'working_time', minutes: 30 } as const;
    expect(budgetUsed(minutes, usage(29 * 60_000, 9))).toBe(false);
    expect(budgetUsed(minutes, usage(30 * 60_000, 0))).toBe(true);
    const dollars = { kind: 'estimated_usage', usd: 2.5 } as const;
    expect(budgetUsed(dollars, usage(999 * 60_000, 2.49))).toBe(false);
    expect(budgetUsed(dollars, usage(0, 2.5))).toBe(true);
    expect(budgetUsed(null, usage(999 * 60_000, 999))).toBe(false);
  });
});
