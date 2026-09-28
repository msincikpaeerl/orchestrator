import { z } from 'zod';
import { CommitSummary, GitHash } from '../daemon/git.js';
import { DodReport } from '../mcp/dod-report.js';
import { AgentKey, AgentLink } from './agents.js';

/** Ticket types; the Definition of Done depends on them (04, section 3.3). */
export const TicketType = z.enum(['feature', 'bug', 'chore', 'docs', 'spike']);
export type TicketType = z.infer<typeof TicketType>;

/** Ticket states, in board order (04, section 1). `done` and `cancelled` are terminal. */
export const TicketStatus = z.enum([
  'proposed',
  'todo',
  'in_progress',
  'waiting_human',
  'in_review',
  'awaiting_merge',
  'done',
  'cancelled',
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketPriority = z.enum(['low', 'normal', 'high']);
export type TicketPriority = z.infer<typeof TicketPriority>;

/** Who created a ticket: the owner, or an agent with `ticket_create` (01, section 3.4). */
export const TicketCreator = z.enum(['owner', 'agent']);
export type TicketCreator = z.infer<typeof TicketCreator>;

export const CommentKind = z.enum(['note', 'question', 'answer', 'review', 'status_change']);
export type CommentKind = z.infer<typeof CommentKind>;

/** Who wrote a comment (01, section 3.5); an agent's comment also names its profile and run. */
export const CommentAuthor = z.enum(['owner', 'system', 'agent']);
export type CommentAuthor = z.infer<typeof CommentAuthor>;

/**
 * What the owner can do to a ticket's status (04, section 2). Every other transition is made by
 * the system, the scheduler or an agent, from later lots.
 */
export const OwnerTicketAction = z.enum(['cancel', 'mark_done', 'reopen', 'accept', 'reject']);
export type OwnerTicketAction = z.infer<typeof OwnerTicketAction>;

const NON_TERMINAL = TicketStatus.options.filter(
  (status) => status !== 'done' && status !== 'cancelled',
);

/**
 * The owner's transitions of 04, section 2: the server applies them, the UI offers each one only
 * from its states.
 */
export const OWNER_TRANSITIONS: Readonly<
  Record<OwnerTicketAction, { label: string; from: readonly TicketStatus[]; to: TicketStatus }>
> = {
  cancel: { label: 'Cancel', from: NON_TERMINAL, to: 'cancelled' },
  mark_done: {
    label: 'Mark as done manually',
    from: ['todo', 'in_progress', 'waiting_human', 'in_review', 'awaiting_merge'],
    to: 'done',
  },
  reopen: { label: 'Reopen', from: ['cancelled'], to: 'todo' },
  /** Only for a ticket an agent created (04, section 2). */
  accept: { label: 'Accept', from: ['proposed'], to: 'todo' },
  reject: { label: 'Reject', from: ['proposed'], to: 'cancelled' },
};

/** The agent that created a ticket or wrote a comment, with its run. */
export const AgentAuthorship = z.object({ profile: AgentLink, runId: z.uuid() });
export type AgentAuthorship = z.infer<typeof AgentAuthorship>;

/** States in which a ticket's fields and dependencies can change (02, section 6.4). */
export const EDITABLE_STATUSES: readonly TicketStatus[] = ['proposed', 'todo'];

/**
 * States in which "blocked" is shown to the owner (04, section 1): the ticket has not started,
 * and its dependencies can still be changed (owner's decision, lot 1 step F).
 */
export const BLOCKABLE_STATUSES: readonly TicketStatus[] = EDITABLE_STATUSES;

/** A ticket's number within its project: `12` in `WEB-12`. */
export const TicketNumber = z.int().min(1).max(2_147_483_647);

/** A ticket's human number with its project key, as agents and logs name it: `WEB-12`. */
export const TicketReference = z
  .string()
  .regex(/^[A-Z]{2,6}-[1-9][0-9]{0,9}$/, 'must be a ticket number such as WEB-12');
export type TicketReference = z.infer<typeof TicketReference>;

/**
 * Text fields are checked for structure here; their length limits are settings of the server
 * (04, section 8), checked there.
 */
const Title = z.string().trim().min(1, 'cannot be empty');
const Description = z.string().trim();
const AcceptanceCriteria = z.array(z.string().trim().min(1, 'cannot be empty'));
const CommentBody = z.string().trim().min(1, 'cannot be empty');

/** Another ticket of the same project, as a dependency list shows it. */
export const TicketLink = z.object({
  number: z.int(),
  title: z.string(),
  status: TicketStatus,
});
export type TicketLink = z.infer<typeof TicketLink>;

/** A ticket as the board shows it (02, section 6.3). */
export const TicketSummary = z.object({
  id: z.uuid(),
  projectKey: z.string(),
  number: z.int(),
  type: TicketType,
  title: z.string(),
  priority: TicketPriority,
  status: TicketStatus,
  /** Derived: at least one ticket it depends on is not `done` (01, section 3.4). */
  blocked: z.boolean(),
  /** The agent profile expected to do the work; any profile until lot 6 (01, section 3.4). */
  assignee: AgentLink.nullable(),
  createdBy: TicketCreator,
  /** For a ticket created by an agent ("created by agent"): its profile and run. */
  createdByAgent: AgentAuthorship.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TicketSummary = z.infer<typeof TicketSummary>;

/** `GET /api/projects/:key/tickets`: every ticket of the project, in board order. */
export const TicketListResponse = z.object({ tickets: z.array(TicketSummary) });
export type TicketListResponse = z.infer<typeof TicketListResponse>;

export const Comment = z.object({
  id: z.uuid(),
  author: CommentAuthor,
  /** For an agent's comment: its profile and run. */
  agent: AgentAuthorship.nullable(),
  kind: CommentKind,
  /** Markdown, rendered sanitized (01, section 3.5). */
  body: z.string(),
  /** For an `answer`, the question it answers. */
  answers: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Comment = z.infer<typeof Comment>;

/** The ticket page's timeline (02, section 6.4), oldest first. */
export const TimelineEntry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('comment'), at: z.iso.datetime(), comment: Comment }),
  z.object({
    type: z.literal('status_change'),
    at: z.iso.datetime(),
    actor: z.enum(['owner', 'system', 'agent']),
    from: TicketStatus,
    to: TicketStatus,
    /** The `status_change` comment written with it, for **Mark as done manually**. */
    commentId: z.uuid().nullable(),
  }),
]);
export type TimelineEntry = z.infer<typeof TimelineEntry>;

/** `GET /api/projects/:key/tickets/:number` (02, section 6.4). */
export const TicketDetail = TicketSummary.extend({
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  /** Tickets this one waits for. */
  blockedBy: z.array(TicketLink),
  /** Tickets waiting for this one. */
  blocks: z.array(TicketLink),
  timeline: z.array(TimelineEntry),
  /** Failed attempts, for the retry policy (01, section 3.4; 04, section 5). */
  attemptCount: z.int().min(0),
  /**
   * The ticket branch, set at the first run. Until pushing exists (lot 3) it lives only on the
   * machine of the last run that reported it, with its head and the commits ahead of the base
   * branch (01, section 3.4); `machine` is null before any report.
   */
  branch: z
    .object({
      name: z.string(),
      machine: z.object({ id: z.uuid(), name: z.string() }).nullable(),
      head: GitHash.nullable(),
      commits: z.array(CommitSummary),
    })
    .nullable(),
  /** The latest Definition of Done report accepted from an agent (04, section 3.1). */
  dodReport: DodReport.nullable(),
});
export type TicketDetail = z.infer<typeof TicketDetail>;

/** Created by the owner, in `todo` (04, section 2). */
export const CreateTicketRequest = z.strictObject({
  type: TicketType,
  title: Title,
  description: Description.default(''),
  acceptanceCriteria: AcceptanceCriteria.default([]),
  priority: TicketPriority.default('normal'),
  /** Numbers of tickets of the same project this one depends on. */
  blockedBy: z.array(TicketNumber).default([]),
  /** Key of an agent profile; none by default. */
  assignee: AgentKey.nullable().default(null),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequest>;

/** Only in `proposed` and `todo` (02, section 6.4). Dependencies have their own requests. */
export const UpdateTicketRequest = z
  .strictObject({
    type: TicketType,
    title: Title,
    description: Description,
    acceptanceCriteria: AcceptanceCriteria,
    priority: TicketPriority,
    /** Key of an agent profile, or null to leave the ticket unassigned. */
    assignee: AgentKey.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'nothing to change',
  });
export type UpdateTicketRequest = z.infer<typeof UpdateTicketRequest>;

/** `POST /api/projects/:key/tickets/:number/dependencies`: this ticket waits for `blockedBy`. */
export const AddDependencyRequest = z.strictObject({ blockedBy: TicketNumber });
export type AddDependencyRequest = z.infer<typeof AddDependencyRequest>;

/** An owner note (01, section 3.5). */
export const AddCommentRequest = z.strictObject({ body: CommentBody });
export type AddCommentRequest = z.infer<typeof AddCommentRequest>;

/** **Mark as done manually**: the comment explaining why is mandatory (04, section 2). */
export const MarkDoneRequest = z.strictObject({ comment: CommentBody });
export type MarkDoneRequest = z.infer<typeof MarkDoneRequest>;

/** The owner's answer to the ticket's open question (04, section 6). */
export const AnswerRequest = z.strictObject({ body: CommentBody });
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** **Reject** of a ticket an agent created: the comment is optional (04, section 2). */
export const RejectRequest = z.strictObject({ comment: CommentBody.optional() });
export type RejectRequest = z.infer<typeof RejectRequest>;
