import {
  Weekday,
  type AccountToday,
  type DailyBudget,
  type Schedule,
  type ScheduleWindow,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { durationText, PAUSED_TEXT } from '../runs/text';

// The words of an account's windows, daily budget and day (02, sections 4 and 9.1; 07, sections
// 5.3 to 5.5; lot 4 step C), shared by Machines, the account page and "Needs you".

export const dayLabel: Record<Weekday, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

function joined(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** "Monday to Friday", "Saturday and Sunday", "every day", "Monday, Wednesday and Friday". */
export function daysText(days: readonly Weekday[]): string {
  const indexes = Weekday.options
    .map((day, index) => (days.includes(day) ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length === 7) return 'every day';
  const first = indexes[0];
  const last = indexes.at(-1);
  if (
    first !== undefined &&
    last !== undefined &&
    indexes.length >= 3 &&
    last - first === indexes.length - 1
  ) {
    return `${dayLabel[Weekday.options[first] ?? 'monday']} to ${dayLabel[Weekday.options[last] ?? 'sunday']}`;
  }
  return joined(indexes.map((index) => dayLabel[Weekday.options[index] ?? 'monday']));
}

/** "Monday to Friday, 22:00 to 06:00 the next day", "Saturday and Sunday, all day". */
export function windowText(window: ScheduleWindow): string {
  const days = daysText(window.days);
  const label = days === 'every day' ? 'Every day' : days;
  if (window.start === '00:00' && window.end === '24:00') return `${label}, all day`;
  const nextDay = window.end !== '24:00' && window.end <= window.start;
  return `${label}, ${window.start} to ${window.end === '24:00' ? 'midnight' : window.end}${nextDay ? ' the next day' : ''}`;
}

/** The windows in one line, or "Any time (no window)". */
export function scheduleText(schedule: Schedule): string {
  return schedule.length === 0 ? 'Any time (no window)' : schedule.map(windowText).join('; ');
}

/** "$1.25"; an amount under a cent shows "under $0.01". */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.005) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

/** "None", "60 min of working time a day", "$5.00 of estimated usage a day". */
export function budgetText(budget: DailyBudget): string {
  if (budget === null) return 'None';
  return budget.kind === 'working_time'
    ? `${durationText(budget.minutes * 60_000)} of working time a day`
    : `${usdText(budget.usd)} of estimated usage a day`;
}

/** Where the account is in its windows now, or null with no window (07, section 5.3). */
export function windowPositionText(window: AccountToday['window']): string | null {
  switch (window.state) {
    case 'always':
      return null;
    case 'inside':
      return window.until === null
        ? 'Inside its windows'
        : `Inside its window until ${formatDateTime(window.until)}`;
    case 'outside':
      return window.next === null
        ? 'Outside its windows'
        : `Outside its windows: the next one opens at ${formatDateTime(window.next)}`;
  }
}

/**
 * "Today: working 45 min of 60 min · estimated usage $1.20 · 3 runs", the budget's kind against
 * its value (07, section 7).
 */
export function todayText(today: AccountToday, budget: DailyBudget): string {
  const { usage } = today;
  const working = `working ${durationText(usage.workingMs)}${budget?.kind === 'working_time' ? ` of ${durationText(budget.minutes * 60_000)}` : ''}`;
  const estimate = `estimated usage ${usdText(usage.estimatedUsageUsd)}${budget?.kind === 'estimated_usage' ? ` of ${usdText(budget.usd)}` : ''}`;
  const runs = `${String(usage.runs)} run${usage.runs === 1 ? '' : 's'}`;
  return `Today: ${working} · ${estimate} · ${runs}`;
}

/** Runs Claude Code gave no estimate for, which count as nothing in the day's estimated usage. */
export function withoutEstimateText(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? '1 run has no estimate from Claude Code yet: it counts as $0.00.'
    : `${String(count)} runs have no estimate from Claude Code yet: they count as $0.00.`;
}

/** The daily budget is used (07, section 5.4). */
export function budgetUsedText(today: AccountToday): string {
  return `Daily budget used: no new run starts by itself on this account until ${formatDateTime(today.dayEndsAt)}. Run now still starts one.`;
}

/** **Stop new runs** in force (07, section 5.5), in the words of Run now's refusal. */
export function pausedText(): string {
  return `Paused: ${PAUSED_TEXT}. Runs already started go on and finish; Run now is refused until you resume the account.`;
}

/**
 * The window and the budget on "Needs you"'s compact line (02, section 4): "next window at …",
 * "in its window until …", "daily budget used until …"; nothing with no window and no budget used.
 */
export function compactDayText(today: AccountToday): string[] {
  const parts: string[] = [];
  if (today.window.state === 'outside') {
    parts.push(
      today.window.next === null
        ? 'outside its windows'
        : `next window at ${formatDateTime(today.window.next)}`,
    );
  }
  if (today.window.state === 'inside' && today.window.until !== null) {
    parts.push(`in its window until ${formatDateTime(today.window.until)}`);
  }
  if (today.budgetUsed) parts.push(`daily budget used until ${formatDateTime(today.dayEndsAt)}`);
  return parts;
}
