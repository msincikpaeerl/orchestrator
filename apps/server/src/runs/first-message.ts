import { schema } from '@orchestrator/db';
import { CommentKind, TicketPriority, TicketStatus, TicketType } from '@orchestrator/protocol';
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { acceptanceCriteria, ticketReference, type TicketRow } from '../tickets/model.js';
import type { ImplementTicket } from '../agents/messages.js';
import type { ReviewCi, ReviewTicket } from '../agents/review-message.js';
import { DodReport } from '@orchestrator/protocol';
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
  return {
    projectName: input.projectName,
    reference: ticketReference(projectKey, ticket.number),
    title: ticket.title,
    type: TicketType.parse(ticket.type),
    priority: TicketPriority.parse(ticket.priority),
    description: ticket.description,
    acceptanceCriteria: acceptanceCriteria(ticket),
    dependencies,
    comments: comments.filter((comment) => comment.kind !== 'review'),
    earlierReviews: comments
      .filter((comment) => comment.kind === 'review')
      .map(({ author, at, body }) => ({ author, at, body })),
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
    report: maskStrings(DodReport.parse(ticket.dodReport)),
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
): Promise<ImplementTicket> {
  const { ticket, projectKey } = input;
  const { dependencies, comments } = await linksAndComments(executor, projectKey, ticket);
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
