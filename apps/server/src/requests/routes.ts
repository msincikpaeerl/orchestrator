import { schema } from '@orchestrator/db';
import {
  AddCommentRequest,
  CreateRequestRequest,
  ProjectKey,
  RequestNumber,
  RequestStatus,
  requestLine,
  type LimitExceeded,
  type RequestDetail,
  type RequestListResponse,
  type RequestProject,
  type RequestSummary,
} from '@orchestrator/protocol';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput } from '../http.js';
import { resolveSettings } from '../settings/store.js';
import { profileLinks, toComment } from '../tickets/model.js';

export interface RequestRoutesOptions {
  db: Database;
  now?: () => Date;
}

type RequestRow = typeof schema.requests.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const requestNotFound = () =>
  new HttpError(404, 'request_not_found', 'No request with this number');

/** A request number from an address: digits only, as in `/requests/7`. */
function parseNumber(value: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(value)) return null;
  const parsed = RequestNumber.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

/** A text over its limit, named as the form names it (04, section 8). */
function limitRefusal(field: 'body', exceeded: LimitExceeded): HttpError {
  return new HttpError(
    400,
    'invalid_request',
    `${field}: at most ${String(exceeded.max)} characters`,
    {
      limits: [exceeded],
    },
  );
}

/** Entity and project of the events about a request (01, section 3.10). */
function requestEntity(row: RequestRow) {
  return { entityType: 'request', entityId: row.id, projectId: row.projectId } as const;
}

/**
 * Requests (02, section 5; lot 5 step D1): the owner submits one, for a project or for a new
 * project, and adds notes to it. Nothing starts yet: a planning run is step E2's. Requests are
 * numbered by one sequence, decided one creation at a time under the table's lock.
 */
export function registerRequestRoutes(app: FastifyInstance, options: RequestRoutesOptions) {
  const { db } = options;
  const now = () => options.now?.() ?? new Date();

  async function projectsById(executor: Executor): Promise<Map<string, RequestProject>> {
    const rows = await executor
      .select({ id: schema.projects.id, key: schema.projects.key, name: schema.projects.name })
      .from(schema.projects);
    return new Map(rows.map((row) => [row.id, { key: row.key, name: row.name }]));
  }

  function summary(row: RequestRow, projects: ReadonlyMap<string, RequestProject>): RequestSummary {
    return {
      number: row.number,
      line: requestLine(row.body),
      status: RequestStatus.parse(row.status),
      project: row.projectId === null ? null : (projects.get(row.projectId) ?? null),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function detail(executor: Executor, row: RequestRow): Promise<RequestDetail> {
    const comments = await executor
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.requestId, row.id))
      .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id));
    const profiles = await profileLinks(executor);
    return {
      ...summary(row, await projectsById(executor)),
      body: row.body,
      comments: comments.map((comment) => toComment(comment, profiles)),
    };
  }

  async function findRequest(executor: Executor, number: string, lock = false) {
    const parsed = parseNumber(number);
    if (parsed === null) throw requestNotFound();
    const query = executor.select().from(schema.requests).where(eq(schema.requests.number, parsed));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw requestNotFound();
    return row;
  }

  /** The project's key as events give it, or null for a new project. */
  async function projectKey(tx: Transaction, row: RequestRow): Promise<string | null> {
    if (row.projectId === null) return null;
    const [project] = await tx
      .select({ key: schema.projects.key })
      .from(schema.projects)
      .where(eq(schema.projects.id, row.projectId));
    return project?.key ?? null;
  }

  app.get('/api/requests', async (request) => {
    await requireSession(db, request);
    const rows = await db.select().from(schema.requests).orderBy(desc(schema.requests.number));
    const projects = await projectsById(db);
    return { requests: rows.map((row) => summary(row, projects)) } satisfies RequestListResponse;
  });

  app.post('/api/requests', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(CreateRequestRequest, request.body);
    // Owner's answer 7, lot 5 step D: the limit of a ticket's description, no setting of its own.
    const { ticketDescriptionMaxLength: max } = await resolveSettings(db, [
      'ticketDescriptionMaxLength',
    ]);
    if (input.body.length > max) {
      throw limitRefusal('body', { field: 'request', max, unit: 'characters' });
    }
    const created = await db.transaction(async (tx) => {
      let project: typeof schema.projects.$inferSelect | undefined;
      if (input.project !== null) {
        const key = ProjectKey.parse(input.project);
        [project] = await tx
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.key, key))
          .for('no key update');
        if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
        // Any setup state: a planning run waits for the project to be ready (answer 9).
        if (project.status === 'archived') {
          throw new HttpError(
            409,
            'project_archived',
            'This project is archived and read-only: unarchive it first',
          );
        }
      }
      // One creation at a time, so the numbers follow each other with no gap.
      await tx.execute(sql`LOCK TABLE ${schema.requests} IN SHARE ROW EXCLUSIVE MODE`);
      const [last] = await tx
        .select({
          number: sql<number>`coalesce(max(${schema.requests.number}), 0)`.mapWith(Number),
        })
        .from(schema.requests);
      const at = now();
      const [row] = await tx
        .insert(schema.requests)
        .values({
          number: (last?.number ?? 0) + 1,
          projectId: project?.id ?? null,
          body: input.body,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error('request not inserted');
      await recordEvent(tx, {
        actor: 'owner',
        ...requestEntity(row),
        type: 'request.created',
        payload: {
          request: row.number,
          project: project?.key ?? null,
          line: requestLine(row.body),
        },
        at,
      });
      return detail(tx, row);
    });
    request.log.info({ request: created.number, project: created.project?.key }, 'request created');
    return reply.code(201).send(created);
  });

  app.get<{ Params: { number: string } }>('/api/requests/:number', async (request) => {
    await requireSession(db, request);
    return detail(db, await findRequest(db, request.params.number));
  });

  // The owner's note on a request, whatever its status (owner's answer 10, lot 5 step D).
  app.post<{ Params: { number: string } }>(
    '/api/requests/:number/comments',
    async (request, reply) => {
      await requireSession(db, request);
      const input = parseInput(AddCommentRequest, request.body);
      const { commentMaxLength: max } = await resolveSettings(db, ['commentMaxLength']);
      if (input.body.length > max) {
        throw limitRefusal('body', { field: 'comment', max, unit: 'characters' });
      }
      const result = await db.transaction(async (tx) => {
        const row = await findRequest(tx, request.params.number, true);
        const at = now();
        const [comment] = await tx
          .insert(schema.comments)
          .values({
            requestId: row.id,
            author: 'owner',
            kind: 'note',
            body: input.body,
            createdAt: at,
          })
          .returning({ id: schema.comments.id });
        if (!comment) throw new Error('comment not inserted');
        const [updated] = await tx
          .update(schema.requests)
          .set({ updatedAt: at })
          .where(eq(schema.requests.id, row.id))
          .returning();
        if (!updated) throw new Error('request disappeared');
        await recordEvent(tx, {
          actor: 'owner',
          ...requestEntity(updated),
          type: 'request.commented',
          payload: {
            request: updated.number,
            project: await projectKey(tx, updated),
            commentId: comment.id,
            kind: 'note',
          },
          at,
        });
        return detail(tx, updated);
      });
      return reply.code(201).send(result);
    },
  );
}
