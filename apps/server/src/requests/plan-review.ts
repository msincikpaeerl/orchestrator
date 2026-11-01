import { schema } from '@orchestrator/db';
import {
  PlanNewProject,
  PlanStatus,
  PlanTickets,
  TicketKey,
  TicketStatus,
  type LimitExceeded,
  type PlanBlocker,
  type PlanTicket,
  type PlanView,
  type SettingName,
  SETTINGS,
  type TicketImportProblem,
  type UpdatePlanTicketRequest,
} from '@orchestrator/protocol';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError } from '../http.js';
import type { ProjectRow } from '../projects/model.js';
import { ticketReference, type TicketRow } from '../tickets/model.js';
import { completeOwnerTicket, insertNumberedTicket } from '../tickets/rules.js';
import { checkTickets, type CheckedEntry, type TicketProblem } from '../tickets/ticket-checks.js';
import { changeRequestStatus, requestEntity, type RequestRow } from './model.js';

/*
 * The owner's review of a plan (01, section 3.3; 02, section 5.3; owner's answers, lot 5 step F):
 * the plan as the request page shows it, the edits and removals of its tickets, **Approve** for an
 * existing project and **Reject with feedback**. Every write names the plan and is refused once it
 * is no longer the request's proposed plan; each writes its event. The callers hold the locks:
 * the project's row first (when there is one), then the request's, then the plan's.
 */

export type PlanRow = typeof schema.plans.$inferSelect;

/** The request's proposed plan, locked, if it is `planId`; refused otherwise (answer 14). */
export async function proposedPlan(
  tx: Executor,
  request: RequestRow,
  planId: string,
): Promise<PlanRow> {
  if (request.status === 'closed') throw requestClosed();
  const [plan] = await tx
    .select()
    .from(schema.plans)
    .where(and(eq(schema.plans.id, planId), eq(schema.plans.requestId, request.id)))
    .for('update');
  if (!plan || plan.status !== 'proposed' || request.status !== 'plan_proposed') {
    throw new HttpError(
      409,
      'plan_not_proposed',
      'This plan is no longer the plan to review: it was approved, rejected or replaced',
    );
  }
  return plan;
}

export const requestClosed = () =>
  new HttpError(409, 'request_closed', 'This request is closed: nothing changes on it any more');

function ticketsOf(plan: Pick<PlanRow, 'tickets'>): PlanTicket[] {
  return PlanTickets.parse(plan.tickets);
}

// ------------------------------------------------------------------------------------------------
// The plans on the request page

/** The request's current plan (`proposed` or `approved`) and its earlier ones, newest first. */
export async function planViews(
  executor: Executor,
  request: RequestRow,
): Promise<{ plan: PlanView | null; earlierPlans: PlanView[] }> {
  const plans = await executor
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.requestId, request.id))
    .orderBy(desc(schema.plans.createdAt), desc(schema.plans.id));
  if (plans.length === 0) return { plan: null, earlierPlans: [] };
  const project =
    request.projectId === null
      ? null
      : ((
          await executor
            .select({ id: schema.projects.id, key: schema.projects.key })
            .from(schema.projects)
            .where(eq(schema.projects.id, request.projectId))
        )[0] ?? null);
  const profiles = await executor
    .select({ key: schema.agentProfiles.key, name: schema.agentProfiles.name })
    .from(schema.agentProfiles);
  const nameOf = new Map(profiles.map((row) => [row.key, row.name]));

  // The project's tickets the plans wait for, by number.
  const prefix = project === null ? null : `${project.key}-`;
  const numbers = new Set<number>();
  for (const plan of plans) {
    for (const ticket of ticketsOf(plan)) {
      for (const item of ticket.blocked_by) {
        if (prefix !== null && item.startsWith(prefix))
          numbers.add(Number(item.slice(prefix.length)));
      }
    }
  }
  const existing =
    project === null || numbers.size === 0
      ? []
      : await executor
          .select({
            number: schema.tickets.number,
            title: schema.tickets.title,
            status: schema.tickets.status,
          })
          .from(schema.tickets)
          .where(
            and(
              eq(schema.tickets.projectId, project.id),
              inArray(schema.tickets.number, [...numbers].filter(Number.isSafeInteger)),
            ),
          );
  const byNumber = new Map(existing.map((row) => [row.number, row]));

  // The tickets an approval created, in the plan's order (they were numbered in it).
  const approved = plans.find((plan) => plan.status === 'approved');
  const created =
    approved === undefined || project === null
      ? []
      : await executor
          .select({ number: schema.tickets.number })
          .from(schema.tickets)
          .where(eq(schema.tickets.planId, approved.id))
          .orderBy(asc(schema.tickets.number));

  const view = (plan: PlanRow): PlanView => {
    const tickets = ticketsOf(plan);
    const titleOf = new Map(tickets.map((ticket) => [ticket.key, ticket.title]));
    return {
      id: plan.id,
      status: PlanStatus.parse(plan.status),
      summary: plan.summary,
      newProject: plan.newProject === null ? null : PlanNewProject.parse(plan.newProject),
      tickets: tickets.map((ticket, index) => {
        const made = plan.id === approved?.id ? created[index] : undefined;
        return {
          ...ticket,
          assigneeName: ticket.assignee === null ? null : (nameOf.get(ticket.assignee) ?? null),
          waitsFor: ticket.blocked_by.map((item): PlanBlocker => {
            if (TicketKey.safeParse(item).success) {
              return { kind: 'plan', key: item, title: titleOf.get(item) ?? '' };
            }
            const row =
              prefix !== null && item.startsWith(prefix)
                ? byNumber.get(Number(item.slice(prefix.length)))
                : undefined;
            return {
              kind: 'ticket',
              reference: item,
              title: row?.title ?? null,
              status: row ? TicketStatus.parse(row.status) : null,
            };
          }),
          created:
            made === undefined || project === null
              ? null
              : { reference: ticketReference(project.key, made.number), number: made.number },
        };
      }),
      ownerFeedback: plan.ownerFeedback,
      proposedAt: plan.createdAt.toISOString(),
      decidedAt: plan.decidedAt?.toISOString() ?? null,
    };
  };
  const current = plans.find((plan) => plan.status === 'proposed' || plan.status === 'approved');
  return {
    plan: current === undefined ? null : view(current),
    earlierPlans: plans
      .filter((plan) => plan.status === 'superseded' || plan.status === 'rejected')
      .map(view),
  };
}

// ------------------------------------------------------------------------------------------------
// The problems of a plan, in the owner's words (owner's answers 5 and 9)

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** "the setting “Longest ticket title”", as Settings > Limits names it. */
function settingWords(name: SettingName): string {
  return `the setting “${SETTINGS[name].label}”`;
}

const LIMIT_SETTING: Record<LimitExceeded['field'], SettingName> = {
  title: 'ticketTitleMaxLength',
  description: 'ticketDescriptionMaxLength',
  acceptance_criteria: 'ticketMaxAcceptanceCriteria',
  acceptance_criterion: 'acceptanceCriterionMaxLength',
  comment: 'commentMaxLength',
  request: 'ticketDescriptionMaxLength',
};

/** The API's names of a plan ticket's fields, as the edit form sends them. */
const API_FIELD: Record<string, string> = {
  acceptance_criteria: 'acceptanceCriteria',
  blocked_by: 'blockedBy',
};

function limitWords(limit: LimitExceeded, entry: PlanTicket | undefined): string {
  const setting = settingWords(LIMIT_SETTING[limit.field]);
  switch (limit.field) {
    case 'acceptance_criteria':
      return `${String(entry?.acceptance_criteria.length ?? 0)} criteria: at most ${String(limit.max)}, ${setting}`;
    case 'acceptance_criterion': {
      const criterion = entry?.acceptance_criteria[limit.index ?? 0] ?? '';
      return `criterion ${String((limit.index ?? 0) + 1)} is too long: ${String(criterion.length)} characters, at most ${String(limit.max)}, ${setting}`;
    }
    default: {
      const length = (limit.field === 'title' ? entry?.title : entry?.description)?.length ?? 0;
      return `too long: ${String(length)} characters, at most ${String(limit.max)}, ${setting}`;
    }
  }
}

function ownerWords(found: TicketProblem, tickets: readonly PlanTicket[]): TicketImportProblem {
  const entry = found.position === null ? undefined : tickets[found.position - 1];
  const at = {
    position: found.position,
    key: found.key,
    field: found.field === null ? null : (API_FIELD[found.field] ?? found.field),
  };
  const words = (): string => {
    switch (found.code) {
      case 'too_many':
        return `the plan has ${String(found.count)} tickets: at most ${String(found.max)}, ${settingWords('maxTicketsPerPlan')}. Remove some, or reject the plan with feedback`;
      case 'duplicate_key':
        return `the key “${found.key ?? ''}” is already the key of ticket ${String(found.earlier)}`;
      case 'limit':
        return limitWords(found.limit, entry);
      case 'assignee':
        return `${found.refusal}. The agents you can assign are ${found.assignable || 'none'}`;
      case 'blocks_itself':
        return 'a ticket cannot wait for itself';
      case 'unknown_key':
        return `no ticket of the plan has the key “${found.item}”`;
      case 'other_project':
        return `${found.item} belongs to another project: a ticket can only wait for tickets of ${found.project}`;
      case 'unknown_ticket':
        return `there is no ticket ${found.item} in this project`;
      case 'no_project':
        return `${found.item} is a ticket number, but the new project has no tickets yet: wait only for tickets of the plan`;
      case 'not_a_reference':
        return `“${found.item}” is neither a key of this plan nor a ticket number such as ${found.project ?? 'WEB'}-3`;
      case 'cycle':
        return `these tickets wait for each other, so none of them could ever start: ${found.label}. Remove one of these dependencies`;
    }
  };
  return { ...at, message: sentence(words()) };
}

function entries(tickets: readonly PlanTicket[]): CheckedEntry[] {
  return tickets.map((ticket) => ({
    key: ticket.key,
    type: ticket.type,
    title: ticket.title,
    description: ticket.description,
    acceptance_criteria: ticket.acceptance_criteria,
    priority: ticket.priority,
    assignee: ticket.assignee,
    blocked_by: ticket.blocked_by,
  }));
}

/** Every problem of the plan's tickets against the project and the current settings. */
async function planProblems(
  executor: Executor,
  project: ProjectRow | null,
  tickets: readonly PlanTicket[],
) {
  const checked = await checkTickets(executor, project, entries(tickets));
  return {
    ...checked,
    problems: checked.problems.map((found) => ownerWords(found, tickets)),
  };
}

function planInvalid(problems: TicketImportProblem[], what: string): HttpError {
  return new HttpError(
    422,
    'plan_invalid',
    `${what}: the plan has ${String(problems.length)} problem${problems.length === 1 ? '' : 's'}`,
    { planProblems: problems },
  );
}

const bootstrapFixed = (why: string) => new HttpError(422, 'plan_bootstrap_fixed', why);

// ------------------------------------------------------------------------------------------------
// Edits and removal (owner's answers 5 to 8)

type Change = { field: string; from: string | string[] | null; to: string | string[] | null };

/**
 * The owner's edit of one ticket of the proposed plan: refused for the problems it brings (a
 * problem the plan already had, such as a setting lowered since, waits for **Approve**).
 */
export async function editPlanTicket(
  tx: Executor,
  input: {
    request: RequestRow;
    project: ProjectRow | null;
    plan: PlanRow;
    key: string;
    edit: UpdatePlanTicketRequest;
    at: Date;
  },
): Promise<void> {
  const { request, project, plan, key, edit, at } = input;
  const tickets = ticketsOf(plan);
  const index = tickets.findIndex((ticket) => ticket.key === key);
  const ticket = tickets[index];
  if (!ticket) throw planTicketNotFound(key);

  const next: PlanTicket = {
    ...ticket,
    ...(edit.type === undefined ? {} : { type: edit.type }),
    ...(edit.title === undefined ? {} : { title: edit.title }),
    ...(edit.description === undefined ? {} : { description: edit.description }),
    ...(edit.acceptanceCriteria === undefined
      ? {}
      : { acceptance_criteria: edit.acceptanceCriteria }),
    ...(edit.priority === undefined ? {} : { priority: edit.priority }),
    ...(edit.assignee === undefined ? {} : { assignee: edit.assignee }),
    ...(edit.blockedBy === undefined ? {} : { blocked_by: [...new Set(edit.blockedBy)] }),
  };
  const fields: [string, keyof PlanTicket][] = [
    ['type', 'type'],
    ['title', 'title'],
    ['description', 'description'],
    ['acceptanceCriteria', 'acceptance_criteria'],
    ['priority', 'priority'],
    ['assignee', 'assignee'],
    ['blockedBy', 'blocked_by'],
  ];
  const changes: Change[] = fields
    .filter(([, name]) => JSON.stringify(ticket[name]) !== JSON.stringify(next[name]))
    .map(([field, name]) => ({
      field,
      from: ticket[name] as Change['from'],
      to: next[name] as Change['to'],
    }));
  if (changes.length === 0) return;

  // The bootstrap ticket's place in a new project (owner's answer 6).
  const bootstrap = tickets.find((each) => each.bootstrap);
  if (ticket.bootstrap) {
    const fixed = changes.filter((change) =>
      ['type', 'assignee', 'blockedBy'].includes(change.field),
    );
    if (fixed.length > 0) {
      throw bootstrapFixed(
        `The bootstrap ticket's ${fixed.map((change) => (change.field === 'blockedBy' ? 'dependencies' : change.field)).join(' and ')} cannot change: it sets up the new project, assigned to the Architect, and waits for nothing`,
      );
    }
  } else if (bootstrap !== undefined && !next.blocked_by.includes(bootstrap.key)) {
    throw bootstrapFixed(
      `Every ticket of a new project waits for its bootstrap ticket (${bootstrap.key}), which sets the project up`,
    );
  }

  const edited = tickets.map((each, position) => (position === index ? next : each));
  const before = new Set(
    (await planProblems(tx, project, tickets)).problems.map((each) => JSON.stringify(each)),
  );
  const after = await planProblems(tx, project, edited);
  const brought = after.problems.filter((each) => !before.has(JSON.stringify(each)));
  // A new dependency on a cancelled ticket: it would never start (owner's answer 5).
  const added = next.blocked_by.filter((item) => !ticket.blocked_by.includes(item));
  const cancelled =
    after.planned[index]?.existingBlockers.filter(
      (row) =>
        row.status === 'cancelled' &&
        added.includes(ticketReference(project?.key ?? '', row.number)),
    ) ?? [];
  for (const row of cancelled) {
    brought.push({
      position: index + 1,
      key,
      field: 'blockedBy',
      message: `${ticketReference(project?.key ?? '', row.number)} is cancelled: a ticket waiting for it would never start.`,
    });
  }
  if (brought.length > 0) throw planInvalid(brought, `${key} not changed`);

  await tx
    .update(schema.plans)
    .set({ tickets: PlanTickets.parse(edited) })
    .where(eq(schema.plans.id, plan.id));
  await recordEvent(tx, {
    actor: 'owner',
    ...requestEntity(request),
    type: 'plan.ticket_updated',
    payload: {
      request: request.number,
      project: project?.key ?? null,
      planId: plan.id,
      key,
      title: next.title,
      changes,
    },
    at,
  });
}

const planTicketNotFound = (key: string) =>
  new HttpError(404, 'plan_ticket_not_found', `No ticket with the key ${key} in this plan`);

/**
 * **Remove** a ticket from the proposed plan (owner's answer 7): it leaves the `blocked_by` of
 * the tickets that waited for it; the bootstrap ticket and the plan's only ticket stay.
 */
export async function removePlanTicket(
  tx: Executor,
  input: { request: RequestRow; project: ProjectRow | null; plan: PlanRow; key: string; at: Date },
): Promise<void> {
  const { request, project, plan, key, at } = input;
  const tickets = ticketsOf(plan);
  const ticket = tickets.find((each) => each.key === key);
  if (!ticket) throw planTicketNotFound(key);
  if (ticket.bootstrap) {
    throw bootstrapFixed(
      'The bootstrap ticket cannot be removed: it sets the new project up, and every other ticket waits for it',
    );
  }
  if (tickets.length === 1) {
    throw new HttpError(
      409,
      'plan_last_ticket',
      'The only ticket of a plan cannot be removed: reject the plan with feedback, or close the request',
    );
  }
  const left = tickets.filter((each) => each.blocked_by.includes(key)).map((each) => each.key);
  const remaining = tickets
    .filter((each) => each.key !== key)
    .map((each) => ({ ...each, blocked_by: each.blocked_by.filter((item) => item !== key) }));
  await tx
    .update(schema.plans)
    .set({ tickets: PlanTickets.parse(remaining) })
    .where(eq(schema.plans.id, plan.id));
  await recordEvent(tx, {
    actor: 'owner',
    ...requestEntity(request),
    type: 'plan.ticket_removed',
    payload: {
      request: request.number,
      project: project?.key ?? null,
      planId: plan.id,
      key,
      title: ticket.title,
      left,
    },
    at,
  });
}

// ------------------------------------------------------------------------------------------------
// Approve and reject (owner's answers 2, 4, 9 to 11)

/**
 * **Approve** for an existing project (owner's answers 9 and 10): the plan checked again against
 * the current settings and tickets, then its tickets created in `todo`, numbered in its order,
 * each with the plan and the Project Manager's run; the plan `approved`, the request `closed`.
 * Under the project's lock. A plan for a new project waits for step G.
 */
export async function approvePlan(
  tx: Executor,
  input: { request: RequestRow; project: ProjectRow | null; plan: PlanRow; at: Date },
): Promise<TicketRow[]> {
  const { request, project, plan, at } = input;
  if (plan.newProject !== null || project === null) {
    throw new HttpError(
      409,
      'plan_new_project_later',
      'A plan that creates a new project cannot be approved yet: reject it with feedback, or close the request',
    );
  }
  if (project.status === 'archived') {
    throw new HttpError(
      409,
      'project_archived',
      'This project is archived and read-only: unarchive it first',
    );
  }
  const tickets = ticketsOf(plan);
  const checked = await planProblems(tx, project, tickets);
  if (checked.problems.length > 0) throw planInvalid(checked.problems, 'Not approved');

  // The run that proposed it: the request's latest planning run started before the plan.
  const [run] = await tx
    .select({ id: schema.runs.id, profileId: schema.runs.profileId })
    .from(schema.runs)
    .where(and(eq(schema.runs.requestId, request.id), lte(schema.runs.createdAt, plan.createdAt)))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  const origin = { planId: plan.id, profileId: run?.profileId ?? null, runId: run?.id ?? null };

  const rows: TicketRow[] = [];
  for (const each of checked.planned) {
    rows.push(await insertNumberedTicket(tx, project, each.ticket, at, origin));
  }
  const rowByKey = new Map(checked.planned.map((each, index) => [each.key, rows[index]]));
  for (const [index, each] of checked.planned.entries()) {
    const blockers = [
      ...each.fileBlockers.flatMap((key) => {
        const row = rowByKey.get(key);
        return row ? [row] : [];
      }),
      ...each.existingBlockers,
    ];
    const row = rows[index];
    if (!row) throw new Error('ticket not created');
    await completeOwnerTicket(tx, project, row, each.ticket.assignee, blockers, at, {
      planId: plan.id,
      request: request.number,
    });
  }

  await tx
    .update(schema.plans)
    .set({ status: 'approved', decidedAt: at })
    .where(eq(schema.plans.id, plan.id));
  await recordEvent(tx, {
    actor: 'owner',
    ...requestEntity(request),
    type: 'plan.approved',
    payload: {
      request: request.number,
      project: project.key,
      planId: plan.id,
      tickets: checked.planned.map((each, index) => ({
        key: each.key,
        ticket: ticketReference(project.key, rows[index]?.number ?? 0),
      })),
    },
    at,
  });
  await changeRequestStatus(tx, { request, to: 'closed', cause: 'plan_approved', at });
  return rows;
}

/**
 * **Reject with feedback** (owner's answers 2 and 11): the plan `superseded` with the feedback,
 * the request `open` again, its failed attempts unchanged; the scheduler plans it again.
 */
export async function rejectPlan(
  tx: Executor,
  input: {
    request: RequestRow;
    project: ProjectRow | null;
    plan: PlanRow;
    feedback: string;
    at: Date;
  },
): Promise<void> {
  const { request, plan, at } = input;
  await tx
    .update(schema.plans)
    .set({ status: 'superseded', ownerFeedback: input.feedback, decidedAt: at })
    .where(eq(schema.plans.id, plan.id));
  await recordEvent(tx, {
    actor: 'owner',
    ...requestEntity(request),
    type: 'plan.rejected',
    payload: {
      request: request.number,
      project: input.project?.key ?? null,
      planId: plan.id,
      status: 'superseded',
      feedback: input.feedback,
    },
    at,
  });
  await changeRequestStatus(tx, { request, to: 'open', cause: 'plan_rejected', at });
}

/** A proposed plan of a request the owner closes becomes `rejected` (owner's answer 3). */
export async function rejectForClosing(
  tx: Executor,
  input: { request: RequestRow; project: { key: string } | null; at: Date },
): Promise<boolean> {
  const { request, at } = input;
  const [plan] = await tx
    .update(schema.plans)
    .set({ status: 'rejected', decidedAt: at })
    .where(and(eq(schema.plans.requestId, request.id), eq(schema.plans.status, 'proposed')))
    .returning({ id: schema.plans.id });
  if (!plan) return false;
  await recordEvent(tx, {
    actor: 'owner',
    ...requestEntity(request),
    type: 'plan.rejected',
    payload: {
      request: request.number,
      project: input.project?.key ?? null,
      planId: plan.id,
      status: 'rejected',
      feedback: null,
    },
    at,
  });
  return true;
}

/**
 * The latest plan the owner rejected with feedback, for the next planning run's first message
 * (owner's answer 11): the request's latest plan when it is `superseded`.
 */
export async function rejectedPlan(
  executor: Executor,
  requestId: string,
): Promise<{
  summary: string;
  tickets: { key: string; title: string }[];
  feedback: string;
} | null> {
  const [latest] = await executor
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.requestId, requestId))
    .orderBy(desc(schema.plans.createdAt), desc(schema.plans.id))
    .limit(1);
  if (latest?.status !== 'superseded') return null;
  return {
    summary: latest.summary,
    tickets: ticketsOf(latest).map((ticket) => ({ key: ticket.key, title: ticket.title })),
    feedback: latest.ownerFeedback ?? '',
  };
}
