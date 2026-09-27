import { schema } from '@orchestrator/db';
import {
  CommentAuthor,
  CommentKind,
  EventPayloads,
  TicketCreator,
  TicketPriority,
  TicketStatus,
  TicketType,
  type AgentLink,
  type Comment,
  type EventPayload,
  type TicketLink,
  type TicketSummary,
} from '@orchestrator/protocol';
import { z } from 'zod';

export type TicketRow = typeof schema.tickets.$inferSelect;
export type CommentRow = typeof schema.comments.$inferSelect;

/** `WEB-12`: how the owner, events and refusals name a ticket. */
export function ticketReference(projectKey: string, number: number): string {
  return `${projectKey}-${String(number)}`;
}

/**
 * Entity and project of the events about a ticket; their payloads also give the project key and
 * the ticket reference.
 */
export function ticketEntity(row: Pick<TicketRow, 'id' | 'projectId'>) {
  return { entityType: 'ticket', entityId: row.id, projectId: row.projectId } as const;
}

/** The API's view of a ticket. Parsing the text columns catches a value no code should write. */
export function toTicketSummary(
  row: TicketRow,
  projectKey: string,
  blocked: boolean,
  assignee: AgentLink | null,
): TicketSummary {
  return {
    id: row.id,
    projectKey,
    number: row.number,
    type: TicketType.parse(row.type),
    title: row.title,
    priority: TicketPriority.parse(row.priority),
    status: TicketStatus.parse(row.status),
    blocked,
    assignee,
    createdBy: TicketCreator.parse(row.createdBy),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTicketLink(row: Pick<TicketRow, 'number' | 'title' | 'status'>): TicketLink {
  return { number: row.number, title: row.title, status: TicketStatus.parse(row.status) };
}

export function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    author: CommentAuthor.parse(row.author),
    kind: CommentKind.parse(row.kind),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export function acceptanceCriteria(row: Pick<TicketRow, 'acceptanceCriteria'>): string[] {
  return z.array(z.string()).parse(row.acceptanceCriteria);
}

/** Payload of `ticket.status_changed` events, written by the transition module. */
export const StatusChangedPayload = EventPayloads['ticket.status_changed'];
export type StatusChangedPayload = EventPayload<'ticket.status_changed'>;

const statusOrder = new Map(TicketStatus.options.map((status, index) => [status, index]));
const priorityOrder: Record<TicketPriority, number> = { high: 0, normal: 1, low: 2 };

/** Board order: by state (04, section 1), then highest priority, then oldest. */
export function boardOrder(a: TicketSummary, b: TicketSummary): number {
  return (
    (statusOrder.get(a.status) ?? 0) - (statusOrder.get(b.status) ?? 0) ||
    priorityOrder[a.priority] - priorityOrder[b.priority] ||
    a.number - b.number
  );
}
