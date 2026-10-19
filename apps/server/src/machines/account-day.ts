import { schema } from '@orchestrator/db';
import { DailyBudget, Schedule, type AccountToday, type DayUsage } from '@orchestrator/protocol';
import { and, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { statusTimes } from '../runs/model.js';
import type { AccountRow } from './model.js';
import {
  addDays,
  budgetUsed,
  dateText,
  dayBounds,
  windowPosition,
  zonedInstant,
} from './schedule.js';

// An account's day (07, sections 5.3, 5.4 and 7; lot 4 step C): where now is in its windows, and
// what it used today against its daily budget, in the Orchestrator's time zone. Each run counts
// whole on the day it started: a run in progress with its working time up to now and the latest
// estimate its machine sent; one started before midnight stays on the day before.

const empty = (): DayUsage => ({
  runs: 0,
  workingMs: 0,
  estimatedUsageUsd: 0,
  runsWithoutEstimate: 0,
});

/**
 * The use of each account on each of the `days` days up to today (`YYYY-MM-DD` keys, today
 * included), from the runs started on them.
 */
export async function accountUsage(
  db: Executor,
  accountIds: readonly string[],
  timeZone: string,
  now: Date,
  days = 1,
): Promise<Map<string, Map<string, DayUsage>>> {
  const today = dayBounds(now, timeZone);
  const from = zonedInstant(addDays(today.date, 1 - days), 0, timeZone);
  const usage = new Map<string, Map<string, DayUsage>>(
    accountIds.map((id) => [id, new Map<string, DayUsage>()]),
  );
  if (accountIds.length === 0) return usage;
  const rows = await db
    .select({
      accountId: schema.runs.accountId,
      startedAt: schema.runs.startedAt,
      status: schema.runs.status,
      statusSince: schema.runs.statusSince,
      workingMs: schema.runs.workingMs,
      waitingMs: schema.runs.waitingMs,
      ciWaitingSince: schema.runs.ciWaitingSince,
      estimatedUsageUsd: schema.runs.estimatedUsageUsd,
    })
    .from(schema.runs)
    .where(
      and(
        inArray(schema.runs.accountId, [...accountIds]),
        isNotNull(schema.runs.startedAt),
        gte(schema.runs.startedAt, from),
        lt(schema.runs.startedAt, today.end),
      ),
    );
  for (const row of rows) {
    if (!row.startedAt) continue;
    const date = dateText(dayBounds(row.startedAt, timeZone).date);
    const byDay = usage.get(row.accountId);
    if (!byDay) continue;
    const day = byDay.get(date) ?? empty();
    day.runs += 1;
    day.workingMs += statusTimes(row, now).workingMs;
    if (row.estimatedUsageUsd === null) day.runsWithoutEstimate += 1;
    else day.estimatedUsageUsd += row.estimatedUsageUsd;
    byDay.set(date, day);
  }
  return usage;
}

/** The account's day so far, from its use today (`accountUsage`). */
export function accountToday(
  account: Pick<AccountRow, 'schedule' | 'dailyBudget'>,
  usage: DayUsage | undefined,
  timeZone: string,
  now: Date,
): AccountToday {
  const today = usage ?? empty();
  const position = windowPosition(Schedule.parse(account.schedule), timeZone, now);
  return {
    window:
      position.state === 'always'
        ? position
        : position.state === 'inside'
          ? { state: 'inside', until: position.until?.toISOString() ?? null }
          : { state: 'outside', next: position.next?.toISOString() ?? null },
    usage: { ...today, estimatedUsageUsd: Math.round(today.estimatedUsageUsd * 10_000) / 10_000 },
    budgetUsed: budgetUsed(DailyBudget.parse(account.dailyBudget), today),
    dayEndsAt: dayBounds(now, timeZone).end.toISOString(),
  };
}

/** Today's key in `accountUsage`'s maps. */
export function todayKey(timeZone: string, now: Date): string {
  return dateText(dayBounds(now, timeZone).date);
}
