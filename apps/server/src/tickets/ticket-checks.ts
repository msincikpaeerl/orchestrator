import { schema } from '@orchestrator/db';
import {
  TicketKey,
  TicketReference,
  type LimitExceeded,
  type TicketImportEntry,
} from '@orchestrator/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../database.js';
import type { ProjectRow } from '../projects/model.js';
import { resolveSettings } from '../settings/store.js';
import { ticketReference, type TicketRow } from './model.js';
import {
  assigneeRefusal,
  canBeAssigned,
  exceededLimits,
  findPath,
  ticketLimits,
  type NewTicket,
  type ProfileRow,
} from './rules.js';

/*
 * The checks of a list of tickets written in the file format (06, section 4.6), shared by the
 * owner's import (lot 5bis step A) and `plan_propose` (06, section 4.4; owner's answer 11, lot 5
 * step E1b): the owner's form rules, the keys, the assignees, the dependencies and their cycles.
 * Problems come back as data, each located by the ticket's position (from 1) and key and by the
 * field; the import words them for the owner, `plan_propose` for the agent.
 */

/** Where a problem is: all null for the list as a whole. */
export interface Located {
  position: number | null;
  key: string | null;
  field: string | null;
}

export type TicketProblem = Located &
  (
    | { code: 'too_many'; count: number; max: number }
    | { code: 'duplicate_key'; earlier: number }
    | { code: 'limit'; limit: LimitExceeded }
    | { code: 'assignee'; refusal: string; assignable: string }
    | { code: 'blocks_itself'; item: string }
    | { code: 'unknown_key'; item: string }
    | { code: 'other_project'; item: string; project: string }
    | { code: 'unknown_ticket'; item: string }
    /** A ticket number in a plan for a new project, which has no tickets yet. */
    | { code: 'no_project'; item: string }
    | { code: 'not_a_reference'; item: string; project: string | null }
    | { code: 'cycle'; label: string }
  );

/** A ticket of the list, ready to create. */
export interface PlannedTicket {
  key: string;
  ticket: NewTicket;
  /** Keys of the list it waits for, and existing tickets of the project. */
  fileBlockers: string[];
  existingBlockers: TicketRow[];
}

/** The fields the checks read: those of the file format. */
export type CheckedEntry = Pick<
  TicketImportEntry,
  | 'key'
  | 'type'
  | 'title'
  | 'description'
  | 'acceptance_criteria'
  | 'priority'
  | 'assignee'
  | 'blocked_by'
>;

/**
 * Checks the tickets against the project (null for a new project's plan) and the current
 * settings, writing nothing. With no project, **Most tickets per plan** is the global value.
 * `executor` is the caller's transaction, under the project's lock when it then creates them.
 */
export async function checkTickets(
  executor: Executor,
  project: ProjectRow | null,
  entries: readonly CheckedEntry[],
): Promise<{ problems: TicketProblem[]; planned: PlannedTicket[]; profiles: ProfileRow[] }> {
  const problems: TicketProblem[] = [];
  const at = (index: number, field: string | null): Located => ({
    position: index + 1,
    key: entries[index]?.key ?? null,
    field,
  });

  const { maxTicketsPerPlan } = await resolveSettings(
    executor,
    ['maxTicketsPerPlan'],
    project?.id,
  );
  if (entries.length > maxTicketsPerPlan) {
    problems.push({
      position: null,
      key: null,
      field: 'tickets',
      code: 'too_many',
      count: entries.length,
      max: maxTicketsPerPlan,
    });
  }

  // Keys: unique in the list.
  const positionOf = new Map<string, number>();
  entries.forEach((entry, index) => {
    const earlier = positionOf.get(entry.key);
    if (earlier === undefined) positionOf.set(entry.key, index);
    else problems.push({ ...at(index, 'key'), code: 'duplicate_key', earlier: earlier + 1 });
  });

  // The owner's form limits.
  const limits = await ticketLimits(executor);
  entries.forEach((entry, index) => {
    for (const limit of exceededLimits(limits, {
      title: entry.title,
      description: entry.description ?? '',
      acceptanceCriteria: entry.acceptance_criteria ?? [],
    })) {
      const field = limit.field === 'acceptance_criterion' ? 'acceptance_criteria' : limit.field;
      problems.push({ ...at(index, field), code: 'limit', limit });
    }
  });

  // Assignees: existing profiles that can be assigned.
  const profiles = await executor.select().from(schema.agentProfiles);
  const profileByKey = new Map(profiles.map((row) => [row.key, row]));
  const assignable = profiles
    .filter(canBeAssigned)
    .map((row) => `${row.key} (${row.name})`)
    .join(', ');
  entries.forEach((entry, index) => {
    if (!entry.assignee) return;
    const refused = assigneeRefusal(entry.assignee, profileByKey.get(entry.assignee));
    if (refused) {
      problems.push({
        ...at(index, 'assignee'),
        code: 'assignee',
        refusal: refused.message,
        assignable,
      });
    }
  });

  // Dependencies: keys of the list, or tickets of this project.
  const prefix = project === null ? null : `${project.key}-`;
  const references = new Set<number>();
  for (const entry of entries) {
    for (const item of entry.blocked_by ?? []) {
      if (prefix !== null && TicketReference.safeParse(item).success && item.startsWith(prefix)) {
        references.add(Number(item.slice(prefix.length)));
      }
    }
  }
  const existing =
    project === null || references.size === 0
      ? []
      : await executor
          .select()
          .from(schema.tickets)
          .where(
            and(
              eq(schema.tickets.projectId, project.id),
              inArray(schema.tickets.number, [...references]),
            ),
          );
  const existingByNumber = new Map(existing.map((row) => [row.number, row]));

  const planned: PlannedTicket[] = entries.map((entry, index) => {
    const fileBlockers: string[] = [];
    const existingBlockers: TicketRow[] = [];
    for (const item of new Set(entry.blocked_by ?? [])) {
      const here = at(index, 'blocked_by');
      if (TicketKey.safeParse(item).success) {
        if (item === entry.key) problems.push({ ...here, code: 'blocks_itself', item });
        else if (!positionOf.has(item)) problems.push({ ...here, code: 'unknown_key', item });
        else fileBlockers.push(item);
      } else if (TicketReference.safeParse(item).success) {
        if (project === null || prefix === null) {
          problems.push({ ...here, code: 'no_project', item });
          continue;
        }
        const row = item.startsWith(prefix)
          ? existingByNumber.get(Number(item.slice(prefix.length)))
          : undefined;
        if (!item.startsWith(prefix)) {
          problems.push({ ...here, code: 'other_project', item, project: project.key });
        } else if (!row) {
          problems.push({ ...here, code: 'unknown_ticket', item });
        } else {
          existingBlockers.push(row);
        }
      } else {
        problems.push({ ...here, code: 'not_a_reference', item, project: project?.key ?? null });
      }
    }
    const assignee = entry.assignee ? (profileByKey.get(entry.assignee) ?? null) : null;
    return {
      key: entry.key,
      ticket: {
        type: entry.type,
        title: entry.title,
        description: entry.description ?? '',
        acceptanceCriteria: entry.acceptance_criteria ?? [],
        priority: entry.priority ?? 'normal',
        assignee,
      },
      fileBlockers,
      existingBlockers,
    };
  });

  // No cycle, inside the list or through the project's tickets: the graph as it would be.
  const node = (key: string) => `file:${key}`;
  const projectEdges =
    project === null
      ? []
      : await executor
          .select({
            ticketId: schema.ticketDependencies.ticketId,
            blockedById: schema.ticketDependencies.blockedById,
          })
          .from(schema.ticketDependencies)
          .where(eq(schema.ticketDependencies.projectId, project.id));
  const edges = [
    ...projectEdges,
    ...planned.flatMap((each) => [
      ...each.fileBlockers.map((key) => ({ ticketId: node(each.key), blockedById: node(key) })),
      ...each.existingBlockers.map((row) => ({ ticketId: node(each.key), blockedById: row.id })),
    ]),
  ];
  const numberById = new Map<string, number>();
  if (project !== null && projectEdges.length > 0) {
    const rows = await executor
      .select({ id: schema.tickets.id, number: schema.tickets.number })
      .from(schema.tickets)
      .where(eq(schema.tickets.projectId, project.id));
    for (const row of rows) numberById.set(row.id, row.number);
  }
  const name = (id: string) =>
    id.startsWith('file:')
      ? id.slice('file:'.length)
      : ticketReference(project?.key ?? '', numberById.get(id) ?? 0);
  const cycles = new Set<string>();
  planned.forEach((each, index) => {
    for (const key of each.fileBlockers) {
      const path = findPath(edges, node(key), node(each.key));
      if (path === null) continue;
      // Each cycle once, on its first ticket in the list.
      const members = [node(each.key), ...path.slice(0, -1)];
      const first = members.reduce((best, id) =>
        (positionOf.get(name(id)) ?? Infinity) < (positionOf.get(name(best)) ?? Infinity)
          ? id
          : best,
      );
      const start = members.indexOf(first);
      const loop = [...members.slice(start), ...members.slice(0, start)];
      const label = [...loop, first].map(name).join(' → ');
      if (cycles.has(label)) continue;
      cycles.add(label);
      problems.push({
        ...at(positionOf.get(name(first)) ?? index, 'blocked_by'),
        code: 'cycle',
        label,
      });
    }
  });

  return { problems, planned, profiles };
}
