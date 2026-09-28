import { schema } from '@orchestrator/db';
import { CommentKind, TicketPriority, TicketStatus, TicketType } from '@orchestrator/protocol';
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { acceptanceCriteria, ticketReference, type TicketRow } from '../tickets/model.js';
import type { ImplementTicket } from '../agents/messages.js';

/**
 * Layer 3 of 03, section 3 for an `implement` run: the ticket, its dependencies and its comments
 * as the first message shows them, with the run's attempt and, when the machine's branch holds
 * earlier commits, the base the agent compares with.
 */
export async function implementTicket(
  executor: Executor,
  input: {
    projectKey: string;
    projectName: string;
    ticket: TicketRow;
    attempt: number;
    earlierWorkBase: string | null;
  },
): Promise<ImplementTicket> {
  const { ticket, projectKey } = input;
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
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.ticketId, ticket.id))
    .orderBy(asc(schema.comments.createdAt));
  return {
    projectName: input.projectName,
    reference: ticketReference(projectKey, ticket.number),
    title: ticket.title,
    type: TicketType.parse(ticket.type),
    priority: TicketPriority.parse(ticket.priority),
    description: ticket.description,
    acceptanceCriteria: acceptanceCriteria(ticket),
    dependencies: dependencies.map((link) => ({
      reference: ticketReference(projectKey, link.number),
      title: link.title,
      status: TicketStatus.parse(link.status),
    })),
    comments: comments.map((comment) => ({
      author: comment.author === 'owner' ? { kind: 'owner' as const } : { kind: 'system' as const },
      kind: CommentKind.parse(comment.kind),
      at: comment.createdAt,
      body: comment.body,
    })),
    attempt: input.attempt,
    earlierWorkBase: input.earlierWorkBase,
  };
}
