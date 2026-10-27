import { schema } from '@orchestrator/db';
import { RequestStatus, type FailureReason } from '@orchestrator/protocol';
import { and, desc, eq } from 'drizzle-orm';
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
 * The request moves to `to` because of its planning run, with `request.status_changed`; nothing
 * when it is already there. Returns the request as changed.
 */
export async function changeRequestStatus(
  tx: Executor,
  input: {
    request: RequestRow;
    to: RequestStatus;
    cause: 'run_started' | 'run_ended';
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
