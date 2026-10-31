import { schema } from '@orchestrator/db';
import { ACTIVE_RUN_STATUSES, RequestStatus, type FailureReason } from '@orchestrator/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';

// What the request routes, the MCP backend and the run service share about a request (01,
// section 3.2; lot 5 step D2a): its events' entity, its open question and its status changes.

export type RequestRow = typeof schema.requests.$inferSelect;
type CommentRow = typeof schema.comments.$inferSelect;

/** Entity and project of the events about a request (01, section 3.10). */
export function requestEntity(row: Pick<RequestRow, 'id' | 'projectId'>) {
  return { entityType: 'request', entityId: row.id, projectId: row.projectId } as const;
}

/** The project's key as events give it, or null for a new project. */
export async function requestProjectKey(
  executor: Executor,
  row: Pick<RequestRow, 'projectId'>,
): Promise<string | null> {
  if (row.projectId === null) return null;
  const [project] = await executor
    .select({ key: schema.projects.key })
    .from(schema.projects)
    .where(eq(schema.projects.id, row.projectId));
  return project?.key ?? null;
}

/** The request's latest question and the answer to it, if any. */
export async function requestQuestion(
  executor: Executor,
  requestId: string,
): Promise<{ question: CommentRow; answer: CommentRow | null } | null> {
  const [question] = await executor
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.requestId, requestId), eq(schema.comments.kind, 'question')))
    .orderBy(desc(schema.comments.createdAt), desc(schema.comments.id))
    .limit(1);
  if (!question) return null;
  const [answer] = await executor
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.requestId, requestId),
        eq(schema.comments.answersCommentId, question.id),
      ),
    )
    .orderBy(desc(schema.comments.createdAt))
    .limit(1);
  return { question, answer: answer ?? null };
}

/**
 * The question that waits for the owner (owner's answer 8, lot 5 step E2): the latest question,
 * unanswered, asked by a planning run still active. A question left by a run that ended waits for
 * no one: it blocks neither `request_ask` nor `plan_propose`, and its answer reaches no run.
 */
export async function waitingQuestion(
  executor: Executor,
  requestId: string,
): Promise<CommentRow | null> {
  const asked = await requestQuestion(executor, requestId);
  if (!asked || asked.answer !== null || asked.question.runId === null) return null;
  const [run] = await executor
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.id, asked.question.runId),
        inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  return run ? asked.question : null;
}

/** A `system` comment on a request, with its `request.commented` event. */
export async function requestSystemComment(
  tx: Executor,
  request: RequestRow,
  body: string,
  at: Date,
): Promise<void> {
  const [comment] = await tx
    .insert(schema.comments)
    .values({ requestId: request.id, author: 'system', kind: 'status_change', body, createdAt: at })
    .returning({ id: schema.comments.id });
  if (!comment) throw new Error('comment not inserted');
  await recordEvent(tx, {
    actor: 'system',
    ...requestEntity(request),
    type: 'request.commented',
    payload: {
      request: request.number,
      project: await requestProjectKey(tx, request),
      commentId: comment.id,
      kind: 'status_change',
    },
    at,
  });
}

/**
 * The request moves to `to` because of its planning run, with `request.status_changed`; nothing
 * when it is already there. Returns the request as changed.
 */
export async function changeRequestStatus(
  tx: Executor,
  input: {
    request: RequestRow;
    to: RequestStatus;
    cause: 'run_started' | 'run_ended' | 'plan_proposed';
    runId: string;
    failureReason?: FailureReason;
    at: Date;
  },
): Promise<RequestRow> {
  const { request, to, at } = input;
  const from = RequestStatus.parse(request.status);
  if (from === to) return request;
  const [updated] = await tx
    .update(schema.requests)
    .set({ status: to, updatedAt: at })
    .where(eq(schema.requests.id, request.id))
    .returning();
  if (!updated) throw new Error(`request ${request.id} disappeared`);
  await recordEvent(tx, {
    actor: 'system',
    ...requestEntity(updated),
    type: 'request.status_changed',
    payload: {
      request: updated.number,
      project: await requestProjectKey(tx, updated),
      from,
      to,
      cause: input.cause,
      runId: input.runId,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    },
    at,
  });
  return updated;
}
