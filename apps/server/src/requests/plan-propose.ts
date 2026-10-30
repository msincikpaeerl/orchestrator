import { schema } from '@orchestrator/db';
import {
  PlanTickets,
  type LimitExceeded,
  type McpToolInput,
  type PlanNewProject,
  type PlanTicket,
  type PlanTicketEntry,
  type ProjectKind,
} from '@orchestrator/protocol';
import type { Template } from '../agents/files.js';
import { part } from '../agents/messages.js';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import type { ProjectRow } from '../projects/model.js';
import { ticketLimits } from '../tickets/rules.js';
import { checkTickets, type TicketProblem } from '../tickets/ticket-checks.js';
import { changeRequestStatus, requestEntity, type RequestRow } from './model.js';

/*
 * `plan_propose` (06, section 4.4; lot 5 step E1b): the plan's checks, in the agent's words from
 * `mcp-tools.md`, and the accepted plan. The tickets are kept on the plan (`plans.tickets`) until
 * the owner approves it (owner's answer 9, lot 5 step E1): nothing is created in the project.
 */

/** A problem of the plan, in the agent's words: its field for `details`, where, and what. */
export interface PlanProblem {
  field: string;
  place: string;
  message: string;
}

/** The bootstrap's part of 08 section 3.2 that only a `web_app` gets (owner's answer 13). */
const WEB_APP_PART = 'web-app';

/**
 * The bootstrap ticket's fixed criteria for a project of this kind (08, section 3.2), in the
 * template's order.
 */
export function fixedCriteria(bootstrap: Template, kind: ProjectKind): string[] {
  return [...bootstrap.parts]
    .filter(([name]) => name !== WEB_APP_PART || kind === 'web_app')
    .map(([, text]) => text.trim());
}

/** Two criteria are the same when only their case and spaces differ (owner's answer 13). */
function sameCriterion(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The setting's name as Settings > Limits shows it, for the refusals. */
const LIMIT_SETTINGS: Record<LimitExceeded['field'], string> = {
  title: 'Longest ticket title',
  description: 'Longest ticket description',
  acceptance_criteria: 'Most acceptance criteria',
  acceptance_criterion: 'Longest acceptance criterion',
  comment: 'Longest comment',
  request: 'Longest ticket description',
};

export type PlanCheck =
  | { accepted: false; problems: PlanProblem[] }
  | {
      accepted: true;
      tickets: PlanTicket[];
      newProject: PlanNewProject | null;
      /** The bootstrap ticket's key and the fixed criteria added to it; null for a project. */
      bootstrap: { key: string; added: string[] } | null;
    };

/**
 * Checks the plan against its request, its project (null for a new project) and the current
 * settings, writing nothing: every problem at once, or the plan as it is kept. The state of the
 * run and the request is the caller's to check first.
 */
export async function checkPlan(
  executor: Executor,
  input: {
    request: RequestRow;
    project: ProjectRow | null;
    plan: McpToolInput<'plan_propose'>;
    texts: Template;
    bootstrap: Template;
  },
): Promise<PlanCheck> {
  const { request, project, plan, texts } = input;
  const number = String(request.number);
  const problems: PlanProblem[] = [];
  const whole = (field: string, message: string) => {
    problems.push({ field, place: `${part(texts, 'plan-place-whole')}, ${field}`, message });
  };
  const atTicket = (position: number, field: string, message: string) => {
    const entry = plan.tickets[position - 1];
    problems.push({
      field: `tickets[${String(position - 1)}].${field}`,
      place: part(texts, 'plan-place-ticket', {
        position: String(position),
        key: entry?.key ?? '',
        field,
      }),
      message,
    });
  };
  const limits = await ticketLimits(executor);

  // The summary, and the project: given for a request without one, never for a request with one.
  if (plan.summary.length > limits.ticketDescriptionMaxLength) {
    whole(
      'summary',
      part(texts, 'plan-too-long', {
        length: String(plan.summary.length),
        max: String(limits.ticketDescriptionMaxLength),
        setting: LIMIT_SETTINGS.description,
      }),
    );
  }
  const forNewProject = request.projectId === null;
  const newProject = plan.new_project ?? null;
  if (forNewProject && newProject === null) {
    whole('new_project', part(texts, 'plan-new-project-missing', { request: number }));
  }
  if (!forNewProject && newProject !== null) {
    whole(
      'new_project',
      part(texts, 'plan-new-project-unwanted', { request: number, project: project?.key ?? '' }),
    );
  }
  if (forNewProject && newProject?.kind === 'android_app') {
    whole('new_project.kind', part(texts, 'plan-android'));
  }

  // The bootstrap ticket (08, section 3.2): exactly one in a new project's plan, none otherwise.
  const bootstraps = plan.tickets.flatMap((entry, index) =>
    entry.bootstrap === true ? [{ entry, position: index + 1 }] : [],
  );
  let bootstrap: { entry: PlanTicketEntry; position: number; added: string[] } | null = null;
  if (!forNewProject) {
    for (const each of bootstraps) {
      atTicket(
        each.position,
        'bootstrap',
        part(texts, 'plan-bootstrap-unwanted', { project: project?.key ?? '' }),
      );
    }
  } else if (bootstraps.length === 0) {
    whole('tickets', part(texts, 'plan-bootstrap-missing'));
  } else if (bootstraps.length > 1) {
    whole(
      'tickets',
      part(texts, 'plan-bootstrap-several', {
        count: String(bootstraps.length),
        keys: bootstraps.map((each) => each.entry.key).join(', '),
      }),
    );
  } else if (bootstraps[0]) {
    const { entry, position } = bootstraps[0];
    if (entry.type !== 'chore') {
      atTicket(position, 'type', part(texts, 'plan-bootstrap-type', { type: entry.type }));
    }
    if (entry.assignee !== 'architect') {
      atTicket(position, 'assignee', part(texts, 'plan-bootstrap-assignee'));
    }
    if ((entry.blocked_by ?? []).length > 0) {
      atTicket(position, 'blocked_by', part(texts, 'plan-bootstrap-blocked'));
    }
    const own = entry.acceptance_criteria ?? [];
    const fixed = fixedCriteria(input.bootstrap, newProject?.kind ?? 'website');
    const longest = Math.max(...fixed.map((text) => text.length));
    const added = fixed.filter(
      (text) => !own.some((mine) => sameCriterion(mine) === sameCriterion(text)),
    );
    if (fixed.length > limits.ticketMaxAcceptanceCriteria) {
      // Settings the agent cannot change (owner's answer 7, lot 5 step E1b).
      atTicket(
        position,
        'acceptance_criteria',
        part(texts, 'plan-bootstrap-settings', {
          setting: LIMIT_SETTINGS.acceptance_criteria,
          value: String(limits.ticketMaxAcceptanceCriteria),
          needed: `${String(fixed.length)} criteria`,
        }),
      );
    } else if (
      own.length <= limits.ticketMaxAcceptanceCriteria &&
      own.length + added.length > limits.ticketMaxAcceptanceCriteria
    ) {
      atTicket(
        position,
        'acceptance_criteria',
        part(texts, 'plan-bootstrap-criteria', {
          count: String(own.length + added.length),
          added: String(added.length),
          max: String(limits.ticketMaxAcceptanceCriteria),
          own: String(limits.ticketMaxAcceptanceCriteria - fixed.length),
        }),
      );
    }
    if (longest > limits.acceptanceCriterionMaxLength) {
      atTicket(
        position,
        'acceptance_criteria',
        part(texts, 'plan-bootstrap-settings', {
          setting: LIMIT_SETTINGS.acceptance_criterion,
          value: String(limits.acceptanceCriterionMaxLength),
          needed: `${String(longest)} characters`,
        }),
      );
    }
    bootstrap = { entry, position, added };
  }

  // The checks shared with the import (owner's answer 11, lot 5 step E1).
  const checked = await checkTickets(executor, project, plan.tickets);
  for (const found of checked.problems) {
    const message = agentWords(texts, found, plan.tickets);
    if (found.position === null) whole(found.field ?? 'tickets', message);
    else atTicket(found.position, found.field ?? 'tickets', message);
  }
  if (problems.length > 0) return { accepted: false, problems };

  // Accepted: the bootstrap first, its fixed criteria after its own, every other ticket waiting
  // for it (owner's answers 5 and 13).
  const first = bootstrap?.entry;
  const ordered =
    first === undefined ? plan.tickets : [first, ...plan.tickets.filter((each) => each !== first)];
  const tickets = PlanTickets.parse(
    ordered.map((entry): PlanTicket => {
      const blockedBy = [...new Set(entry.blocked_by ?? [])];
      const isBootstrap = entry === bootstrap?.entry;
      if (bootstrap !== null && !isBootstrap && !blockedBy.includes(bootstrap.entry.key)) {
        blockedBy.push(bootstrap.entry.key);
      }
      return {
        key: entry.key,
        type: entry.type,
        title: entry.title,
        description: entry.description ?? '',
        acceptance_criteria: [
          ...(entry.acceptance_criteria ?? []),
          ...(isBootstrap ? (bootstrap?.added ?? []) : []),
        ],
        priority: entry.priority ?? 'normal',
        assignee: entry.assignee ?? null,
        blocked_by: blockedBy,
        bootstrap: isBootstrap,
      };
    }),
  );
  return {
    accepted: true,
    tickets,
    newProject:
      newProject === null
        ? null
        : {
            name: newProject.name,
            kind: newProject.kind,
            description: newProject.description ?? '',
          },
    bootstrap: bootstrap === null ? null : { key: bootstrap.entry.key, added: bootstrap.added },
  };
}

/** A problem of the shared checks in the agent's words. */
function agentWords(
  texts: Template,
  found: TicketProblem,
  entries: readonly PlanTicketEntry[],
): string {
  const entry = found.position === null ? undefined : entries[found.position - 1];
  switch (found.code) {
    case 'too_many':
      return part(texts, 'plan-too-many', { count: String(found.count), max: String(found.max) });
    case 'duplicate_key':
      return part(texts, 'plan-duplicate-key', {
        key: found.key ?? '',
        earlier: String(found.earlier),
      });
    case 'limit':
      return limitWords(texts, found.limit, entry);
    case 'assignee':
      return part(texts, 'plan-assignee', {
        refusal: found.refusal,
        assignable: found.assignable || 'none',
      });
    case 'blocks_itself':
      return part(texts, 'plan-blocks-itself', { item: found.item });
    case 'unknown_key':
      return part(texts, 'plan-unknown-key', { item: found.item });
    case 'other_project':
      return part(texts, 'plan-other-project', { item: found.item, project: found.project });
    case 'unknown_ticket':
      return part(texts, 'plan-unknown-ticket', { item: found.item });
    case 'no_project':
      return part(texts, 'plan-no-project-ticket', { item: found.item });
    case 'not_a_reference':
      return found.project === null
        ? part(texts, 'plan-not-a-key', { item: found.item })
        : part(texts, 'plan-not-a-reference', { item: found.item, project: found.project });
    case 'cycle':
      return part(texts, 'plan-cycle', { cycle: found.label });
  }
}

function limitWords(texts: Template, limit: LimitExceeded, entry?: PlanTicketEntry): string {
  const max = String(limit.max);
  switch (limit.field) {
    case 'acceptance_criteria':
      return part(texts, 'plan-too-many-criteria', {
        count: String(entry?.acceptance_criteria?.length ?? 0),
        max,
      });
    case 'acceptance_criterion': {
      const index = limit.index ?? 0;
      return part(texts, 'plan-criterion-too-long', {
        number: String(index + 1),
        length: String(entry?.acceptance_criteria?.[index]?.length ?? 0),
        max,
      });
    }
    default: {
      const text = limit.field === 'title' ? entry?.title : entry?.description;
      return part(texts, 'plan-too-long', {
        length: String(text?.length ?? 0),
        max,
        setting: LIMIT_SETTINGS[limit.field],
      });
    }
  }
}

/**
 * Records the accepted plan (owner's answer 14, lot 5 step E1): the `plans` row, `plan.proposed`,
 * the request `plan_proposed` with its `request.status_changed`. Under the request's lock, taken
 * by the caller with the run's; the run's decision is the caller's.
 */
export async function recordPlan(
  tx: Executor,
  input: {
    request: RequestRow;
    project: ProjectRow | null;
    summary: string;
    accepted: Extract<PlanCheck, { accepted: true }>;
    agent: { key: string; name: string };
    runId: string;
    at: Date;
  },
): Promise<{ plan: typeof schema.plans.$inferSelect; request: RequestRow }> {
  const { accepted, at } = input;
  const [plan] = await tx
    .insert(schema.plans)
    .values({
      requestId: input.request.id,
      summary: input.summary,
      newProject: accepted.newProject,
      tickets: accepted.tickets,
      status: 'proposed',
      createdAt: at,
    })
    .returning();
  if (!plan) throw new Error('plan not inserted');
  await recordEvent(tx, {
    actor: 'agent',
    ...requestEntity(input.request),
    type: 'plan.proposed',
    payload: {
      request: input.request.number,
      project: input.project?.key ?? null,
      planId: plan.id,
      tickets: accepted.tickets.length,
      newProject: accepted.newProject?.name ?? null,
      agent: input.agent.key,
      agentName: input.agent.name,
      runId: input.runId,
    },
    at,
  });
  const request = await changeRequestStatus(tx, {
    request: input.request,
    to: 'plan_proposed',
    cause: 'plan_proposed',
    runId: input.runId,
    at,
  });
  return { plan, request };
}
