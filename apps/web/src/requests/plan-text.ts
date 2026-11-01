import type {
  PlanBlocker,
  PlanTicketView,
  PlanView,
  RequestProject,
  TicketImportProblem,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { statusLabel } from '../tickets/text';

// The words of the plan review (02, sections 4 and 5.3; owner's answers 12 and 13 of lot 5 step F,
// answers 3 to 7 of step F2).

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** "A, B and C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Needs you's heading: "Plan to review for request 7 (TESTB): <first line>". */
export function planToReviewHeading(request: {
  number: number;
  line: string;
  project: RequestProject;
}): string {
  const project = request.project === null ? 'new project' : request.project.key;
  return `Plan to review for request ${String(request.number)} (${project}): ${request.line}`;
}

/** "The Project Manager proposed 4 tickets at <time>." */
export function planToReviewText(ticketCount: number, since: string): string {
  return `The Project Manager proposed ${plural(ticketCount, 'ticket')} at ${formatDateTime(since)}.`;
}

/** **Approve**'s confirmation (owner's answer 12, step F). */
export function approveText(ticketCount: number, projectKey: string): string {
  return `It creates ${plural(ticketCount, 'ticket')} in ${projectKey}, in To do. The scheduler starts them by themselves as machines are free: each one uses Claude Code sessions.`;
}

/**
 * **Approve**'s confirmation for a plan creating a project (owner's answer 6, step G); the
 * repository is `<account>/<name>`, or its name alone when the account is not known.
 */
export function approveNewProjectText(input: {
  ticketCount: number;
  name: string;
  key: string;
  repository: string;
  private: boolean;
}): string {
  return `It creates the project ${input.name} (${input.key}) and its ${input.private ? 'private' : 'public'} repository ${input.repository} on GitHub with the starting files, then ${plural(input.ticketCount, 'ticket')} in ${input.key}, in To do. They wait for the project's setup; then the scheduler starts them by themselves as machines are free: each one uses Claude Code sessions.`;
}

/** Why **Approve** is not offered (owner's answer 5, step F2); null when it is. */
export function notApprovableText(
  project: { key: string; archived: boolean } | null,
): string | null {
  if (project?.archived) {
    return `${project.key} is archived: its plan cannot be approved. Reject it with feedback, or close the request.`;
  }
  return null;
}

/** "CONTACT (Contact form)": a ticket of the plan, by its key. */
export function planTicketName(ticket: { key: string; title: string }): string {
  return `${ticket.key} (${ticket.title})`;
}

/** What a plan ticket waits for, as the page lists it. */
export function blockerText(blocker: PlanBlocker): string {
  if (blocker.kind === 'plan') return planTicketName(blocker);
  if (blocker.title === null || blocker.status === null) {
    return `${blocker.reference} (no such ticket in the project)`;
  }
  return `${blocker.reference} (${blocker.title}, ${statusLabel[blocker.status].toLowerCase()})`;
}

/** The value a dependency is sent as: a key of the plan, or a ticket of the project (`WEB-3`). */
export function blockerValue(blocker: PlanBlocker): string {
  return blocker.kind === 'plan' ? blocker.key : blocker.reference;
}

/** The tickets of the plan that wait for this one. */
export function waitingFor(plan: Pick<PlanView, 'tickets'>, key: string): PlanTicketView[] {
  return plan.tickets.filter((each) =>
    each.waitsFor.some((blocker) => blocker.kind === 'plan' && blocker.key === key),
  );
}

/** **Remove**'s confirmation (owner's answer 4, step F2): its title and sentences. */
export function removeTexts(
  plan: Pick<PlanView, 'tickets'>,
  ticket: { key: string; title: string },
): { title: string; lines: string[] } {
  const waiting = waitingFor(plan, ticket.key).map((each) => each.key);
  const lines: string[] = [];
  if (waiting.length === 1) lines.push(`${waiting[0] ?? ''} waits for it: it will no longer.`);
  if (waiting.length > 1) lines.push(`${listText(waiting)} wait for it: they will no longer.`);
  lines.push(
    'A removed ticket cannot be added back: to get it again, reject the plan with feedback.',
  );
  return { title: `Remove ${planTicketName(ticket)} from the plan?`, lines };
}

/** **Close request**'s confirmation (owner's answer 3, step F2): its sentences. */
export function closeTexts(request: { runActive: boolean; planProposed: boolean }): string[] {
  return [
    'It is final: the request cannot be reopened. Submit a new request to ask again.',
    ...(request.runActive
      ? ['Its planning run stops now; this does not count as a failed attempt.']
      : []),
    ...(request.planProposed ? ['Its proposed plan is rejected: no ticket is created.'] : []),
    'You can still add comments.',
  ];
}

/** An earlier plan's folded line (owner's answer 7, step F2). */
export function earlierPlanHeading(plan: Pick<PlanView, 'status' | 'proposedAt' | 'decidedAt'>) {
  const proposed = `Proposed at ${formatDateTime(plan.proposedAt)}`;
  const decided = plan.decidedAt === null ? '' : ` at ${formatDateTime(plan.decidedAt)}`;
  return plan.status === 'superseded'
    ? `${proposed}, rejected with your feedback${decided}`
    : `${proposed}, rejected${decided}`;
}

/** Where a problem of the plan is: "Ticket “contact”, field title", or "The plan". */
export function planProblemPlace(problem: TicketImportProblem): string {
  const ticket =
    problem.key !== null
      ? `Ticket “${problem.key}”`
      : problem.position !== null
        ? `Ticket ${String(problem.position)}`
        : 'The plan';
  return problem.field === null ? ticket : `${ticket}, field ${problem.field}`;
}
