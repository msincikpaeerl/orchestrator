import { schema } from '@orchestrator/db';
import {
  OWNER_TRANSITIONS,
  type ChangeRequest,
  TicketStatus,
  type FailureReason,
  type OwnerTicketAction,
  type RunTicketAction,
  type TicketPriority,
  type TicketType,
} from '@orchestrator/protocol';
import { and, eq } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError } from '../http.js';
import {
  ticketEntity,
  ticketReference,
  type StatusChangedPayload,
  type TicketRow,
} from './model.js';

/**
 * The only module that writes a ticket's status (04, section 2; 01, invariant 5): the owner's
 * actions, and the effects of runs (Run now, Stop run, a run's end). Callers hold the project's
 * row lock and pass the open transaction: the status, its event and, for **Mark as
 * done manually**, its comment are written together or not at all.
 */

/** A ticket created by the owner starts in `todo` (04, section 2). */

/**
 * A ticket done or cancelled no longer wants its pull request (04, section 3.1; lot 3 step F3):
 * no attempt, no "Needs you" item; a ticket reopened after it waits for its next submission.
 */
function endsPullRequestWish(to: string) {
  return to === 'done' || to === 'cancelled'
    ? { pullRequestWantedSince: null, pullRequestFailure: null }
    : {};
}

export const OWNER_CREATION_STATUS = 'todo' satisfies TicketStatus;

export interface NewOwnerTicket {
  projectId: string;
  number: number;
  type: TicketType;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: TicketPriority;
  /** The assignee's profile; null when unassigned. */
  assigneeProfileId: string | null;
  now: Date;
}

/** Inserts a ticket created by the owner, in `todo`. */
export async function insertOwnerTicket(tx: Executor, ticket: NewOwnerTicket): Promise<TicketRow> {
  const [row] = await tx
    .insert(schema.tickets)
    .values({
      ...ticket,
      status: OWNER_CREATION_STATUS,
      createdBy: 'owner',
      createdAt: ticket.now,
      updatedAt: ticket.now,
    })
    .returning();
  if (!row) throw new Error('ticket not inserted');
  return row;
}

/** Why an action is refused from this status, in words for the owner and developers. */
export function refusal(action: OwnerTicketAction, status: TicketStatus): string | null {
  const transition = OWNER_TRANSITIONS[action];
  if (transition.from.includes(status)) return null;
  if (status === transition.to) return `The ticket is already ${status}`;
  if (action === 'mark_done' && status === 'proposed') {
    return 'A proposed ticket is not accepted yet: it cannot be marked as done';
  }
  return `${transition.label} is not possible for a ticket in ${status}: only from ${transition.from.join(', ')}`;
}

export interface OwnerAction {
  projectKey: string;
  ticket: TicketRow;
  action: OwnerTicketAction;
  /**
   * Mandatory for `mark_done` and `request_changes`, optional for `reject`, posted as a
   * `status_change` comment. Ignored otherwise.
   */
  comment?: string;
  /**
   * For `request_changes` (lot 3 step I): the ticket's latest accepted commit, and on
   * `awaiting_merge` what the request came after. Kept on the ticket with the comment.
   */
  changeRequest?: {
    commit: string | null;
    after: 'approved' | 'skipped' | null;
    /** The base GitHub said the pull request conflicts with, at this moment (lot 3 step J3b). */
    conflict: string | null;
  };
  now: Date;
}

/** Applies an owner action to a ticket's status, with its event and comment. */
export async function applyOwnerAction(tx: Executor, input: OwnerAction): Promise<TicketRow> {
  const { ticket, action, now } = input;
  const from = TicketStatus.parse(ticket.status);
  const refused = refusal(action, from);
  if (refused !== null) throw new HttpError(409, 'ticket_transition_not_allowed', refused);
  const { to } = OWNER_TRANSITIONS[action];
  if ((action === 'accept' || action === 'reject') && ticket.createdBy !== 'agent') {
    throw new HttpError(
      409,
      'ticket_transition_not_allowed',
      `${OWNER_TRANSITIONS[action].label} is only for a ticket an agent proposed`,
    );
  }

  let commentId: string | null = null;
  const body = input.comment?.trim() ?? '';
  if ((action === 'mark_done' || action === 'request_changes') && body === '') {
    throw new HttpError(400, 'invalid_request', 'comment: a comment explaining why is required');
  }
  if (
    (action === 'mark_done' || action === 'reject' || action === 'request_changes') &&
    body !== ''
  ) {
    const [comment] = await tx
      .insert(schema.comments)
      .values({ ticketId: ticket.id, author: 'owner', kind: 'status_change', body, createdAt: now })
      .returning({ id: schema.comments.id });
    if (!comment) throw new Error('comment not inserted');
    commentId = comment.id;
  }
  if (action === 'skip_review') {
    // Says who skipped it, for the ticket page and "Needs you" (owner's answer 5, lot 3 step H).
    const [comment] = await tx
      .insert(schema.comments)
      .values({
        ticketId: ticket.id,
        author: 'system',
        kind: 'status_change',
        body: 'The owner skipped the review.',
        createdAt: now,
      })
      .returning({ id: schema.comments.id });
    if (!comment) throw new Error('comment not inserted');
    commentId = comment.id;
  }

  // The owner's request stands until the next accepted submission (owner's answers 1 and 6, lot
  // 3 step I); Reopen starts the counts again and clears the stop (answer 2).
  const changes =
    action === 'request_changes' && commentId !== null
      ? {
          changeRequest: {
            by: 'owner',
            commit: input.changeRequest?.commit ?? null,
            commentId,
            after: input.changeRequest?.after ?? null,
            conflict: input.changeRequest?.conflict ? { base: input.changeRequest.conflict } : null,
            at: now.toISOString(),
          } satisfies ChangeRequest,
          changeRequestAnsweredAt: null,
        }
      : action === 'reopen'
        ? { attemptCount: 0, reviewRounds: 0, stopped: null }
        : {};

  // The status is checked again in the update: the caller's lock makes a mismatch a bug.
  const [updated] = await tx
    .update(schema.tickets)
    .set({ status: to, updatedAt: now, ...endsPullRequestWish(to), ...changes })
    .where(and(eq(schema.tickets.id, ticket.id), eq(schema.tickets.status, from)))
    .returning();
  if (!updated) throw new Error(`ticket ${ticket.id} changed during a transition`);

  const payload: StatusChangedPayload = {
    project: input.projectKey,
    ticket: ticketReference(input.projectKey, ticket.number),
    from,
    to,
    action,
    commentId,
  };
  await recordEvent(tx, {
    actor: 'owner',
    ...ticketEntity(ticket),
    type: 'ticket.status_changed',
    payload,
    at: now,
  });
  return updated;
}

/** The ticket statuses each run action applies from, and where it leads (04, section 2). */
const RUN_TRANSITIONS: Readonly<
  Record<RunTicketAction, { from: readonly TicketStatus[]; to: TicketStatus }>
> = {
  run_now: { from: ['todo'], to: 'in_progress' },
  stop_run: { from: ['in_progress', 'waiting_human'], to: 'todo' },
  run_submitted: { from: ['in_progress'], to: 'in_review' },
  run_ended: { from: ['in_progress', 'waiting_human'], to: 'todo' },
  question_asked: { from: ['in_progress', 'in_review'], to: 'waiting_human' },
  answered: { from: ['waiting_human'], to: 'in_progress' },
  ci_checked_again: { from: ['todo'], to: 'in_review' },
  // A review run never moves its ticket out of review by itself (owner's answer 6c, lot 3 H2).
  review_answered: { from: ['waiting_human'], to: 'in_review' },
  review_ended: { from: ['waiting_human'], to: 'in_review' },
  review_approved: { from: ['in_review'], to: 'awaiting_merge' },
  review_changes_requested: { from: ['in_review'], to: 'todo' },
  // Every state with an open pull request (owner's answer 2, lot 3 step J1).
  pull_request_merged: {
    from: ['todo', 'in_progress', 'waiting_human', 'in_review', 'awaiting_merge'],
    to: 'done',
  },
};

export interface RunAction {
  projectKey: string;
  ticket: TicketRow;
  action: RunTicketAction;
  actor: 'owner' | 'system' | 'agent';
  /** Null for `pull_request_merged` on a ticket with no active run. */
  runId: string | null;
  /** The comment behind the change, already written (a question, an answer). */
  commentId?: string;
  /** For the `agent` actor: the profile's key and name (01, section 3.10). */
  agent?: { key: string; name: string };
  /** For `run_ended`: why, and whether it counts as a failed attempt (04, section 5). */
  failureReason?: FailureReason;
  attemptCounted?: boolean;
  /**
   * For `ci_checked_again` after `ci_failed`: that run's failed attempt no longer counts, one
   * taken off `attempt_count`, never below 0 (owner's answer 3d, lot 3 step G2c).
   */
  attemptTakenBack?: boolean;
  /**
   * For `ci_checked_again` on a ticket stopped after failed attempts: the stop lifted (owner's
   * answer 4, lot 3 step K).
   */
  stopLifted?: boolean;
  /** Posted by the system as a `status_change` comment, in the same transaction. */
  comment?: string;
  /** For `review_changes_requested`: Quality's request, kept on the ticket (lot 3 step I). */
  changeRequest?: ChangeRequest;
  now: Date;
}

/**
 * Applies a run's effect on its ticket, with its event, its comment and, for a counted failure,
 * `attempt_count` raised. Returns null, changing nothing, when the ticket is no longer in a status
 * the action applies from (the owner cancelled it meanwhile, for example). The caller holds the
 * project's row lock.
 */
export async function applyRunAction(tx: Executor, input: RunAction): Promise<TicketRow | null> {
  const { ticket, action, now } = input;
  const from = TicketStatus.parse(ticket.status);
  const transition = RUN_TRANSITIONS[action];
  if (!transition.from.includes(from)) return null;

  let commentId: string | null = input.commentId ?? null;
  if (input.comment !== undefined) {
    const [comment] = await tx
      .insert(schema.comments)
      .values({
        ticketId: ticket.id,
        author: 'system',
        kind: 'status_change',
        body: input.comment,
        createdAt: now,
      })
      .returning({ id: schema.comments.id });
    if (!comment) throw new Error('comment not inserted');
    commentId = comment.id;
  }

  const counted = input.attemptCounted === true;
  const [updated] = await tx
    .update(schema.tickets)
    .set({
      status: transition.to,
      updatedAt: now,
      ...endsPullRequestWish(transition.to),
      ...(counted ? { attemptCount: ticket.attemptCount + 1 } : {}),
      ...(input.attemptTakenBack === true
        ? { attemptCount: Math.max(0, ticket.attemptCount - 1) }
        : {}),
      ...(input.stopLifted === true ? { stopped: null } : {}),
      // An accepted submission answers the standing request (owner's answer 3, lot 3 step I).
      ...(transition.to === 'in_review' &&
      (action === 'run_submitted' || action === 'ci_checked_again') &&
      ticket.changeRequest !== null &&
      ticket.changeRequestAnsweredAt === null
        ? { changeRequestAnsweredAt: now }
        : {}),
      ...(input.changeRequest === undefined
        ? {}
        : {
            changeRequest: input.changeRequest,
            changeRequestAnsweredAt: null,
            ...(input.changeRequest.by === 'quality'
              ? { reviewRounds: input.changeRequest.round }
              : {}),
          }),
    })
    .where(and(eq(schema.tickets.id, ticket.id), eq(schema.tickets.status, from)))
    .returning();
  if (!updated) throw new Error(`ticket ${ticket.id} changed during a transition`);

  const payload: StatusChangedPayload = {
    project: input.projectKey,
    ticket: ticketReference(input.projectKey, ticket.number),
    from,
    to: transition.to,
    action,
    commentId,
    ...(input.runId === null ? {} : { runId: input.runId }),
    ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
    ...(input.attemptCounted === undefined ? {} : { attemptCounted: input.attemptCounted }),
    ...(input.agent ? { agent: input.agent.key, agentName: input.agent.name } : {}),
  };
  await recordEvent(tx, {
    actor: input.actor,
    ...ticketEntity(ticket),
    type: 'ticket.status_changed',
    payload,
    at: now,
  });
  return updated;
}
