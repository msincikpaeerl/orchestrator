import { schema } from '@orchestrator/db';
import {
  OWNER_TRANSITIONS,
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
    return 'A proposed ticket belongs to a plan that is not approved yet: it cannot be marked as done';
  }
  return `${transition.label} is not possible for a ticket in ${status}: only from ${transition.from.join(', ')}`;
}

export interface OwnerAction {
  projectKey: string;
  ticket: TicketRow;
  action: OwnerTicketAction;
  /** Mandatory for `mark_done`, posted as a `status_change` comment. Ignored otherwise. */
  comment?: string;
  now: Date;
}

/** Applies an owner action to a ticket's status, with its event and comment. */
export async function applyOwnerAction(tx: Executor, input: OwnerAction): Promise<TicketRow> {
  const { ticket, action, now } = input;
  const from = TicketStatus.parse(ticket.status);
  const refused = refusal(action, from);
  if (refused !== null) throw new HttpError(409, 'ticket_transition_not_allowed', refused);
  const { to } = OWNER_TRANSITIONS[action];

  let commentId: string | null = null;
  if (action === 'mark_done') {
    const body = input.comment?.trim() ?? '';
    if (body === '') {
      throw new HttpError(400, 'invalid_request', 'comment: a comment explaining why is required');
    }
    const [comment] = await tx
      .insert(schema.comments)
      .values({ ticketId: ticket.id, author: 'owner', kind: 'status_change', body, createdAt: now })
      .returning({ id: schema.comments.id });
    if (!comment) throw new Error('comment not inserted');
    commentId = comment.id;
  }

  // The status is checked again in the update: the caller's lock makes a mismatch a bug.
  const [updated] = await tx
    .update(schema.tickets)
    .set({ status: to, updatedAt: now })
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
};

export interface RunAction {
  projectKey: string;
  ticket: TicketRow;
  action: RunTicketAction;
  actor: 'owner' | 'system';
  runId: string;
  /** For `run_ended`: why, and whether it counts as a failed attempt (04, section 5). */
  failureReason?: FailureReason;
  attemptCounted?: boolean;
  /** Posted by the system as a `status_change` comment, in the same transaction. */
  comment?: string;
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

  let commentId: string | null = null;
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
      ...(counted ? { attemptCount: ticket.attemptCount + 1 } : {}),
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
    runId: input.runId,
    ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
    ...(input.attemptCounted === undefined ? {} : { attemptCounted: input.attemptCounted }),
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
