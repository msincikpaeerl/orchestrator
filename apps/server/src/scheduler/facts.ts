import { schema } from '@orchestrator/db';
import { RunChangeCause } from '@orchestrator/protocol';
import { and, count, eq, gte, inArray, or, sql } from 'drizzle-orm';
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

/** How a run ended and who started it, as its events say (lot 4 step D2a). */
export interface RunStory {
  /** The cause of its change to `cancelled` or `failed`, when it ended so. */
  endCause: RunChangeCause | null;
  /** Started by the owner (**Run now**, **Start review**), not by the scheduler. */
  byOwner: boolean;
}

/**
 * The stories of these runs, from their `run.created` and ending `run.status_changed` events: the
 * runs keep neither who started them nor what ended them (a dispatch not acknowledged and the
 * owner's **Stop run** both end `cancelled`).
 */
export async function runStories(
  executor: Executor,
  runIds: readonly string[],
): Promise<Map<string, RunStory>> {
  const stories = new Map<string, RunStory>();
  if (runIds.length === 0) return stories;
  const rows = await executor
    .select({
      runId: schema.events.entityId,
      type: schema.events.type,
      actor: schema.events.actor,
      cause: sql<string | null>`${schema.events.payload}->>'cause'`,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityType, 'run'),
        inArray(schema.events.entityId, [...runIds]),
        or(
          eq(schema.events.type, 'run.created'),
          and(
            eq(schema.events.type, 'run.status_changed'),
            sql`${schema.events.payload}->>'to' IN ('cancelled', 'failed')`,
          ),
        ),
      ),
    );
  for (const row of rows) {
    if (row.runId === null) continue;
    const story = stories.get(row.runId) ?? { endCause: null, byOwner: false };
    if (row.type === 'run.created') story.byOwner = row.actor === 'owner';
    else if (row.cause !== null) story.endCause = RunChangeCause.parse(row.cause);
    stories.set(row.runId, story);
  }
  return stories;
}
