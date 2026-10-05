import { z } from 'zod';
import { AgentKey, AgentRole } from '../api/agents.js';
import { HarnessElement, ProjectKey, ProjectKind } from '../api/projects.js';
import {
  CommentKind,
  TicketPriority,
  TicketReference,
  TicketStatus,
  TicketType,
} from '../api/tickets.js';
import { boundedText, requiredText, settingCeiling } from '../text-limits.js';
import { CiResult } from './ci.js';
import { DodReport } from './dod-report.js';

export { DodReport };

/*
 * Inputs and outputs of the MCP tools of lots 2 and 3 (06, section 4). Field names are snake_case, as in
 * 06. Inputs are strict: a misspelt field is refused with `VALIDATION_FAILED` rather than ignored.
 * Texts are Markdown; tickets are named by their human number (`WEB-12`).
 */

const TITLE_CEILING = settingCeiling('ticketTitleMaxLength');
const DESCRIPTION_CEILING = settingCeiling('ticketDescriptionMaxLength');
const CRITERION_CEILING = settingCeiling('acceptanceCriterionMaxLength');
const CRITERIA_CEILING = settingCeiling('ticketMaxAcceptanceCriteria');
const COMMENT_CEILING = settingCeiling('commentMaxLength');

/**
 * Most characters of one reading tool's output (06, section 4.1): Claude Code refuses MCP outputs
 * above 25,000 tokens, and 40,000 characters is about 10,000 tokens of English, with room for
 * denser text. A constant, not a setting: it follows from Claude Code's limit, as the byte budget
 * of the first message follows from Linux's (04, section 8). Pages hold whole items while they fit;
 * a single text above it is cut at a line boundary with a marker (owner's decision, lot 2 step K).
 */
export const MCP_OUTPUT_MAX_CHARACTERS = 40_000;

/** Most tickets in one page of `ticket_list`. */
export const MCP_TICKET_LIST_PAGE_SIZE = 50;

/** Opaque position in a paged list, returned as `next_cursor` and passed back as `cursor`. */
const Cursor = requiredText();

/** Who created a ticket: the owner, or an agent with `ticket_create`. */
export const McpTicketCreator = z.union([z.literal('owner'), z.object({ agent: AgentKey })]);
export type McpTicketCreator = z.infer<typeof McpTicketCreator>;

export const McpCommentAuthor = z.union([
  z.literal('owner'),
  z.literal('system'),
  z.object({ agent: AgentKey }),
]);
export type McpCommentAuthor = z.infer<typeof McpCommentAuthor>;

export const McpTicketLink = z.object({
  number: TicketReference,
  title: z.string(),
  status: TicketStatus,
});
export type McpTicketLink = z.infer<typeof McpTicketLink>;

export const McpTicketSummary = z.object({
  number: TicketReference,
  type: TicketType,
  title: z.string(),
  status: TicketStatus,
  priority: TicketPriority,
  assignee: AgentKey.nullable(),
  /** At least one ticket it waits for is not `done` (01, section 3.4). */
  blocked: z.boolean(),
});
export type McpTicketSummary = z.infer<typeof McpTicketSummary>;

/** One ticket in full (`ticket_get`, and the result of every write on a ticket). */
export const McpTicket = McpTicketSummary.extend({
  description: z.string(),
  acceptance_criteria: z.array(z.string()),
  blocked_by: z.array(McpTicketLink),
  /** Tickets waiting for this one. */
  blocks: z.array(McpTicketLink),
  created_by: McpTicketCreator,
  /** Latest submitted report; null before the first accepted submission. */
  dod_report: DodReport.nullable(),
  /** Null until a pull request exists (lot 3). */
  pull_request_url: z.url().nullable(),
});
export type McpTicket = z.infer<typeof McpTicket>;

export const McpComment = z.object({
  id: z.uuid(),
  author: McpCommentAuthor,
  kind: CommentKind,
  body: z.string(),
  /** For an `answer`, the question it answers. */
  answers: z.uuid().nullable(),
  created_at: z.iso.datetime(),
});
export type McpComment = z.infer<typeof McpComment>;

const NoInput = z.strictObject({});

/** One MCP tool: its description for the agent, and its input and output. */
export interface McpToolDefinition {
  /** Written for the agent: what it does, when to use it and when not, what happens next. */
  description: string;
  input: z.ZodType;
  output: z.ZodType;
}

/** A point of `review_request_changes`, posted as a `review` comment (06, section 4.5). */
const ReviewPoint = z
  .strictObject({
    body: requiredText(COMMENT_CEILING),
    /** Path relative to the worktree root. */
    file: requiredText().optional(),
    line: z.int().positive().optional(),
  })
  .refine((point) => point.line === undefined || point.file !== undefined, {
    message: 'a line needs its file',
    path: ['file'],
  });

/**
 * The tools of lots 2 and 3, by wire name (`<object>_<verb>`, 06 section 3). The agent sees them as
 * `mcp__orchestrator__<name>`. The descriptions are part of the harness, reviewed like code.
 */
export const MCP_TOOLS = {
  project_get: {
    description:
      'Returns the project you work on: name, kind, repository, default branch, and where its conventions are (CLAUDE.md, user and developer documentation, ADRs). Use it at the start of a run if you need this context; read CLAUDE.md in the worktree first.',
    input: NoInput,
    output: z.object({
      key: ProjectKey,
      name: z.string(),
      description: z.string(),
      kind: ProjectKind,
      repository: z.object({
        owner: z.string(),
        name: z.string(),
        default_branch: z.string(),
      }),
      /** Paths in the worktree, relative to its root. */
      conventions: z.object({
        claude_md: z.string(),
        user_docs: z.string(),
        dev_docs: z.string(),
        adrs: z.string(),
      }),
      /** Harness elements not found at the last check of a linked repository (08, section 3.4). */
      missing: z.array(HarnessElement),
    }),
  },
  ticket_get: {
    description:
      'Returns one ticket in full: description, acceptance criteria, status, assignee, dependencies, latest Definition of Done report and pull request link. Without `ticket`, returns the ticket of your run. Use it to re-read your ticket or to look at a ticket it depends on; use ticket_comments for its discussion.',
    input: z.strictObject({ ticket: TicketReference.optional() }),
    output: z.object({ ticket: McpTicket }),
  },
  ticket_list: {
    description:
      'Lists tickets of the project as summaries, filtered by status, type, assignee or text in the title and description. Results come a page at a time: when `next_cursor` is not null, call again with it as `cursor` for the next page. Use ticket_get for the full ticket.',
    input: z.strictObject({
      status: z.array(TicketStatus).min(1).optional(),
      type: z.array(TicketType).min(1).optional(),
      assignee: AgentKey.optional(),
      text: requiredText().optional(),
      cursor: Cursor.optional(),
    }),
    output: z.object({ tickets: z.array(McpTicketSummary), next_cursor: Cursor.nullable() }),
  },
  ticket_comments: {
    description:
      "Returns a ticket's comments, oldest first: notes, questions and the owner's answers, reviews and status changes. Without `ticket`, returns those of your run's ticket. Results come a page at a time: when `next_cursor` is not null, call again with it as `cursor`.",
    input: z.strictObject({ ticket: TicketReference.optional(), cursor: Cursor.optional() }),
    output: z.object({ comments: z.array(McpComment), next_cursor: Cursor.nullable() }),
  },
  ci_status: {
    description:
      "Returns the CI result of your run's pull request: every GitHub Actions workflow run and commit status of its head commit, with pending, passed or failed, and for each failed job its failed steps and the end of its log. Use it when you need the CI result again; when CI fails after your submission, you receive the same result as a message without asking. Before your ticket has a pull request, `pull_request` and `ci` are null.",
    input: NoInput,
    output: z.object({
      pull_request: z
        .object({ number: z.int().positive(), url: z.url(), head: z.string() })
        .nullable(),
      ci: CiResult.nullable(),
    }),
  },
  agent_list: {
    description:
      'Lists the agent profiles with their key, role and description. Use it to choose the `assignee` of a ticket you create with ticket_create.',
    input: NoInput,
    output: z.object({
      agents: z.array(
        z.object({ key: AgentKey, name: z.string(), role: AgentRole, description: z.string() }),
      ),
    }),
  },
  ticket_progress: {
    description:
      'Sets the short status line the owner sees live for your run, such as "Writing tests for the contact form". It does not create a comment, and it is never refused for being called often: the owner sees the latest line. Call it when you start a new part of the work; calling it more often is harmless but useless.',
    input: z.strictObject({ text: requiredText() }),
    output: z.object({ progress: z.string(), at: z.iso.datetime() }),
  },
  ticket_comment: {
    description:
      "Adds a note to your run's ticket: findings, decisions, anything the owner or the next agent should know. It does not ask anything and does not wait for an answer; to ask the owner, use ticket_ask.",
    input: z.strictObject({ body: requiredText(COMMENT_CEILING) }),
    output: z.object({ comment: McpComment }),
  },
  ticket_ask: {
    description:
      "Asks the owner a question about your run's ticket, when you cannot continue without a decision or something only the owner can give, or when a tool or command you need was refused. The ticket moves to waiting_human. End your turn right after calling it: the owner's answer arrives as your next message.",
    input: z.strictObject({ question: requiredText(COMMENT_CEILING) }),
    output: z.object({ comment: McpComment, ticket: McpTicket }),
  },
  ticket_give_up: {
    description:
      "Declares that your run's ticket cannot be completed, with the reason and what you tried. The run ends as failed and the ticket may be tried again later. Use it only when the work is impossible as specified. Never give up because a command was refused or a question is unanswered; use ticket_ask. End your turn after calling it.",
    input: z.strictObject({
      reason: requiredText(COMMENT_CEILING),
      tried: requiredText(COMMENT_CEILING),
    }),
    output: z.object({ ticket: McpTicket }),
  },
  ticket_create: {
    description:
      'Creates a new ticket in the project for work you found outside your ticket\'s scope (a bug, missing documentation). It is created as "proposed": the owner accepts or rejects it, and nothing starts before that. Search with ticket_list first so you do not create a duplicate. Do not use it to split or hand over your own ticket. A run can create only a few tickets (LIMIT_REACHED beyond); use agent_list to choose the assignee.',
    input: z.strictObject({
      type: TicketType,
      title: requiredText(TITLE_CEILING),
      description: boundedText(DESCRIPTION_CEILING).trim(),
      acceptance_criteria: z.array(requiredText(CRITERION_CEILING)).max(CRITERIA_CEILING),
      priority: TicketPriority,
      /** Tickets of the same project that must be done first. */
      blocked_by: z.array(TicketReference).optional(),
      /** Key of an agent profile, from agent_list. */
      assignee: AgentKey.optional(),
    }),
    output: z.object({ ticket: McpTicket }),
  },
  ticket_submit: {
    description:
      "Submits your run's ticket as finished, with the Definition of Done report: every acceptance criterion (by index, from 0) reported met with a one-line justification, the tests and documentation files changed (or why none were needed), any ADRs added, and a short summary. File paths are relative to the worktree root. Commit all your work first, on the current branch; never push and never switch branches: the Orchestrator handles that. If a criterion cannot be met, do not submit: use ticket_ask to get a decision, or ticket_give_up if the work is impossible as specified. The submission is refused with DOD_FAILED, listing each failed check, when a criterion is not met, the worktree has uncommitted changes, or the branch has no commits; fix them and submit again. When it is accepted, the ticket moves to in_review and the run ends: end your turn.",
    input: DodReport,
    /**
     * `accepted`: the run ends with the turn (lot 2, and lot 3 until CI is awaited). `pending_ci`:
     * the pull request is open and CI runs; the run waits for it (04, section 3.1; protocol 2).
     */
    output: z.object({ result: z.enum(['accepted', 'pending_ci']), ticket: McpTicket }),
  },
  review_approve: {
    description:
      'Approves the ticket you review, with a summary of your verdict: what you checked and why it is good to merge. The summary is posted as a review comment on the ticket and on the pull request, and the ticket moves to awaiting_merge, where the owner merges it. Use it only in a review run, once every point of your review is satisfied; otherwise use review_request_changes. End your turn after calling it.',
    input: z.strictObject({ summary: requiredText(COMMENT_CEILING) }),
    output: z.object({ comment: McpComment, ticket: McpTicket }),
  },
  review_request_changes: {
    description:
      'Requests changes on the ticket you review, as a list of actionable points, each with the file and line it is about when there is one (paths relative to the worktree root). Each point is posted as a review comment on the ticket, all of them as one review on the pull request, and the ticket goes back to todo for the agent that implemented it. Use it only in a review run; never change the branch yourself. End your turn after calling it.',
    input: z.strictObject({ points: z.array(ReviewPoint).min(1) }),
    output: z.object({ comments: z.array(McpComment), ticket: McpTicket }),
  },
} as const satisfies Record<string, McpToolDefinition>;

export type McpToolName = keyof typeof MCP_TOOLS;
export const McpToolName = z.enum(Object.keys(MCP_TOOLS) as [McpToolName, ...McpToolName[]]);

/** Input of a tool, as the server receives it after validation. */
export type McpToolInput<Name extends McpToolName> = z.infer<(typeof MCP_TOOLS)[Name]['input']>;
/** Output of a tool, as the agent receives it. */
export type McpToolOutput<Name extends McpToolName> = z.infer<(typeof MCP_TOOLS)[Name]['output']>;
