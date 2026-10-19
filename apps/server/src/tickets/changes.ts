import { schema } from '@orchestrator/db';
import {
  ChangeRequest,
  TicketStop,
  type TicketChangeRequest,
  type TicketReviewLatest,
} from '@orchestrator/protocol';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { ciOutcome, ciSourceRun } from '../runs/ci-outcome.js';
import { resolveSettings } from '../settings/store.js';
import type { TicketRow } from './model.js';

// Requests for changes and the retry policy's stop, as kept on the ticket (01, section 3.4; 04,
// sections 2 and 5; owner's answers 1 to 6, lot 3 step I).

/** The ticket's latest request for changes, standing or answered; null when none. */
export function latestRequest(ticket: TicketRow): ChangeRequest | null {
  return ticket.changeRequest === null ? null : ChangeRequest.parse(ticket.changeRequest);
}

/**
 * The request still standing: made after the ticket's latest accepted submission (07, section
 * 3). Run now then starts a `fix_review` run, and the commit it was made on is refused.
 */
export function standingRequest(ticket: TicketRow): ChangeRequest | null {
  return ticket.changeRequestAnsweredAt === null ? latestRequest(ticket) : null;
}

export function ticketStop(ticket: Pick<TicketRow, 'stopped'>): TicketStop | null {
  return ticket.stopped === null ? null : TicketStop.parse(ticket.stopped);
}

/** The ticket page's view of its latest request (lot 3 step I). */
export async function ticketChangeRequest(
  executor: Executor,
  ticket: TicketRow,
): Promise<TicketChangeRequest | null> {
  const request = latestRequest(ticket);
  if (request === null) return null;
  const { maxReviewRounds } = await resolveSettings(
    executor,
    ['maxReviewRounds'],
    ticket.projectId,
  );
  return { request, standing: ticket.changeRequestAnsweredAt === null, limit: maxReviewRounds };
}

/**
 * The commit the owner's **Request changes** is made on (owner's answer 1, lot 3 step I): the one
 * CI checked for the latest accepted submission; for a ticket left by 0.3.0, without CI, the head
 * its submitting run reported. Null when none was reported.
 */
export async function acceptedCommit(
  executor: Executor,
  ticket: TicketRow,
): Promise<string | null> {
  const source = await ciSourceRun(executor, ticket.id);
  const outcome = source === null ? null : ciOutcome(source);
  if (outcome !== null) return outcome.commit;
  const [submitted] = await executor
    .select({ head: schema.runs.branchHead })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.ticketId, ticket.id),
        ne(schema.runs.purpose, 'review'),
        eq(schema.runs.decision, 'submitted'),
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  return submitted?.head ?? null;
}

/** On `awaiting_merge`, what the owner's request comes after: the approval or the skip. */
export function requestAfter(latest: TicketReviewLatest | null): 'approved' | 'skipped' | null {
  if (latest?.kind === 'skipped') return 'skipped';
  if (latest?.kind === 'decision' && latest.decision.kind === 'approved') return 'approved';
  return null;
}

/** The comment of **Try again** (lot 3 step I), with what stopped the ticket. */
export function tryAgainComment(stop: TicketStop): string {
  const why =
    stop.cause === 'review_rounds'
      ? `${String(stop.count)} requests for changes by Quality (Most review rounds per ticket: ${String(stop.limit)})`
      : `${String(stop.count)} failed attempt${stop.count === 1 ? '' : 's'} (Failed attempts before asking you: ${String(stop.limit)})`;
  return `The owner used Try again: the ticket was stopped after ${why}. Its failed attempts and review rounds count from 0 again.`;
}
