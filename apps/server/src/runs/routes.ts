import { schema } from '@orchestrator/db';
import {
  ProjectKey,
  RUN_LOG_PAGE_SIZE,
  RunLogQuery,
  TicketNumber,
  type RunListResponse,
  type RunLogResponse,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
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
    const rows = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.ticketId, ticket.id))
      .orderBy(desc(schema.runs.createdAt));
    return {
      runs: await Promise.all(rows.map((row) => runs.view(row.id))),
    } satisfies RunListResponse;
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
    const entries = rows.slice(0, RUN_LOG_PAGE_SIZE).map((row) => ({
      seq: row.seq,
      at: row.at.toISOString(),
      kind: z.enum(['agent_text', 'tool_call', 'tool_result', 'input', 'warning']).parse(row.kind),
      tool: row.tool,
      text: row.text,
      cut: row.cut,
    }));
    return { entries, more: rows.length > RUN_LOG_PAGE_SIZE } satisfies RunLogResponse;
  });
}
