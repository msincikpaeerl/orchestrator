import type { AccountToday } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import { runRefusalText, unavailableText } from '../runs/text';
import {
  budgetText,
  budgetUsedText,
  compactDayText,
  daysText,
  pausedText,
  scheduleText,
  todayText,
  usdText,
  windowPositionText,
  windowText,
  withoutEstimateText,
} from './schedule-text';

// The words of an account's windows, budget and day (02, sections 4 and 9.1; lot 4 step C).

const account = { id: '3f1e0e8c-1111-4000-8000-000000000000', label: 'Personal' };
const until = '2026-10-20T04:00:00.000Z';
const dayEndsAt = '2026-10-19T22:00:00.000Z';
const today = (fields: Partial<AccountToday> = {}): AccountToday => ({
  window: { state: 'always' },
  usage: { runs: 3, workingMs: 45 * 60_000, estimatedUsageUsd: 1.2, runsWithoutEstimate: 0 },
  budgetUsed: false,
  dayEndsAt,
  ...fields,
});

describe('schedule windows in words', () => {
  it('names the days as a range, a pair, a list or every day', () => {
    expect(daysText(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])).toBe(
      'Monday to Friday',
    );
    expect(daysText(['sunday', 'saturday'])).toBe('Saturday and Sunday');
    expect(daysText(['monday', 'wednesday', 'friday'])).toBe('Monday, Wednesday and Friday');
    expect(
      daysText(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
    ).toBe('every day');
  });

  it('says when a window ends the next day, at midnight or lasts all day', () => {
    expect(windowText({ days: ['monday'], start: '22:00', end: '06:00' })).toBe(
      'Monday, 22:00 to 06:00 the next day',
    );
    expect(windowText({ days: ['monday'], start: '18:00', end: '24:00' })).toBe(
      'Monday, 18:00 to midnight',
    );
    expect(windowText({ days: ['saturday', 'sunday'], start: '00:00', end: '24:00' })).toBe(
      'Saturday and Sunday, all day',
    );
    expect(scheduleText([])).toBe('Any time (no window)');
  });

  it('says where the account is in its windows', () => {
    expect(windowPositionText({ state: 'always' })).toBeNull();
    expect(windowPositionText({ state: 'inside', until })).toBe(
      `Inside its window until ${formatDateTime(until)}`,
    );
    expect(windowPositionText({ state: 'outside', next: until })).toBe(
      `Outside its windows: the next one opens at ${formatDateTime(until)}`,
    );
  });
});

describe('the daily budget and the day in words', () => {
  it('names the budget of each kind', () => {
    expect(budgetText(null)).toBe('None');
    expect(budgetText({ kind: 'working_time', minutes: 90 })).toBe(
      '1 h 30 min of working time a day',
    );
    expect(budgetText({ kind: 'estimated_usage', usd: 5 })).toBe('$5.00 of estimated usage a day');
    expect(usdText(0.001)).toBe('under $0.01');
    expect(usdText(0)).toBe('$0.00');
  });

  it('gives today against the budget of its kind', () => {
    expect(todayText(today(), null)).toBe('Today: working 45 min · estimated usage $1.20 · 3 runs');
    expect(todayText(today(), { kind: 'working_time', minutes: 60 })).toBe(
      'Today: working 45 min of 1 h · estimated usage $1.20 · 3 runs',
    );
    expect(todayText(today(), { kind: 'estimated_usage', usd: 1 })).toBe(
      'Today: working 45 min · estimated usage $1.20 of $1.00 · 3 runs',
    );
    expect(budgetUsedText(today({ budgetUsed: true }))).toBe(
      `Daily budget used: no new run starts by itself on this account until ${formatDateTime(dayEndsAt)}. Run now still starts one.`,
    );
    expect(withoutEstimateText(0)).toBeNull();
    expect(withoutEstimateText(2)).toBe(
      '2 runs have no estimate from Claude Code yet: they count as $0.00.',
    );
  });

  it('gives "Needs you" the next window, the window\'s end and the budget used', () => {
    expect(compactDayText(today())).toEqual([]);
    expect(compactDayText(today({ window: { state: 'outside', next: until } }))).toEqual([
      `next window at ${formatDateTime(until)}`,
    ]);
    expect(compactDayText(today({ window: { state: 'inside', until }, budgetUsed: true }))).toEqual(
      [
        `in its window until ${formatDateTime(until)}`,
        `daily budget used until ${formatDateTime(dayEndsAt)}`,
      ],
    );
  });
});

describe('Stop new runs in the same words on the screens and in the refusals', () => {
  it('says the owner stopped new runs on the account', () => {
    const words = 'you stopped new runs on it';
    expect(pausedText()).toBe(
      `Paused: ${words}. Runs already started go on and finish; Run now is refused until you resume the account.`,
    );
    expect(runRefusalText({ reason: 'account_paused', account })).toBe(
      `The Claude account Personal is paused: ${words}. Resume the account in Machines first.`,
    );
    expect(unavailableText({ why: 'account_paused', account })).toBe(
      `its Claude account Personal is paused: ${words}`,
    );
  });
});
