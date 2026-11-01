import { z } from 'zod';
import { settingCeiling } from '../text-limits.js';
import { AgentKey } from './agents.js';
import { ProjectDescription, ProjectKind, ProjectName } from './projects.js';
import { TicketImportEntry, TicketKey } from './ticket-import.js';
import {
  AcceptanceCriteria,
  CommentBody,
  Description,
  TicketPriority,
  TicketStatus,
  TicketType,
  Title,
} from './tickets.js';

// Plans (01, section 3.3; 06, section 4.4; lot 5 step E1b): the Project Manager's answer to a
// request. A plan's tickets are kept on the plan until the owner approves it, which creates them
// in the project (owner's answer 9, lot 5 step E1).

/** A plan's states (01, section 3.3). */
export const PlanStatus = z.enum(['proposed', 'approved', 'rejected', 'superseded']);
export type PlanStatus = z.infer<typeof PlanStatus>;

/**
 * The project a plan creates, as `plan_propose` gives it: the project form's name, kind and
 * description. The key, the repository and its visibility are chosen at approval (step G).
 */
export const PlanNewProjectEntry = z.strictObject({
  name: ProjectName,
  kind: ProjectKind,
  description: ProjectDescription.nullish(),
});
export type PlanNewProjectEntry = z.infer<typeof PlanNewProjectEntry>;

/** The project a plan creates, as stored in `plans.new_project`. */
export const PlanNewProject = z.object({
  name: z.string(),
  kind: ProjectKind,
  description: z.string(),
});
export type PlanNewProject = z.infer<typeof PlanNewProject>;

/**
 * One ticket of `plan_propose`: a ticket of the file format (06, section 4.6) and whether it is
 * the bootstrap ticket of a new project (08, section 3.2); false is the same as absent.
 */
export const PlanTicketEntry = TicketImportEntry.extend({ bootstrap: z.boolean().nullish() });
export type PlanTicketEntry = z.infer<typeof PlanTicketEntry>;

/**
 * One ticket as stored in `plans.tickets` once checked, every field present: `blocked_by` holds
 * keys of the plan and numbers of existing tickets of the project (`WEB-3`, never reused) as the
 * Project Manager gave them, with the bootstrap's key added by the server.
 */
export const PlanTicket = z.object({
  key: TicketKey,
  type: TicketType,
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.array(z.string()),
  priority: TicketPriority,
  assignee: AgentKey.nullable(),
  blocked_by: z.array(z.string()),
  bootstrap: z.boolean(),
});
export type PlanTicket = z.infer<typeof PlanTicket>;

/** `plans.tickets`: at most **Most tickets per plan**, checked by the server. */
export const PlanTickets = z.array(PlanTicket).min(1).max(settingCeiling('maxTicketsPerPlan'));

/**
 * One dependency of a plan ticket as the review shows it (lot 5 step F): a ticket of the plan by
 * its key, or a ticket of the project by its number (`WEB-3`), with its title and status; both
 * null when the project has no such ticket (a plan for a new project names none).
 */
export const PlanBlocker = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), key: TicketKey, title: z.string() }),
  z.object({
    kind: z.literal('ticket'),
    reference: z.string(),
    title: z.string().nullable(),
    status: TicketStatus.nullable(),
  }),
]);
export type PlanBlocker = z.infer<typeof PlanBlocker>;

/** A plan ticket on the request page: as stored, with its assignee's name and its dependencies. */
export const PlanTicketView = PlanTicket.extend({
  assigneeName: z.string().nullable(),
  waitsFor: z.array(PlanBlocker),
  /** The ticket its approval created (`WEB-12`); null before approval. */
  created: z.object({ reference: z.string(), number: z.int().positive() }).nullable(),
});
export type PlanTicketView = z.infer<typeof PlanTicketView>;

/** A plan on the request page (02, section 5.3; lot 5 step F). */
export const PlanView = z.object({
  id: z.uuid(),
  status: PlanStatus,
  summary: z.string(),
  newProject: PlanNewProject.nullable(),
  tickets: z.array(PlanTicketView),
  /** The owner's feedback of **Reject with feedback**; null otherwise. */
  ownerFeedback: z.string().nullable(),
  proposedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type PlanView = z.infer<typeof PlanView>;

/** Every write on a plan names it: refused once it is no longer the request's proposed plan. */
const PlanId = { planId: z.uuid() };

/**
 * `PATCH /api/requests/:number/plan/tickets/:key` (owner's answers 5, 6 and 14, lot 5 step F):
 * the owner's form fields, and `blockedBy`, which replaces the list (keys of the plan, numbers of
 * tickets of the project).
 */
export const UpdatePlanTicketRequest = z
  .strictObject({
    ...PlanId,
    type: TicketType.optional(),
    title: Title.optional(),
    description: Description.optional(),
    acceptanceCriteria: AcceptanceCriteria.optional(),
    priority: TicketPriority.optional(),
    /** Key of an agent profile, or null to leave the ticket unassigned. */
    assignee: AgentKey.nullable().optional(),
    blockedBy: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((value) => Object.keys(value).some((field) => field !== 'planId'), {
    message: 'nothing to change',
  });
export type UpdatePlanTicketRequest = z.infer<typeof UpdatePlanTicketRequest>;

/** **Remove** a ticket of the plan, and **Approve** the plan. */
export const PlanActionRequest = z.strictObject(PlanId);
export type PlanActionRequest = z.infer<typeof PlanActionRequest>;

/** **Reject with feedback**: the feedback, with the comment box's rules (owner's answer 11). */
export const RejectPlanRequest = z.strictObject({ ...PlanId, feedback: CommentBody });
export type RejectPlanRequest = z.infer<typeof RejectPlanRequest>;
