import { schema } from '@orchestrator/db';
import { CommentKind, TicketPriority, TicketStatus, TicketType } from '@orchestrator/protocol';
import { and, asc, eq, gt, ne } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { acceptanceCriteria, ticketReference, type TicketRow } from '../tickets/model.js';
import type { FixReviewTicket, ImplementTicket } from '../agents/messages.js';
import type { PreviousReview, ReviewCi, ReviewTicket } from '../agents/review-message.js';
import { resolveSettings } from '../settings/store.js';
import { latestRequest } from '../tickets/changes.js';
import {
  ChangeRequest,
  StoredDodReport,
  ReviewDecision,
  maskSecrets,
} from '@orchestrator/protocol';
import { maskStrings } from '../event-log.js';

/**
 * Layer 3 of 03, section 3 for an `implement` run: the ticket, its dependencies and its comments
 * as the first message shows them, with the run's attempt and, when the machine's branch holds
 * earlier commits, the base the agent compares with.
 */
/** The ticket's dependencies and comments, as the first messages show them. */
async function linksAndComments(executor: Executor, projectKey: string, ticket: TicketRow) {
  const dependencies = await executor
    .select({
      number: schema.tickets.number,
      title: schema.tickets.title,
      status: schema.tickets.status,
    })
    .from(schema.ticketDependencies)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketDependencies.blockedById))
    .where(eq(schema.ticketDependencies.ticketId, ticket.id))
    .orderBy(asc(schema.tickets.number));
  const comments = await executor
    .select({ comment: schema.comments, agentName: schema.agentProfiles.name })
    .from(schema.comments)
    .leftJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.comments.authorProfileId))
    .where(eq(schema.comments.ticketId, ticket.id))
    .orderBy(asc(schema.comments.createdAt));
  return {
    dependencies: dependencies.map((link) => ({
      reference: ticketReference(projectKey, link.number),
      title: link.title,
      status: TicketStatus.parse(link.status),
    })),
    comments: comments.map(({ comment, agentName }) => ({
      id: comment.id,
      runId: comment.runId,
      author:
        comment.author === 'owner'
          ? { kind: 'owner' as const }
          : comment.author === 'agent'
            ? { kind: 'agent' as const, name: agentName ?? 'unknown' }
            : { kind: 'system' as const },
      kind: CommentKind.parse(comment.kind),
      at: comment.createdAt,
      body: comment.body,
    })),
  };
}

/**
 * Layer 3 of 03, section 3 for a `review` run (lot 3 step H1): the commit under review, what CI
 * came to, the ticket, its accepted report, its `review` comments apart from the others.
 */
export async function reviewTicket(
  executor: Executor,
  input: {
    projectKey: string;
    projectName: string;
    ticket: TicketRow;
    commit: string;
    pullRequest: { number: number; url: string };
    base: string;
    ci: ReviewCi;
  },
): Promise<ReviewTicket> {
  const { ticket, projectKey } = input;
  const { dependencies, comments } = await linksAndComments(executor, projectKey, ticket);
  // The request this work answers: its own comments go into its section, not the others.
  const request = ticket.changeRequestAnsweredAt === null ? null : latestRequest(ticket);
  const own = (comment: { id: string; runId: string | null }) =>
    request !== null &&
    (request.by === 'quality' ? comment.runId === request.runId : comment.id === request.commentId);
  const others = comments.filter((comment) => !own(comment));
  return {
    projectName: input.projectName,
    reference: ticketReference(projectKey, ticket.number),
    title: ticket.title,
    type: TicketType.parse(ticket.type),
    priority: TicketPriority.parse(ticket.priority),
    description: ticket.description,
    acceptanceCriteria: acceptanceCriteria(ticket),
    dependencies,
    comments: others.filter((comment) => comment.kind !== 'review'),
    earlierReviews: others
      .filter((comment) => comment.kind === 'review')
      .map(({ author, at, body }) => ({ author, at, body })),
    previous: request === null ? null : await previousReview(executor, ticket, request),
    commit: input.commit,
    pullRequest: input.pullRequest,
    base: input.base,
    ci: input.ci,
    workflows:
      // As the ticket page reads it: a reason not kept counts as "may have changed" (step F4).
      ticket.workflowChanges === true
        ? ticket.workflowReason === 'changed'
          ? 'changed'
          : 'not_listed'
        : null,
    // Masked as on the ticket page: an agent never receives a credential (03, section 3).
    report: maskStrings(StoredDodReport.parse(ticket.dodReport)),
  };
}

export async function implementTicket(
  executor: Executor,
  input: {
    projectKey: string;
    projectName: string;
    ticket: TicketRow;
    attempt: number;
    earlierWorkBase: string | null;
    notPushed: ImplementTicket['notPushed'];
    previousCi: ImplementTicket['previousCi'];
  },
  /** Comments said elsewhere in the message: a `fix_review` run's request (lot 3 step I). */
  leftOut: (comment: { id: string; runId: string | null }) => boolean = () => false,
): Promise<ImplementTicket> {
  const { ticket, projectKey } = input;
  const links = await linksAndComments(executor, projectKey, ticket);
  const { dependencies } = links;
  const comments = links.comments
    .filter((comment) => !leftOut(comment))
    .map(({ author, kind, at, body }) => ({ author, kind, at, body }));
  return {
    projectName: input.projectName,
    reference: ticketReference(projectKey, ticket.number),
    title: ticket.title,
    type: TicketType.parse(ticket.type),
    priority: TicketPriority.parse(ticket.priority),
    description: ticket.description,
    acceptanceCriteria: acceptanceCriteria(ticket),
    dependencies,
    comments,
    attempt: input.attempt,
    earlierWorkBase: input.earlierWorkBase,
    notPushed: input.notPushed,
    previousCi: input.previousCi,
  };
}

/**
 * Layer 3 of 03, section 3 for a `fix_review` run (owner's answers 3 and 5, lot 3 step I): the
 * ticket as for `implement`, and the standing request: Quality's points as its decision kept them
 * (masked), or the owner's comment whole. The request's own comments are not repeated among the
 * comments; earlier rounds stay there.
 */
export async function fixReviewTicket(
  executor: Executor,
  input: Parameters<typeof implementTicket>[1] & {
    request: ChangeRequest;
    branch: string;
    base: string;
    lost: boolean;
  },
): Promise<FixReviewTicket> {
  const { request } = input;
  const own = (comment: { id: string; runId: string | null }) =>
    request.by === 'quality' ? comment.runId === request.runId : comment.id === request.commentId;
  const implement = await implementTicket(executor, input, own);
  let fix: FixReviewTicket['request'];
  if (request.by === 'quality') {
    const [run] = await executor
      .select({ decision: schema.runs.reviewDecision })
      .from(schema.runs)
      .where(eq(schema.runs.id, request.runId));
    const decision = run?.decision ? ReviewDecision.parse(run.decision) : null;
    fix = {
      by: 'quality',
      at: new Date(request.at),
      commit: request.commit,
      points: maskStrings(decision?.points ?? []),
    };
  } else {
    fix = {
      by: 'owner',
      at: new Date(request.at),
      comment:
        (
          await executor
            .select({ body: schema.comments.body })
            .from(schema.comments)
            .where(eq(schema.comments.id, request.commentId))
        )[0]?.body ?? '',
    };
  }
  return {
    ...implement,
    request: fix,
    branch: input.branch,
    base: input.base,
    pullRequest: input.ticket.pullRequestNumber,
    lost: input.lost,
  };
}

/**
 * The request for changes a review run's work answers (owner's answer 4, lot 3 step I), with what
 * the agent said about it: the agents' notes from the builder runs after the request, masked.
 */
async function previousReview(
  executor: Executor,
  ticket: TicketRow,
  request: ChangeRequest,
): Promise<PreviousReview> {
  const at = new Date(request.at);
  const noteRows = await executor
    .select({ comment: schema.comments, agentName: schema.agentProfiles.name })
    .from(schema.comments)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.comments.runId))
    .leftJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.comments.authorProfileId))
    .where(
      and(
        eq(schema.comments.ticketId, ticket.id),
        eq(schema.comments.author, 'agent'),
        eq(schema.comments.kind, 'note'),
        ne(schema.runs.purpose, 'review'),
        gt(schema.comments.createdAt, at),
      ),
    )
    .orderBy(asc(schema.comments.createdAt));
  const notes = noteRows.map(({ comment, agentName }) => ({
    author: { kind: 'agent' as const, name: agentName ?? 'unknown' },
    at: comment.createdAt,
    body: maskSecrets(comment.body),
  }));
  if (request.by === 'quality') {
    const [run] = await executor
      .select({ decision: schema.runs.reviewDecision })
      .from(schema.runs)
      .where(eq(schema.runs.id, request.runId));
    const decision = run?.decision ? ReviewDecision.parse(run.decision) : null;
    const { maxReviewRounds } = await resolveSettings(
      executor,
      ['maxReviewRounds'],
      ticket.projectId,
    );
    return {
      by: 'quality',
      at,
      commit: request.commit,
      // A request made before Try again or Reopen, which count from 0 again: no round (I2).
      round: request.round > ticket.reviewRounds ? null : request.round,
      limit: maxReviewRounds,
      points: maskStrings(decision?.points ?? []),
      notes,
    };
  }
  const [comment] = await executor
    .select({ body: schema.comments.body })
    .from(schema.comments)
    .where(eq(schema.comments.id, request.commentId));
  return {
    by: 'owner',
    at,
    commit: request.commit,
    after: request.after,
    comment: comment?.body ?? '',
    notes,
  };
}
