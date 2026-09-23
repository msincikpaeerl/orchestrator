import { z } from 'zod';

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

/** Who created a ticket; agent profiles come with lot 2. */
export const TicketCreator = z.enum(['owner']);
export type TicketCreator = z.infer<typeof TicketCreator>;

export const CommentKind = z.enum(['note', 'question', 'answer', 'review', 'status_change']);
export type CommentKind = z.infer<typeof CommentKind>;

/** Who wrote a comment; agent profiles come with lot 2. */
export const CommentAuthor = z.enum(['owner', 'system']);
export type CommentAuthor = z.infer<typeof CommentAuthor>;

/**
 * What the owner can do to a ticket's status (04, section 2). Every other transition is made by
 * the system, the scheduler or an agent, from later lots.
 */
export const OwnerTicketAction = z.enum(['cancel', 'mark_done', 'reopen']);
export type OwnerTicketAction = z.infer<typeof OwnerTicketAction>;

/** A ticket's number within its project: `12` in `WEB-12`. */
export const TicketNumber = z.int().min(1).max(2_147_483_647);

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
  createdBy: TicketCreator,
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
  kind: CommentKind,
  /** Markdown, rendered sanitized (01, section 3.5). */
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type Comment = z.infer<typeof Comment>;

/** The ticket page's timeline (02, section 6.4), oldest first. */
export const TimelineEntry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('comment'), at: z.iso.datetime(), comment: Comment }),
  z.object({
    type: z.literal('status_change'),
    at: z.iso.datetime(),
    actor: z.enum(['owner', 'system']),
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
