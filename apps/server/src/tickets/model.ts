import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  CommentAuthor,
  CommentKind,
  EventPayloads,
  PauseReason,
  RunStatus,
  TicketCreator,
  TicketPriority,
  TicketStatus,
  TicketHold,
  TicketStop,
  TicketType,
  type AgentAuthorship,
  type AgentLink,
  type Comment,
  type EventPayload,
  type TicketLink,
  type TicketSummary,
} from '@orchestrator/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../database.js';

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

/** Every agent profile by id, as tickets and comments name them. */
export async function profileLinks(executor: Executor): Promise<Map<string, AgentLink>> {
  const rows = await executor
    .select({
      id: schema.agentProfiles.id,
      key: schema.agentProfiles.key,
      name: schema.agentProfiles.name,
    })
    .from(schema.agentProfiles);
  return new Map(rows.map((row) => [row.id, { key: row.key, name: row.name }]));
}

/** The agent and run behind a ticket or comment, when an agent wrote it. */
function authorship(
  profileId: string | null,
  runId: string | null,
  profiles: ReadonlyMap<string, AgentLink>,
): AgentAuthorship | null {
  const profile = profileId === null ? undefined : profiles.get(profileId);
  return profile && runId !== null ? { profile, runId } : null;
}

export type ActiveRun = NonNullable<TicketSummary['activeRun']>;

/** The active run of each of these tickets that has one (01, invariant 2), by ticket id. */
export async function activeRuns(
  executor: Executor,
  ticketIds: string[],
): Promise<Map<string, ActiveRun>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await executor
    .select({
      run: {
        id: schema.runs.id,
        ticketId: schema.runs.ticketId,
        status: schema.runs.status,
        pauseReason: schema.runs.pauseReason,
        progressShown: schema.runs.progressShown,
        progressShownAt: schema.runs.progressShownAt,
        ciCommit: schema.runs.ciCommit,
      },
      machine: {
        id: schema.machines.id,
        name: schema.machines.name,
        status: schema.machines.status,
      },
    })
    .from(schema.runs)
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(
      and(
        inArray(schema.runs.ticketId, ticketIds),
        inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  const active = new Map<string, ActiveRun>();
  for (const { run, machine } of rows) {
    if (run.ticketId === null) continue;
    const status = RunStatus.parse(run.status);
    active.set(run.ticketId, {
      id: run.id,
      status,
      pauseReason: run.pauseReason === null ? null : PauseReason.parse(run.pauseReason),
      machine: { id: machine.id, name: machine.name, online: machine.status === 'online' },
      progress:
        run.progressShown === null || run.progressShownAt === null
          ? null
          : { text: run.progressShown, at: run.progressShownAt.toISOString() },
      waitingForCi: status === 'running' && run.ciCommit !== null,
    });
  }
  return active;
}

/** The ticket's hold as stored; null when it is not held. */
export function storedHold(row: Pick<TicketRow, 'held'>): TicketHold | null {
  return row.held === null ? null : TicketHold.parse(row.held);
}

/**
 * The hold that applies now, for the screens and the scheduler: a stopped run's hold and the
 * Request changes box's while the ticket is in To do, a stopped review's while it is in review
 * (`commit`, when given, must be the commit the stopped review was for).
 */
export function applyingHold(
  row: Pick<TicketRow, 'held' | 'status'>,
  commit?: string,
): TicketHold | null {
  const hold = storedHold(row);
  if (hold === null) return null;
  if (hold.cause === 'stop_review') {
    if (row.status !== 'in_review') return null;
    return commit === undefined || hold.commit === commit ? hold : null;
  }
  return row.status === 'todo' ? hold : null;
}

/** The API's view of a ticket. Parsing the text columns catches a value no code should write. */
export function toTicketSummary(
  row: TicketRow,
  projectKey: string,
  blocked: boolean,
  assignee: AgentLink | null,
  profiles: ReadonlyMap<string, AgentLink>,
  activeRun: ActiveRun | null,
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
    stop: row.stopped === null ? null : TicketStop.parse(row.stopped),
    held: applyingHold(row),
    assignee,
    createdBy: TicketCreator.parse(row.createdBy),
    createdByAgent: authorship(row.createdByProfileId, row.createdByRunId, profiles),
    activeRun,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTicketLink(row: Pick<TicketRow, 'number' | 'title' | 'status'>): TicketLink {
  return { number: row.number, title: row.title, status: TicketStatus.parse(row.status) };
}

export function toComment(row: CommentRow, profiles: ReadonlyMap<string, AgentLink>): Comment {
  return {
    id: row.id,
    author: CommentAuthor.parse(row.author),
    agent: authorship(row.authorProfileId, row.runId, profiles),
    kind: CommentKind.parse(row.kind),
    body: row.body,
    answers: row.answersCommentId,
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
