import { z } from 'zod';
import { CommitSummary, GitHash, PushFailureReason } from '../daemon/git.js';
import { DodCheckResult, DodReport } from '../mcp/dod-report.js';
import { AgentKey, AgentLink } from './agents.js';
import { PullRequestFailure, PullRequestState } from './pull-requests.js';
import { RunCiOutcome } from './ci.js';
import { TicketReview } from './reviews.js';
import { FailureReason, PauseReason, RunStatus } from './run-status.js';

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
export const OwnerTicketAction = z.enum([
  'cancel',
  'mark_done',
  'reopen',
  'accept',
  'reject',
  'request_changes',
  'skip_review',
]);
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
  /**
   * Lot 2, while no Quality run exists: the owner sends finished work back, with a comment (owner's
   * decision, lot 2 step L2). From `awaiting_merge` it comes with lot 3.
   */
  request_changes: { label: 'Request changes', from: ['in_review'], to: 'todo' },
  /**
   * The owner moves work on without Quality's review, while no review run is active (04, section
   * 2; owner's decision, lot 3 step A; lot 3 step H2).
   */
  skip_review: { label: 'Skip review', from: ['in_review'], to: 'awaiting_merge' },
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
  /** The ticket's active run, for the board's indicator (02, section 6.3); null without one. */
  activeRun: z
    .object({
      id: z.uuid(),
      status: RunStatus,
      pauseReason: PauseReason.nullable(),
      machine: z.object({ id: z.uuid(), name: z.string(), online: z.boolean() }),
      /** The progress line as shown (06, section 4.2); null before the first. */
      progress: z.object({ text: z.string(), at: z.iso.datetime() }).nullable(),
      /** Its work accepted, it waits for CI on GitHub (lot 3 step G1b). */
      waitingForCi: z.boolean(),
    })
    .nullable(),
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
/**
 * Where the ticket branch's commits are (02, section 6.4; lot 3 step D3), from the last branch a
 * run reported and the last push the daemon reported as done. The server never reads GitHub's
 * branch here: "pushed" says what was pushed and when, not what GitHub holds now.
 */
export const BranchWhere = z.enum([
  /** No commits reported, nothing pushed. */
  'no_commits',
  /** Commits only on a machine: nothing of them pushed. */
  'machine',
  /** Every commit reported was pushed. */
  'github',
  /** Some commits pushed, newer ones only on a machine. */
  'machine_ahead',
  /** Commits only on a machine, and its last push refused: GitHub's branch has others. */
  'diverged',
]);
export type BranchWhere = z.infer<typeof BranchWhere>;

const MachineLink = z.object({ id: z.uuid(), name: z.string() });

export const TicketBranch = z.object({
  name: z.string(),
  where: BranchWhere,
  /** The machine of the last run that reported the branch; null before any report. */
  machine: MachineLink.nullable(),
  /** That report's head and its commits ahead of the base branch, newest first. */
  head: GitHash.nullable(),
  commits: z.array(CommitSummary),
  /**
   * The commits of that report not on GitHub: those the machine said were on no branch fetched
   * from GitHub and no push held. Only on `machine`; never from a review run.
   */
  notOnGitHub: z.array(GitHash),
  /** How many: the listed ones plus those beyond the report's ceiling, which count as not on GitHub. */
  notOnGitHubCount: z.int().min(0),
  /** The last push done: its head, when, from which machine, and the branch's page on GitHub. */
  pushed: z
    .object({
      head: GitHash,
      at: z.iso.datetime(),
      machine: MachineLink.nullable(),
      url: z.url(),
    })
    .nullable(),
  /** The latest failed push since the last one done; null after a push is done. */
  pushFailure: z
    .object({
      at: z.iso.datetime(),
      machine: MachineLink.nullable(),
      reason: PushFailureReason,
      message: z.string(),
    })
    .nullable(),
});
export type TicketBranch = z.infer<typeof TicketBranch>;

/**
 * The ticket's pull request (02, section 6.4; lot 3 step F4): the one the server last opened,
 * updated or found, with its state as the server saw it then (step J reads it again); whether an
 * accepted submission still waits for it; and the latest failed attempt.
 */
export const TicketPullRequest = z.object({
  opened: z
    .object({ number: z.int().positive(), url: z.url(), state: PullRequestState })
    .nullable(),
  wanted: z.boolean(),
  failure: PullRequestFailure.nullable(),
});
export type TicketPullRequest = z.infer<typeof TicketPullRequest>;

/**
 * The workflow flag of the accepted submission, with its reason (04, section 3.1; lot 3 step F4):
 * `not_kept` for a submission flagged before the reason was kept.
 */
export const WorkflowFlag = z.enum(['changed', 'not_listed', 'not_kept']);
export type WorkflowFlag = z.infer<typeof WorkflowFlag>;

/**
 * The ticket page's CI line (02, section 6.4; owner's answers, lot 3 step G2c): what the ticket's
 * latest run with a wait for CI came to (a run that ended after a round sent back counts), and
 * whether **Check CI again** is offered. Null while none, and while a later run works without
 * having handed work in.
 */
export const TicketCi = z.object({
  runId: z.uuid(),
  attempt: z.int().positive(),
  machine: z.object({ id: z.uuid(), name: z.string() }),
  /** The run's end; null while it waits. */
  failureReason: FailureReason.nullable(),
  endedAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  /** **CI wait at submission** and **Most CI failures per run** as the run kept them. */
  waitMinutes: z.int().positive().nullable(),
  maxCiFailures: z.int().positive().nullable(),
  /** The pull request's base branch, named by a conflict. */
  base: z.string().nullable(),
  outcome: RunCiOutcome,
  /** After `ci_timeout` without a conflict, and `ci_failed` on a failure, with no run active. */
  checkCiAgain: z.boolean(),
});
export type TicketCi = z.infer<typeof TicketCi>;

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
  /** The ticket branch, set at the first run, and where its commits are (01, section 3.4). */
  branch: TicketBranch.nullable(),
  /**
   * The latest Definition of Done report accepted from an agent (04, section 3.1). Agent text,
   * credentials masked.
   */
  dodReport: DodReport.nullable(),
  /** Each check's result of that submission; null when accepted before 0.4.0, or none. */
  dodChecks: z.array(DodCheckResult).nullable(),
  /** Its workflow flag; null when not raised. */
  workflowFlag: WorkflowFlag.nullable(),
  pullRequest: TicketPullRequest,
  ci: TicketCi.nullable(),
  /** The latest review, and **Start review** and **Skip review** offered (lot 3 step H4). */
  review: TicketReview,
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

/** **Request changes**: the comment saying what to change is mandatory (04, section 2). */
export const RequestChangesRequest = z.strictObject({ comment: CommentBody });
export type RequestChangesRequest = z.infer<typeof RequestChangesRequest>;

/** The owner's answer to the ticket's open question (04, section 6). */
export const AnswerRequest = z.strictObject({ body: CommentBody });
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** **Reject** of a ticket an agent created: the comment is optional (04, section 2). */
export const RejectRequest = z.strictObject({ comment: CommentBody.optional() });
export type RejectRequest = z.infer<typeof RejectRequest>;
