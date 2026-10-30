import { z } from 'zod';
import { settingCeiling } from '../text-limits.js';
import { AgentKey } from './agents.js';
import { ProjectDescription, ProjectKind, ProjectName } from './projects.js';
import { TicketImportEntry, TicketKey } from './ticket-import.js';
import { TicketPriority, TicketType } from './tickets.js';

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
