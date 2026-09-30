import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  LiveRunsQuery,
  ProjectKey,
  RUN_HISTORY_PAGE_SIZE,
  RUN_LOG_PAGE_SIZE,
  RunHistoryQuery,
  RunLogQuery,
  TicketNumber,
  type LiveRunsResponse,
  type RunHistoryResponse,
  type RunListResponse,
  type RunLogEntry,
  type RunLogResponse,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/routes.js';
import type { Database } from '../database.js';
import { HttpError, parseInput } from '../http.js';
import { runNotFound, type RunService } from './service.js';

interface TicketParams {
  Params: { key: string; number: string };
}
interface RunParams {
  Params: { id: string };
}

const LogKind = z.enum(['agent_text', 'tool_call', 'tool_result', 'input', 'warning']);

function toLogEntry(row: typeof schema.runLogEntries.$inferSelect): RunLogEntry {
  return {
    seq: row.seq,
    at: row.at.toISOString(),
    kind: LogKind.parse(row.kind),
    tool: row.tool,
    text: row.text,
    cut: row.cut,
  };
}

/** `2026-09-24T10:00:00.123456Z`: microseconds, as stored, so no run is skipped or repeated. */
const endedAtText = sql<string>`to_char(${schema.runs.endedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function runId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw runNotFound();
  return value;
}

function ticketAddress(params: TicketParams['Params']): { key: string; number: number } {
  const key = ProjectKey.safeParse(params.key);
  if (!key.success) throw new HttpError(404, 'project_not_found', 'No project with this key');
  const number = /^[1-9]\d{0,9}$/.test(params.number)
    ? TicketNumber.safeParse(Number(params.number))
    : null;
  if (!number?.success) throw new HttpError(404, 'ticket_not_found', 'No ticket with this number');
  return { key: key.data, number: number.data };
}

/**
 * Runs (07, section 3; 04, section 2): **Run now** on a ticket, the ticket's runs, **Stop run**,
 * **Resume**, and a run's log (02, section 7).
 */
export function registerRunRoutes(
  app: FastifyInstance,
  { db, runs }: { db: Database; runs: RunService },
) {
  app.post<TicketParams>('/api/projects/:key/tickets/:number/run', async (request, reply) => {
    await requireSession(db, request);
    const { key, number } = ticketAddress(request.params);
    const run = await runs.runNow(key, number);
    return reply.code(201).send(run);
  });

  app.get<TicketParams>('/api/projects/:key/tickets/:number/runs', async (request) => {
    await requireSession(db, request);
    const { key, number } = ticketAddress(request.params);
    const [ticket] = await db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .where(and(eq(schema.projects.key, key), eq(schema.tickets.number, number)));
    if (!ticket) throw new HttpError(404, 'ticket_not_found', 'No ticket with this number');
    return {
      runs: await runs.list(eq(schema.runs.ticketId, ticket.id), [desc(schema.runs.createdAt)]),
    } satisfies RunListResponse;
  });

  // Activity > Live runs (02, section 7), also one machine's runs (02, section 9.2).
  app.get('/api/runs/live', async (request) => {
    await requireSession(db, request);
    const query = parseInput(LiveRunsQuery, request.query);
    const active = await runs.list(
      and(
        inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
        query.machine === undefined ? undefined : eq(schema.runs.machineId, query.machine),
      ),
      [asc(schema.runs.createdAt)],
    );
    // Each run's latest log entry: its current activity (owner's decision, lot 2 step L2).
    const latest =
      active.length === 0
        ? []
        : await db
            .selectDistinctOn([schema.runLogEntries.runId])
            .from(schema.runLogEntries)
            .where(
              inArray(
                schema.runLogEntries.runId,
                active.map((run) => run.id),
              ),
            )
            .orderBy(schema.runLogEntries.runId, desc(schema.runLogEntries.seq));
    const byRun = new Map(latest.map((row) => [row.runId, toLogEntry(row)]));
    return {
      runs: active.map((run) => ({ ...run, latestLog: byRun.get(run.id) ?? null })),
    } satisfies LiveRunsResponse;
  });

  // Activity > History (02, section 7): ended runs, newest end first, a page at a time.
  app.get('/api/runs/history', async (request) => {
    await requireSession(db, request);
    const query = parseInput(RunHistoryQuery, request.query);
    const conditions: SQL[] = [isNotNull(schema.runs.endedAt)];
    if (query.project !== undefined) {
      conditions.push(
        sql`${schema.runs.projectId} = (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${schema.projects.key} = ${query.project})`,
      );
    }
    if (query.agent !== undefined) {
      conditions.push(
        sql`${schema.runs.profileId} = (SELECT ${schema.agentProfiles.id} FROM ${schema.agentProfiles} WHERE ${schema.agentProfiles.key} = ${query.agent})`,
      );
    }
    if (query.outcome !== undefined) conditions.push(eq(schema.runs.status, query.outcome));
    if (query.from !== undefined) conditions.push(gte(schema.runs.endedAt, new Date(query.from)));
    if (query.to !== undefined) conditions.push(lt(schema.runs.endedAt, new Date(query.to)));
    if (query.before !== undefined) {
      const separator = query.before.lastIndexOf('_');
      const time = query.before.slice(0, separator);
      const id = query.before.slice(separator + 1);
      conditions.push(
        sql`(${schema.runs.endedAt}, ${schema.runs.id}) < (${time}::timestamptz, ${id}::uuid)`,
      );
    }
    const where = and(...conditions);
    const page = await runs.list(
      where,
      [desc(schema.runs.endedAt), desc(schema.runs.id)],
      RUN_HISTORY_PAGE_SIZE + 1,
    );
    const shown = page.slice(0, RUN_HISTORY_PAGE_SIZE);
    const last = shown.at(-1);
    let next: string | null = null;
    if (page.length > RUN_HISTORY_PAGE_SIZE && last) {
      const [row] = await db
        .select({ endedAt: endedAtText })
        .from(schema.runs)
        .where(eq(schema.runs.id, last.id));
      if (row) next = `${row.endedAt}_${last.id}`;
    }
    return { runs: shown, next } satisfies RunHistoryResponse;
  });

  app.get<RunParams>('/api/runs/:id', async (request) => {
    await requireSession(db, request);
    return runs.view(runId(request.params.id));
  });

  app.post<RunParams>('/api/runs/:id/stop', async (request) => {
    await requireSession(db, request);
    return runs.stop(runId(request.params.id));
  });

  app.post<RunParams>('/api/runs/:id/resume', async (request) => {
    await requireSession(db, request);
    return runs.resume(runId(request.params.id));
  });

  app.get<RunParams>('/api/runs/:id/log', async (request) => {
    await requireSession(db, request);
    const id = runId(request.params.id);
    const { after } = parseInput(RunLogQuery, request.query);
    await runs.view(id);
    const rows = await db
      .select()
      .from(schema.runLogEntries)
      .where(and(eq(schema.runLogEntries.runId, id), gt(schema.runLogEntries.seq, after)))
      .orderBy(asc(schema.runLogEntries.seq))
      .limit(RUN_LOG_PAGE_SIZE + 1);
    const entries = rows.slice(0, RUN_LOG_PAGE_SIZE).map(toLogEntry);
    return { entries, more: rows.length > RUN_LOG_PAGE_SIZE } satisfies RunLogResponse;
  });
}
