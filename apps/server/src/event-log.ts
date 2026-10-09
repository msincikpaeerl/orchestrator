import { schema } from '@orchestrator/db';
import {
  EVENT_LOG_PAGE_SIZE,
  EventActor,
  EventEntityType,
  EventListQuery,
  EventPayloads,
  EventType,
  maskSecrets,
  shorten,
  type EventListResponse,
  type EventLogEntry,
} from '@orchestrator/protocol';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.js';
import type { Database } from './database.js';
import { HttpError, parseInput } from './http.js';

function maskValue(value: unknown): unknown {
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, maskValue(each)]));
  }
  return value;
}

/**
 * Every string of a parsed value with credentials masked, as the event log shows them: for stored
 * agent text sent to the browser (a submission's report and checks; lot 3 step F4).
 */
export function maskStrings<T>(value: T): T {
  return maskValue(value) as T;
}

/** Only the fields of the type's payload schema, secrets masked; null if it does not match. */
export function visiblePayload(type: EventType, payload: unknown): Record<string, unknown> | null {
  const parsed = EventPayloads[type].safeParse(payload);
  return parsed.success ? (maskValue(parsed.data) as Record<string, unknown>) : null;
}

/** `2026-09-24T10:00:00.123456Z_42`: microseconds, as stored, so no event is skipped or repeated. */
const cursorTime = sql<string>`to_char(${schema.events.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function parseCursor(cursor: string): { time: string; id: number } {
  const separator = cursor.lastIndexOf('_');
  return { time: cursor.slice(0, separator), id: Number(cursor.slice(separator + 1)) };
}

/** Activity > Event log (02, section 7): events newest first, filtered, a page at a time. */
export function registerEventLogRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/api/events', async (request) => {
    await requireSession(db, request);
    const query = parseInput(EventListQuery, request.query);
    const { events, projects, tickets, comments } = schema;
    const conditions: SQL[] = [];

    if (query.project !== undefined) {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, query.project));
      if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
      conditions.push(eq(events.projectId, project.id));
      if (query.ticket !== undefined) {
        const [ticket] = await db
          .select({ id: tickets.id })
          .from(tickets)
          .where(and(eq(tickets.projectId, project.id), eq(tickets.number, query.ticket)));
        if (!ticket) throw new HttpError(404, 'ticket_not_found', 'No ticket with this number');
        conditions.push(eq(events.entityType, 'ticket'), eq(events.entityId, ticket.id));
      }
    }
    if (query.entity !== undefined) conditions.push(eq(events.entityType, query.entity));
    if (query.type !== undefined) conditions.push(eq(events.type, query.type));
    if (query.from !== undefined) conditions.push(gte(events.createdAt, new Date(query.from)));
    if (query.to !== undefined) conditions.push(lt(events.createdAt, new Date(query.to)));
    if (query.before !== undefined) {
      const { time, id } = parseCursor(query.before);
      conditions.push(sql`(${events.createdAt}, ${events.id}) < (${time}::timestamptz, ${id})`);
    }

    const rows = await db
      .select({
        id: events.id,
        at: events.createdAt,
        cursorTime,
        actor: events.actor,
        entityType: events.entityType,
        type: events.type,
        payload: events.payload,
        projectKey: projects.key,
        ticketNumber: tickets.number,
        // Enough to shorten; a comment can be much longer.
        comment: sql<string | null>`left(${comments.body}, 1000)`,
      })
      .from(events)
      .leftJoin(projects, eq(projects.id, events.projectId))
      .leftJoin(
        tickets,
        and(eq(events.entityType, 'ticket'), eq(sql`${tickets.id}::text`, events.entityId)),
      )
      .leftJoin(comments, eq(sql`${comments.id}::text`, sql`${events.payload}->>'commentId'`))
      .where(and(...conditions))
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(EVENT_LOG_PAGE_SIZE + 1);

    const page = rows.slice(0, EVENT_LOG_PAGE_SIZE);
    const last = page.at(-1);
    return {
      events: page.map((row): EventLogEntry => {
        const type = EventType.parse(row.type);
        return {
          id: row.id,
          at: row.at.toISOString(),
          actor: EventActor.parse(row.actor),
          entityType: EventEntityType.parse(row.entityType),
          type,
          project: row.projectKey === null ? null : { key: row.projectKey },
          ticket: row.ticketNumber === null ? null : { number: row.ticketNumber },
          payload: visiblePayload(type, row.payload),
          comment: row.comment === null ? null : shorten(maskSecrets(row.comment)),
        };
      }),
      next:
        rows.length > EVENT_LOG_PAGE_SIZE && last ? `${last.cursorTime}_${String(last.id)}` : null,
    } satisfies EventListResponse;
  });
}
