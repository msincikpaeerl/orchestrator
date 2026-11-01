import { schema } from '@orchestrator/db';
import type {
  ApiErrorCode,
  LimitExceeded,
  SettingValues,
  TicketPriority,
  TicketType,
} from '@orchestrator/protocol';
import { eq, sql } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import type { ProjectRow } from '../projects/model.js';
import { resolveSettings } from '../settings/store.js';
import { ticketEntity, ticketReference, type TicketRow } from './model.js';
import { insertOwnerTicket, type PlanOrigin } from './transitions.js';

/*
 * The rules of a ticket the owner creates, shared by the ticket form and the import of a file
 * (lot 5bis step A): one copy of each.
 */

export type ProfileRow = typeof schema.agentProfiles.$inferSelect;

/** The roles a ticket's assignee may have: those that implement (03, section 4). */
const ASSIGNABLE_ROLES = new Set(['builder', 'writer']);

/** True when the profile can be a ticket's assignee. */
export function canBeAssigned(row: Pick<ProfileRow, 'role'>): boolean {
  return ASSIGNABLE_ROLES.has(row.role);
}

/** Why the profile with this key cannot be a ticket's assignee; null when it can. */
export function assigneeRefusal(
  key: string,
  row: ProfileRow | undefined,
): { code: ApiErrorCode; message: string } | null {
  if (!row) return { code: 'agent_not_found', message: `No agent profile with the key ${key}` };
  // Only a builder or a writer implements a ticket; Quality's reviews start by themselves
  // from the ticket in review (03, section 4; lot 3 step H1).
  if (!canBeAssigned(row)) {
    return {
      code: 'agent_not_assignable',
      message: `${row.name} reviews the work of other agents and cannot be assigned a ticket`,
    };
  }
  return null;
}

export type TicketLimits = Pick<
  SettingValues,
  | 'ticketTitleMaxLength'
  | 'ticketDescriptionMaxLength'
  | 'ticketMaxAcceptanceCriteria'
  | 'acceptanceCriterionMaxLength'
>;

/** The current length and count limits of a ticket (04, section 8). Global only. */
export function ticketLimits(executor: Executor): Promise<TicketLimits> {
  return resolveSettings(executor, [
    'ticketTitleMaxLength',
    'ticketDescriptionMaxLength',
    'ticketMaxAcceptanceCriteria',
    'acceptanceCriterionMaxLength',
  ]);
}

/** Each field over its limit, with the limit's value; empty when every field is within. */
export function exceededLimits(
  limits: TicketLimits,
  fields: { title?: string; description?: string; acceptanceCriteria?: string[] },
): LimitExceeded[] {
  const exceeded: LimitExceeded[] = [];
  if (fields.title !== undefined && fields.title.length > limits.ticketTitleMaxLength) {
    exceeded.push({ field: 'title', max: limits.ticketTitleMaxLength, unit: 'characters' });
  }
  if (
    fields.description !== undefined &&
    fields.description.length > limits.ticketDescriptionMaxLength
  ) {
    exceeded.push({
      field: 'description',
      max: limits.ticketDescriptionMaxLength,
      unit: 'characters',
    });
  }
  const criteria = fields.acceptanceCriteria ?? [];
  if (criteria.length > limits.ticketMaxAcceptanceCriteria) {
    exceeded.push({
      field: 'acceptance_criteria',
      max: limits.ticketMaxAcceptanceCriteria,
      unit: 'items',
    });
  }
  criteria.forEach((criterion, index) => {
    if (criterion.length > limits.acceptanceCriterionMaxLength) {
      exceeded.push({
        field: 'acceptance_criterion',
        index,
        max: limits.acceptanceCriterionMaxLength,
        unit: 'characters',
      });
    }
  });
  return exceeded;
}

/**
 * The tickets `from` waits for, directly or not, up to `to`: `[from, ..., to]`, or null when
 * `from` does not wait for `to`. Adding "`to` waits for `from`" would then close a cycle.
 */
export function findPath(
  edges: readonly { ticketId: string; blockedById: string }[],
  from: string,
  to: string,
): string[] | null {
  const waitsFor = new Map<string, string[]>();
  for (const edge of edges) {
    waitsFor.set(edge.ticketId, [...(waitsFor.get(edge.ticketId) ?? []), edge.blockedById]);
  }
  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(previous.get(path[0] as string) as string);
      return path;
    }
    for (const next of waitsFor.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}

export interface NewTicket {
  type: TicketType;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: TicketPriority;
  assignee: ProfileRow | null;
}

type Blocker = Pick<TicketRow, 'id' | 'number'>;

/**
 * Creates a ticket of the owner in `todo` (04, section 2) with its dependencies and its
 * `ticket.created` event. Under the project's row lock, taken by the caller: numbers follow each
 * other and are never given twice. `blockers` are tickets of the same project, checked by the
 * caller.
 */
export async function createOwnerTicket(
  tx: Executor,
  project: ProjectRow,
  ticket: NewTicket,
  blockers: readonly Blocker[],
  at: Date,
): Promise<TicketRow> {
  const row = await insertNumberedTicket(tx, project, ticket, at);
  await completeOwnerTicket(tx, project, row, ticket.assignee, blockers, at);
  return row;
}

/**
 * The first half of `createOwnerTicket`: the ticket with the project's next number. An import
 * inserts all its tickets first, so a ticket can wait for one later in the file.
 */
export async function insertNumberedTicket(
  tx: Executor,
  project: ProjectRow,
  ticket: NewTicket,
  at: Date,
  origin?: PlanOrigin,
): Promise<TicketRow> {
  const [counter] = await tx
    .update(schema.projects)
    .set({ lastTicketNumber: sql`${schema.projects.lastTicketNumber} + 1` })
    .where(eq(schema.projects.id, project.id))
    .returning({ number: schema.projects.lastTicketNumber });
  if (!counter) throw new Error('project disappeared');
  return insertOwnerTicket(tx, {
    projectId: project.id,
    number: counter.number,
    type: ticket.type,
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    priority: ticket.priority,
    assigneeProfileId: ticket.assignee?.id ?? null,
    now: at,
    ...(origin ? { origin } : {}),
  });
}

/** The second half of `createOwnerTicket`: the dependencies and the `ticket.created` event. */
export async function completeOwnerTicket(
  tx: Executor,
  project: ProjectRow,
  row: TicketRow,
  assignee: ProfileRow | null,
  blockers: readonly Blocker[],
  at: Date,
  /** A plan's ticket (lot 5 step F): its `ticket.created` names the plan and its request. */
  plan?: { planId: string; request: number },
): Promise<void> {
  if (blockers.length > 0) {
    await tx.insert(schema.ticketDependencies).values(
      blockers.map((blocker) => ({
        projectId: project.id,
        ticketId: row.id,
        blockedById: blocker.id,
        createdAt: at,
      })),
    );
  }
  await recordEvent(tx, {
    actor: 'owner',
    ...ticketEntity(row),
    type: 'ticket.created',
    payload: {
      project: project.key,
      ticket: ticketReference(project.key, row.number),
      type: row.type,
      title: row.title,
      priority: row.priority,
      status: row.status,
      blockedBy: blockers.map((blocker) => ticketReference(project.key, blocker.number)).sort(),
      assignee: assignee?.key ?? null,
      ...(assignee ? { assigneeName: assignee.name } : {}),
      ...(plan ?? {}),
    },
    at,
  });
}
