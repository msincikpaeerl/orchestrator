import { schema } from '@orchestrator/db';
import { and, count, gte, inArray } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { dayBounds } from '../machines/schedule.js';
import { readTimeZone } from '../settings/time-zone.js';

/**
 * The runs each machine started today, in the Orchestrator's time zone (07, sections 4 and 5.3),
 * for "the fewest runs today".
 */
export async function runsToday(
  executor: Executor,
  machineIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  if (machineIds.length === 0) return new Map();
  const { timeZone } = await readTimeZone(executor);
  const rows = await executor
    .select({ machineId: schema.runs.machineId, runs: count() })
    .from(schema.runs)
    .where(
      and(
        inArray(schema.runs.machineId, [...machineIds]),
        gte(schema.runs.createdAt, dayBounds(now, timeZone).start),
      ),
    )
    .groupBy(schema.runs.machineId);
  return new Map(rows.map((row) => [row.machineId, row.runs]));
}
