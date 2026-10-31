import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  AddCommentRequest,
  AnswerRequest,
  CreateRequestRequest,
  PlanActionRequest,
  ProjectKey,
  RejectPlanRequest,
  RequestNumber,
  RequestStatus,
  RunStatus,
  UpdatePlanTicketRequest,
  requestLine,
  type LimitExceeded,
  type RequestDetail,
  type RequestListResponse,
  type RequestProject,
  type RequestSummary,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput } from '../http.js';
import { resolveSettings } from '../settings/store.js';
import { profileLinks, toComment } from '../tickets/model.js';
import type { RunService } from '../runs/service.js';
import type { ProjectRow } from '../projects/model.js';
import { changeRequestStatus, requestEntity, requestProjectKey, type RequestRow } from './model.js';
import {
  approvePlan,
  editPlanTicket,
  planViews,
  proposedPlan,
  rejectForClosing,
  rejectPlan,
  removePlanTicket,
  requestClosed,
} from './plan-review.js';
import { requestStop } from './planning-end.js';

export interface RequestRoutesOptions {
  db: Database;
  /**
   * Delivers the owner's answer to a planning run's question (lot 5 step D2a), and stops the
   * planning run of a request the owner closes (step F).
   */
  runs: Pick<RunService, 'answerRequest' | 'endForRequest'>;
  now?: () => Date;
}

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
    const [run] = await executor
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.requestId, row.id),
          inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    return {
      ...summary(row, await projectsById(executor)),
      body: row.body,
      comments: comments.map((comment) => toComment(comment, profiles)),
      run: run ? { id: run.id, status: RunStatus.parse(run.status) } : null,
      attemptCount: row.attemptCount,
      stopped: requestStop(row),
      ...(await planViews(executor, row)),
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
            project: await requestProjectKey(tx, updated),
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

  // **Try again** on a stopped request (owner's answers 3, 6 and 7, lot 5 step E2): the stop
  // cleared, its failed attempts counted from 0 and its machines no longer left out. It starts no
  // session: the scheduler plans it again when it can.
  app.post<{ Params: { number: string } }>('/api/requests/:number/try-again', async (request) => {
    await requireSession(db, request);
    const result = await db.transaction(async (tx) => {
      const found = await findRequest(tx, request.params.number);
      // The project's row lock first, then the request's (the run service's order).
      if (found.projectId !== null) {
        const [project] = await tx
          .select({ status: schema.projects.status })
          .from(schema.projects)
          .where(eq(schema.projects.id, found.projectId))
          .for('no key update');
        if (project?.status === 'archived') {
          throw new HttpError(
            409,
            'project_archived',
            'This project is archived and read-only: unarchive it first',
          );
        }
      }
      const row = await findRequest(tx, request.params.number, true);
      const stop = requestStop(row);
      if (stop === null || row.status === 'closed') {
        throw new HttpError(
          409,
          'request_not_stopped',
          'This request is not stopped: the Project Manager can plan it',
        );
      }
      const at = now();
      const why =
        stop.cause === 'failed_attempts'
          ? `${String(stop.count)} failed planning attempt${stop.count === 1 ? '' : 's'} (Failed attempts before asking you: ${String(stop.limit)})`
          : 'the owner stopped its planning run';
      const [comment] = await tx
        .insert(schema.comments)
        .values({
          requestId: row.id,
          author: 'owner',
          kind: 'status_change',
          body: `The owner used Try again: the request was stopped after ${why}. Its failed attempts count from 0 again.`,
          createdAt: at,
        })
        .returning({ id: schema.comments.id });
      if (!comment) throw new Error('comment not inserted');
      const [updated] = await tx
        .update(schema.requests)
        .set({ stopped: null, attemptCount: 0, machineFailures: [], updatedAt: at })
        .where(eq(schema.requests.id, row.id))
        .returning();
      if (!updated) throw new Error('request disappeared');
      await recordEvent(tx, {
        actor: 'owner',
        ...requestEntity(updated),
        type: 'request.tried_again',
        payload: {
          request: updated.number,
          project: await requestProjectKey(tx, updated),
          cause: stop.cause,
          commentId: comment.id,
        },
        at,
      });
      return detail(tx, updated);
    });
    request.log.info({ request: result.number }, 'stopped request tried again by the owner');
    return result;
  });

  /**
   * The request locked for a change by the owner (lot 5 step F): its project's row first, as the
   * run service and the scheduler take them, then the request's.
   */
  async function lockRequest(
    tx: Executor,
    number: string,
  ): Promise<{ row: RequestRow; project: ProjectRow | null }> {
    const found = await findRequest(tx, number);
    let project: ProjectRow | null = null;
    if (found.projectId !== null) {
      [project = null] = await tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, found.projectId))
        .for('no key update');
    }
    return { row: await findRequest(tx, number, true), project };
  }

  type PlanParams = { Params: { number: string; key: string } };

  // The owner's edit of a ticket of the proposed plan (owner's answers 5, 6, 8 and 14, lot 5
  // step F): checked at once, refused for the problems it brings.
  app.patch<PlanParams>('/api/requests/:number/plan/tickets/:key', async (request) => {
    await requireSession(db, request);
    const input = parseInput(UpdatePlanTicketRequest, request.body);
    return db.transaction(async (tx) => {
      const { row, project } = await lockRequest(tx, request.params.number);
      const plan = await proposedPlan(tx, row, input.planId);
      await editPlanTicket(tx, {
        request: row,
        project,
        plan,
        key: request.params.key,
        edit: input,
        at: now(),
      });
      return detail(tx, row);
    });
  });

  // **Remove** a ticket from the proposed plan (owner's answer 7).
  app.post<PlanParams>('/api/requests/:number/plan/tickets/:key/remove', async (request) => {
    await requireSession(db, request);
    const input = parseInput(PlanActionRequest, request.body);
    return db.transaction(async (tx) => {
      const { row, project } = await lockRequest(tx, request.params.number);
      const plan = await proposedPlan(tx, row, input.planId);
      await removePlanTicket(tx, {
        request: row,
        project,
        plan,
        key: request.params.key,
        at: now(),
      });
      return detail(tx, row);
    });
  });

  // **Approve** (owner's answers 4, 9 and 10): the plan checked again, its tickets created in the
  // project in `todo`, the request closed. The scheduler starts them by itself.
  app.post<{ Params: { number: string } }>(
    '/api/requests/:number/plan/approve',
    async (request) => {
      await requireSession(db, request);
      const input = parseInput(PlanActionRequest, request.body);
      const result = await db.transaction(async (tx) => {
        const { row, project } = await lockRequest(tx, request.params.number);
        const plan = await proposedPlan(tx, row, input.planId);
        const created = await approvePlan(tx, { request: row, project, plan, at: now() });
        return { detail: await detail(tx, await findRequest(tx, request.params.number)), created };
      });
      request.log.info(
        {
          request: result.detail.number,
          project: result.detail.project?.key,
          tickets: result.created.length,
        },
        'plan approved by the owner',
      );
      return result.detail;
    },
  );

  // **Reject with feedback** (owner's answers 2 and 11): the plan superseded, the request open,
  // planned again by the scheduler. Allowed on an archived project's request.
  app.post<{ Params: { number: string } }>('/api/requests/:number/plan/reject', async (request) => {
    await requireSession(db, request);
    const input = parseInput(RejectPlanRequest, request.body);
    const { commentMaxLength: max } = await resolveSettings(db, ['commentMaxLength']);
    if (input.feedback.length > max) {
      throw new HttpError(400, 'invalid_request', `feedback: at most ${String(max)} characters`, {
        limits: [{ field: 'comment', max, unit: 'characters' }],
      });
    }
    const result = await db.transaction(async (tx) => {
      const { row, project } = await lockRequest(tx, request.params.number);
      const plan = await proposedPlan(tx, row, input.planId);
      await rejectPlan(tx, { request: row, project, plan, feedback: input.feedback, at: now() });
      return detail(tx, await findRequest(tx, request.params.number));
    });
    request.log.info({ request: result.number }, 'plan rejected with feedback by the owner');
    return result;
  });

  // **Close request** (owner's answer 3, lot 5 step F): at any status but closed. Its planning run
  // is stopped (not counted, no stop), a proposed plan rejected, a stop cleared; final.
  app.post<{ Params: { number: string } }>('/api/requests/:number/close', async (request) => {
    await requireSession(db, request);
    const result = await db.transaction(async (tx) => {
      const { row, project } = await lockRequest(tx, request.params.number);
      if (row.status === 'closed') throw requestClosed();
      const at = now();
      const [cleared] = await tx
        .update(schema.requests)
        .set({ stopped: null, updatedAt: at })
        .where(eq(schema.requests.id, row.id))
        .returning();
      if (!cleared) throw new Error('request disappeared');
      const closed = await changeRequestStatus(tx, {
        request: cleared,
        to: 'closed',
        cause: 'closed_by_owner',
        at,
      });
      const run = await options.runs.endForRequest(tx, project, closed);
      const rejected = await rejectForClosing(tx, { request: closed, project, at });
      const body = [
        'The owner closed the request.',
        ...(run.stopped
          ? ['Its planning run was stopped; it does not count as a failed attempt.']
          : []),
        ...(rejected ? ['Its proposed plan is rejected.'] : []),
        'Nothing is planned for it any more.',
      ].join(' ');
      const [comment] = await tx
        .insert(schema.comments)
        .values({ requestId: row.id, author: 'owner', kind: 'status_change', body, createdAt: at })
        .returning({ id: schema.comments.id });
      if (!comment) throw new Error('comment not inserted');
      await recordEvent(tx, {
        actor: 'owner',
        ...requestEntity(closed),
        type: 'request.commented',
        payload: {
          request: closed.number,
          project: project?.key ?? null,
          commentId: comment.id,
          kind: 'status_change',
        },
        at,
      });
      return { detail: await detail(tx, closed), send: run.send };
    });
    await result.send();
    request.log.info({ request: result.detail.number }, 'request closed by the owner');
    return result.detail;
  });

  // The owner's answer to the open question of the request's planning run (owner's answer 9, lot
  // 5 step D2a): delivered live or by resume; with its machine offline, the run fails with
  // `machine_offline` and the request is open again. A question left by a run that ended keeps
  // its answer for the next planning run (owner's answer 8, lot 5 step E2).
  app.post<{ Params: { number: string } }>('/api/requests/:number/answer', async (request) => {
    await requireSession(db, request);
    const input = parseInput(AnswerRequest, request.body);
    const { commentMaxLength: max } = await resolveSettings(db, ['commentMaxLength']);
    if (input.body.length > max) {
      throw limitRefusal('body', { field: 'comment', max, unit: 'characters' });
    }
    const number = parseNumber(request.params.number);
    if (number === null) throw requestNotFound();
    await options.runs.answerRequest(number, input.body);
    request.log.info({ request: number }, 'request question answered');
    return detail(db, await findRequest(db, request.params.number));
  });
}
