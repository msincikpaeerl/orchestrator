import { schema } from '@orchestrator/db';
import {
  CiRound,
  EDITABLE_STATUSES,
  ACTIVE_RUN_STATUSES,
  AgentRole,
  CommentKind,
  StoredDodReport,
  HarnessElement,
  MCP_OUTPUT_MAX_CHARACTERS,
  MCP_TICKET_LIST_PAGE_SIZE,
  MCP_TOOLS,
  McpPermission,
  PlanStatus,
  SETTINGS,
  ProjectKind,
  RequestStatus,
  ReviewDecision,
  TicketPriority,
  TicketStatus,
  TicketType,
  agentReport,
  shorten,
  storedReport,
  type McpCall,
  type McpCiStatus,
  type McpComment,
  type McpError,
  type McpErrorDetail,
  type McpRequest,
  type McpResult,
  type McpTicket,
  type McpTicketSummary,
  type McpToolInput,
  type McpToolOutput,
  type McpToolName,
  type SettingName,
  type SubmissionRecord,
  type WorkspaceFacts,
} from '@orchestrator/protocol';
import { and, asc, count, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { hashCredential } from '../machines/credentials.js';
import type { ProjectRow } from '../projects/model.js';
import {
  requestEntity,
  requestProjectKey,
  waitingQuestion,
  type RequestRow,
} from '../requests/model.js';
import { startCiWait } from '../runs/ci-wait.js';
import { runBranch, type RunRow } from '../runs/model.js';
import { resolveSettings } from '../settings/store.js';
import { findPath, ticketLimits } from '../tickets/rules.js';
import {
  acceptanceCriteria,
  ticketEntity,
  ticketReference,
  type CommentRow,
  type TicketRow,
} from '../tickets/model.js';
import { standingRequest } from '../tickets/changes.js';
import { recordPush } from '../tickets/branch.js';
import { applyRunAction } from '../tickets/transitions.js';
import type { Template, Templates } from '../agents/files.js';
import { part } from '../agents/messages.js';
import { checkPlan, recordPlan } from '../requests/plan-propose.js';
import { cutToFit, fitPage, jsonLength } from './output.js';
import { checkSubmission, criteriaOutOfRange, refusal } from './submission-checks.js';

/** Characters of a page's output besides its items: the field names and the cursor. */
const OUTPUT_OVERHEAD = 100;

// The MCP backend (06; lot 2 step K): every tool call of an agent, with the run token deciding
// which run, ticket, project and permissions it has (06, section 2). All validation happens here:
// the daemon only relays. Writes change only the run's own ticket, in one transaction holding the
// project's row lock, then the run's, with their events. Reading calls write no event (the run's
// log shows them, from the transcript): the event log is for changes (owner's decision, lot 2
// step K).

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProfileRow = typeof schema.agentProfiles.$inferSelect;

/** A writing tool's output, and what to do once its transaction committed. */
interface Handled {
  output: unknown;
  after?: () => void;
}

/** Tools that only read: no event, no transaction. */
const READING = new Set<McpToolName>([
  'project_get',
  'ticket_get',
  'ticket_list',
  'ticket_comments',
  'agent_list',
  'ci_status',
  'request_get',
]);

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);

/** Where a linked project's conventions are, relative to the worktree root (ADR 0023). */
const CONVENTIONS = {
  claude_md: 'CLAUDE.md',
  user_docs: 'docs/user/',
  dev_docs: 'docs/dev/',
  adrs: 'docs/adr/',
};

/** A refused call: its error goes back to the agent as is (06, section 3). */
class Refusal extends Error {
  constructor(readonly error: McpError) {
    super(error.message);
  }
}

const refuse = (code: McpError['code'], message: string, details?: McpErrorDetail[]) =>
  new Refusal({ code, message, ...(details ? { details } : {}) });

/**
 * The tools' texts other than `ticket_submit`'s, from `agents/templates/mcp-tools.md` (03,
 * section 3.2; lot 3 step L): their refusals, the review decision's note and the cut notes.
 */
type Texts = Template;

/** A submission refused by its checks: the run keeps it, outside the refused call's transaction. */
class SubmissionRefused extends Refusal {
  constructor(
    error: McpError,
    readonly call: Call,
    readonly record: SubmissionRecord,
  ) {
    super(error);
  }
}

/** The refusal of a call whose run has ended: its token was revoked, or is unknown. */
const ended = (texts: Texts) => refuse('FORBIDDEN', texts.main);

function tooLong(
  texts: Texts,
  field: string,
  setting: SettingName,
  max: number,
  unit: 'characters' | 'criteria' = 'characters',
) {
  return {
    field,
    setting,
    message: part(texts, `too-long-${unit}`, {
      field,
      max: String(max),
      setting: SETTINGS[setting].label,
    }),
  } satisfies McpErrorDetail;
}

/** Everything a call knows once its token was checked. */
interface Call {
  run: RunRow;
  project: ProjectRow;
  ticket: TicketRow;
  profile: ProfileRow;
  machineName: string;
}

/**
 * A planning run's call (06, section 4.4; lot 5 step D2a): its request instead of a ticket, and no
 * project when the request asks for a new one (lot 5 step E1b).
 */
interface PlanCall {
  run: RunRow;
  project: ProjectRow | null;
  ticket: null;
  request: RequestRow;
  profile: ProfileRow;
  machineName: string;
}

/** A planning run's call on a project: any tool that works on the project's tickets. */
type ProjectPlanCall = PlanCall & { project: ProjectRow };

/** What the reading tools need: the run's project, and its ticket when it has one. */
type Scope =
  Pick<Call, 'project' | 'ticket'> | Pick<ProjectPlanCall, 'project' | 'ticket' | 'request'>;

export interface McpBackendOptions {
  db: Database;
  log: FastifyBaseLogger;
  now: () => Date;
  /** Milliseconds in one second of "Progress update interval"; tests shorten it. */
  secondMs: number;
  /** The run message templates (03, section 3.2): `ticket_submit`'s texts among them. */
  templates: () => Promise<Templates>;
  /** After an accepted submission is committed: open or update its pull request (lot 3 step F3). */
  pullRequestWanted: (ticketId: string) => void;
  /** `ci_status`'s answer for the call's run (lot 3 step G1b). */
  ciStatus: (call: { run: RunRow; ticket: TicketRow; project: ProjectRow }) => Promise<McpCiStatus>;
  /**
   * A review decision's check (06, section 4.5; lot 3 step H2): the pull request's head on GitHub,
   * or, when it could not be read, why in GitHub's masked words.
   */
  pullRequestHead: (
    project: ProjectRow,
    number: number,
  ) => Promise<{ read: true; head: string } | { read: false; why: string }>;
  /** The head moved on GitHub at a decision: the review run stops with `review_branch_moved`. */
  reviewHeadMoved: (runId: string, head: string) => Promise<void>;
}

export class McpBackend {
  private readonly db: Database;
  private readonly log: FastifyBaseLogger;
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  /** Loaded by the first call, before any refusal can be written. */
  private loadedTexts: Texts | null = null;

  constructor(private readonly options: McpBackendOptions) {
    this.db = options.db;
    this.log = options.log;
  }

  private now(): Date {
    return this.options.now();
  }

  private get texts(): Texts {
    if (this.loadedTexts === null) throw new Error("the MCP tools' texts are not loaded");
    return this.loadedTexts;
  }

  close(): void {
    for (const timer of this.progressTimers.values()) clearTimeout(timer);
    this.progressTimers.clear();
  }

  /** `mcp.call` from a daemon (06, section 1): the result or the refusal for the agent. */
  async call(machineId: string, message: McpCall): Promise<McpResult['payload']> {
    const { tool } = message.payload;
    const started = Date.now();
    let runId: string | undefined;
    let reference: string | undefined;
    let requestNumber: number | undefined;
    let code: string = 'ok';
    try {
      this.loadedTexts ??= (await this.options.templates())['mcp-tools'];
      const [found] = await this.db
        .select({
          id: schema.runs.id,
          machineId: schema.runs.machineId,
          purpose: schema.runs.purpose,
        })
        .from(schema.runs)
        .where(eq(schema.runs.runTokenHash, hashCredential(message.payload.runToken)));
      if (!found || found.machineId !== machineId) throw ended(this.texts);
      runId = found.id;
      // The push happened whatever the answer to the call: recorded first, on its own.
      if (message.payload.tool === 'ticket_submit' && message.payload.workspace.push !== null) {
        await this.recordSubmissionPush(found.id, message.payload.workspace);
      }
      const definition = MCP_TOOLS[tool];
      const parsed = definition.input.safeParse(message.payload.input);
      if (!parsed.success) {
        throw refuse(
          'VALIDATION_FAILED',
          part(this.texts, 'input-invalid', {
            tool,
            issues: parsed.error.issues
              .map((issue) =>
                part(this.texts, 'input-issue', {
                  field: issue.path.join('.') || 'input',
                  message: issue.message,
                }),
              )
              .join('; '),
          }),
          parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || 'input',
            message: issue.message,
          })),
        );
      }
      const known = (call: Call) => {
        reference = ticketReference(call.project.key, call.ticket.number);
      };
      if (
        found.purpose !== 'plan' &&
        (tool === 'request_get' || tool === 'request_ask' || tool === 'plan_propose')
      ) {
        // Every role reads, but only a planning run has a request (owner's answer 5, lot 5 step D2a).
        throw refuse(
          'FORBIDDEN',
          part(this.texts, 'request-only', { tool, purpose: found.purpose }),
        );
      }
      const output =
        found.purpose === 'plan'
          ? await this.plan(tool, found.id, machineId, parsed.data, (call) => {
              requestNumber = call.request.number;
            })
          : READING.has(tool)
            ? await this.read(tool, found.id, machineId, parsed.data, known)
            : tool === 'review_approve' || tool === 'review_request_changes'
              ? await this.review(tool, found.id, machineId, parsed.data, known)
              : await this.write(tool, found.id, machineId, message, parsed.data, known);
      return { ok: true, output: definition.output.parse(output) };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      code = error.error.code;
      return { ok: false, error: error.error };
    } finally {
      this.log.info(
        {
          run: runId,
          ticket: reference,
          request: requestNumber,
          machine: machineId,
          tool,
          result: code,
          ms: Date.now() - started,
        },
        'MCP call',
      );
    }
  }

  /** The run, its project, ticket and profile; refused once the run's token is revoked. */
  private async load(
    executor: Executor,
    runId: string,
    machineId: string,
    lock: boolean,
  ): Promise<Call> {
    const runQuery = executor.select().from(schema.runs).where(eq(schema.runs.id, runId));
    const [run] = lock ? await runQuery.for('update') : await runQuery;
    if (!run || run.machineId !== machineId || run.runTokenRevokedAt !== null) {
      throw ended(this.texts);
    }
    if (run.ticketId === null || run.projectId === null) {
      throw new Error(`run ${run.id} has no ticket`);
    }
    const [project] = await executor
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, run.projectId));
    const [ticket] = await executor
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, run.ticketId));
    const [profile] = await executor
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, run.profileId));
    const [machine] = await executor
      .select({ name: schema.machines.name })
      .from(schema.machines)
      .where(eq(schema.machines.id, run.machineId));
    if (!project || !ticket || !profile || !machine) throw new Error(`run ${run.id} incomplete`);
    return { run, project, ticket, profile, machineName: machine.name };
  }

  /** The push the daemon made before forwarding a `ticket_submit` (05, section 4.9). */
  private async recordSubmissionPush(runId: string, workspace: WorkspaceFacts): Promise<void> {
    if (workspace.push === null) return;
    const result = workspace.push;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: schema.runs, project: schema.projects, machineName: schema.machines.name })
        .from(schema.runs)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
        .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
        .where(eq(schema.runs.id, runId));
      if (!row || row.run.ticketId === null) return;
      // The project's row lock first, then the run's: the order of every ticket change.
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, row.project.id))
        .for('no key update');
      await tx
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update');
      const [ticket] = await tx
        .select({ id: schema.tickets.id, number: schema.tickets.number })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, row.run.ticketId));
      if (!ticket) throw new Error(`run ${runId} has no ticket`);
      await recordPush(tx, {
        project: row.project,
        ticket,
        run: { id: row.run.id, branchName: runBranch(row.run) },
        machine: { id: row.run.machineId, name: row.machineName },
        result,
        branch: workspace.branch,
        when: 'submission',
        now: this.now(),
      });
    });
  }

  /** The profile's MCP permissions (06, section 5): refused with the role named. */
  private permit(call: Pick<Call, 'profile'>, tool: McpToolName): void {
    const permissions = z.array(McpPermission).parse(call.profile.mcpPermissions);
    if (!permissions.includes(tool)) {
      throw refuse(
        'FORBIDDEN',
        part(this.texts, 'role', { role: AgentRole.parse(call.profile.role), tool }),
      );
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Planning runs (06, section 4.4; lot 5 step D2a, owner's answers 4 and 5): the reading tools on
  // the project, `request_get` and `request_ask` on the run's request, and the progress line kept
  // on the run. A tool on a ticket of its own is refused: a planning run has none.

  private async plan(
    tool: McpToolName,
    runId: string,
    machineId: string,
    input: unknown,
    known: (call: PlanCall) => void,
  ): Promise<unknown> {
    if (READING.has(tool)) {
      const call = await this.loadPlan(this.db, runId, machineId, false);
      known(call);
      this.permit(call, tool);
      switch (tool) {
        case 'project_get':
          return this.projectGet(this.onProject(call, tool));
        case 'ticket_get':
          return this.ticketGet(this.onProject(call, tool), input as McpToolInput<'ticket_get'>);
        case 'ticket_list':
          return this.ticketList(this.onProject(call, tool), input as McpToolInput<'ticket_list'>);
        case 'ticket_comments':
          return this.ticketComments(
            this.onProject(call, tool),
            input as McpToolInput<'ticket_comments'>,
          );
        case 'agent_list':
          return this.agentList();
        case 'request_get':
          return this.requestGet(call, input as McpToolInput<'request_get'>);
        case 'ci_status':
          throw refuse(
            'INVALID_TRANSITION',
            part(this.texts, 'plan-no-pull-request', { request: String(call.request.number) }),
          );
        default:
          throw new Error(`${tool} is not a reading tool`);
      }
    }
    const { commentMaxLength } = await resolveSettings(this.db, ['commentMaxLength']);
    return this.db.transaction(async (tx) => {
      const [projectRow] = await tx
        .select({ projectId: schema.runs.projectId })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId));
      if (!projectRow) throw ended(this.texts);
      // The project's row lock first, then the request's, then the run's.
      if (projectRow.projectId !== null) {
        await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectRow.projectId))
          .for('no key update');
      }
      const call = await this.loadPlan(tx, runId, machineId, true);
      known(call);
      this.permit(call, tool);
      if (!ACTIVE.has(call.run.status)) throw ended(this.texts);
      switch (tool) {
        case 'ticket_progress':
          return this.planProgress(tx, call, input as McpToolInput<'ticket_progress'>);
        case 'request_ask':
          return this.requestAsk(tx, call, input as McpToolInput<'request_ask'>, commentMaxLength);
        case 'ticket_update':
          return this.planUpdate(
            tx,
            this.onProject(call, tool),
            input as McpToolInput<'ticket_update'>,
          );
        case 'plan_propose':
          return this.planPropose(tx, call, input as McpToolInput<'plan_propose'>);
        case 'ticket_give_up':
          return this.planGiveUp(
            tx,
            call,
            input as McpToolInput<'ticket_give_up'>,
            commentMaxLength,
          );
        default:
          throw refuse(
            'INVALID_TRANSITION',
            part(this.texts, 'plan-no-ticket', { request: String(call.request.number), tool }),
          );
      }
    });
  }

  /** A planning run, its request, project and profile; refused once the run's token is revoked. */
  private async loadPlan(
    executor: Executor,
    runId: string,
    machineId: string,
    lock: boolean,
  ): Promise<PlanCall> {
    const [first] = await executor.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (!first || first.machineId !== machineId || first.runTokenRevokedAt !== null) {
      throw ended(this.texts);
    }
    if (first.requestId === null) throw new Error(`planning run ${runId} has no request`);
    const requestQuery = executor
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, first.requestId));
    const [request] = lock ? await requestQuery.for('update') : await requestQuery;
    let run = first;
    if (lock) {
      const [locked] = await executor
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update');
      if (!locked || locked.runTokenRevokedAt !== null) throw ended(this.texts);
      run = locked;
    }
    const project = (
      run.projectId === null
        ? [null]
        : await executor.select().from(schema.projects).where(eq(schema.projects.id, run.projectId))
    ).at(0);
    const [profile] = await executor
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, run.profileId));
    const [machine] = await executor
      .select({ name: schema.machines.name })
      .from(schema.machines)
      .where(eq(schema.machines.id, run.machineId));
    if (!request || project === undefined || !profile || !machine) {
      throw new Error(`run ${run.id} incomplete`);
    }
    return { run, project, ticket: null, request, profile, machineName: machine.name };
  }

  /**
   * The call of a planning run on its project; refused for a request that asks for a new project,
   * which has no project and no tickets yet (owner's answer 10, lot 5 step E1).
   */
  private onProject(call: PlanCall, tool: McpToolName): ProjectPlanCall {
    const { project } = call;
    if (project === null) {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'plan-no-project', { request: String(call.request.number), tool }),
      );
    }
    return { ...call, project };
  }

  /** The request as a planning run sees it. */
  private mcpRequest({ request, project }: Pick<PlanCall, 'request' | 'project'>): McpRequest {
    return {
      number: request.number,
      text: request.body,
      status: RequestStatus.parse(request.status),
      project: request.projectId === null || project === null ? null : project.key,
    };
  }

  /**
   * `request_get` (owner's answer 13, lot 5 step D): the request on the first page only, then its
   * comments oldest first, a page at a time within `MCP_OUTPUT_MAX_CHARACTERS`. A page holds whole
   * items while they fit: the first may hold the request alone. A single text above the budget
   * (raised settings only) is cut with a marker.
   */
  private async requestGet(call: PlanCall, input: McpToolInput<'request_get'>) {
    const offset = input.cursor === undefined ? 0 : cursorNumber(this.texts, input.cursor);
    const rows = await this.db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.requestId, call.request.id))
      .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
      .offset(offset);
    const keys = await this.profileKeys(this.db);
    const comments = rows.map((row) => mcpComment(row, keys));
    const room = MCP_OUTPUT_MAX_CHARACTERS - OUTPUT_OVERHEAD;
    let request: McpRequest | null = null;
    if (input.cursor === undefined) {
      const whole = this.mcpRequest(call);
      request =
        jsonLength(whole) <= room
          ? whole
          : {
              ...whole,
              text: cutToFit(whole.text, room, part(this.texts, 'request-text-cut'), (candidate) =>
                jsonLength({ ...whole, text: candidate }),
              ),
            };
    }
    const used = OUTPUT_OVERHEAD + (request === null ? 0 : jsonLength(request));
    const [next] = comments;
    const page =
      request !== null &&
      next !== undefined &&
      used + jsonLength(next) + 1 > MCP_OUTPUT_MAX_CHARACTERS
        ? []
        : fitPage(comments, used);
    const [first] = page;
    // A single comment above the budget (raised settings only) is cut.
    if (request === null && page.length === 1 && first && jsonLength(first) > room) {
      page[0] = {
        ...first,
        body: cutToFit(first.body, room, part(this.texts, 'request-comment-cut'), (candidate) =>
          jsonLength({ ...first, body: candidate }),
        ),
      };
    }
    const after = offset + page.length;
    return {
      request,
      comments: page,
      next_cursor: after < offset + rows.length ? `after-${String(after)}` : null,
    };
  }

  /**
   * `request_ask` (owner's answer 5, lot 5 step D2a): a `question` on the request, which stays
   * `planning`; the daemon ends the turn as a question and the run waits for the owner.
   */
  private async requestAsk(
    tx: Transaction,
    call: PlanCall,
    input: McpToolInput<'request_ask'>,
    commentMaxLength: number,
  ) {
    const number = String(call.request.number);
    if (call.run.decision !== null) {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'plan-decided'));
    }
    // Only a question of a run still active waits: one left by an ended run never blocks.
    if ((await waitingQuestion(tx, call.request.id)) !== null) {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'request-waiting-answer', { request: number, tool: 'request_ask' }),
      );
    }
    const status = RequestStatus.parse(call.request.status);
    if (status !== 'planning') {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'request-not-planning', { request: number, status, tool: 'request_ask' }),
      );
    }
    this.tooLongRefusal([this.checkComment('question', input.question, commentMaxLength)]);
    const at = this.now();
    const [row] = await tx
      .insert(schema.comments)
      .values({
        requestId: call.request.id,
        author: 'agent',
        authorProfileId: call.profile.id,
        runId: call.run.id,
        kind: 'question',
        body: input.question,
        createdAt: at,
      })
      .returning();
    if (!row) throw new Error('comment not inserted');
    const [request] = await tx
      .update(schema.requests)
      .set({ updatedAt: at })
      .where(eq(schema.requests.id, call.request.id))
      .returning();
    if (!request) throw new Error('request disappeared');
    await recordEvent(tx, {
      actor: 'agent',
      ...requestEntity(request),
      type: 'request.commented',
      payload: {
        request: request.number,
        project: await requestProjectKey(tx, request),
        commentId: row.id,
        kind: 'question',
        agent: call.profile.key,
        agentName: call.profile.name,
        runId: call.run.id,
      },
      at,
    });
    const keys = await this.profileKeys(tx);
    return {
      comment: mcpComment(row, keys),
      request: this.mcpRequest({ request, project: call.project }),
    };
  }

  /**
   * `ticket_give_up` in a planning run (owner's answer 5, lot 5 step E2): the request cannot be
   * planned. The reason and what was tried become the agent's note on the request, and the run's
   * outcome; the run ends as failed when the turn ends and counts on the request.
   */
  private async planGiveUp(
    tx: Transaction,
    call: PlanCall,
    input: McpToolInput<'ticket_give_up'>,
    commentMaxLength: number,
  ) {
    if (call.run.decision !== null) {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'plan-decided'));
    }
    this.tooLongRefusal([
      this.checkComment('reason', input.reason, commentMaxLength),
      this.checkComment('tried', input.tried, commentMaxLength),
    ]);
    const at = this.now();
    const [row] = await tx
      .insert(schema.comments)
      .values({
        requestId: call.request.id,
        author: 'agent',
        authorProfileId: call.profile.id,
        runId: call.run.id,
        kind: 'note',
        body: `I cannot plan this request.\n\nWhy:\n\n${input.reason}\n\nWhat I tried:\n\n${input.tried}`,
        createdAt: at,
      })
      .returning({ id: schema.comments.id });
    if (!row) throw new Error('comment not inserted');
    const [request] = await tx
      .update(schema.requests)
      .set({ updatedAt: at })
      .where(eq(schema.requests.id, call.request.id))
      .returning();
    if (!request) throw new Error('request disappeared');
    await recordEvent(tx, {
      actor: 'agent',
      ...requestEntity(request),
      type: 'request.commented',
      payload: {
        request: request.number,
        project: await requestProjectKey(tx, request),
        commentId: row.id,
        kind: 'note',
        agent: call.profile.key,
        agentName: call.profile.name,
        runId: call.run.id,
      },
      at,
    });
    await tx
      .update(schema.runs)
      .set({ decision: 'gave_up', outcome: input.reason, updatedAt: at })
      .where(eq(schema.runs.id, call.run.id));
    return { request: this.mcpRequest({ request, project: call.project }) };
  }

  /**
   * `ticket_progress` in a planning run: the line is kept on the run, never refused. No screen
   * shows a planning run before step E2 (owner's answer 11, lot 5 step D2a), so none is shown.
   */
  private async planProgress(
    tx: Transaction,
    call: PlanCall,
    input: McpToolInput<'ticket_progress'>,
  ) {
    const at = this.now();
    await tx
      .update(schema.runs)
      .set({ progress: input.text, progressAt: at })
      .where(eq(schema.runs.id, call.run.id));
    return { progress: input.text, at: at.toISOString() };
  }

  // -----------------------------------------------------------------------------------------------
  // Reading tools (06, section 4.1): the project, its tickets and comments, the profiles.

  private async read(
    tool: McpToolName,
    runId: string,
    machineId: string,
    input: unknown,
    known: (call: Call) => void,
  ): Promise<unknown> {
    const call = await this.load(this.db, runId, machineId, false);
    known(call);
    this.permit(call, tool);
    switch (tool) {
      case 'project_get':
        return this.projectGet(call);
      case 'ticket_get':
        return this.ticketGet(call, input as McpToolInput<'ticket_get'>);
      case 'ticket_list':
        return this.ticketList(call, input as McpToolInput<'ticket_list'>);
      case 'ticket_comments':
        return this.ticketComments(call, input as McpToolInput<'ticket_comments'>);
      case 'agent_list':
        return this.agentList();
      case 'ci_status':
        return this.options.ciStatus(call) satisfies Promise<McpToolOutput<'ci_status'>>;
      default:
        throw new Error(`${tool} is not a reading tool`);
    }
  }

  private projectGet({ project }: Pick<Call, 'project'>) {
    return {
      key: project.key,
      name: project.name,
      description: project.description,
      kind: ProjectKind.parse(project.kind),
      repository: {
        owner: project.repoOwner,
        name: project.repoName,
        default_branch: project.defaultBranch ?? '',
      },
      conventions: CONVENTIONS,
      missing: z.array(HarnessElement).parse(project.missingHarness ?? []),
    };
  }

  /**
   * A ticket of the run's project by its reference (`WEB-12`), or the run's own; a planning run
   * has none, so it names one (lot 5 step D2a).
   */
  private async findTicket(
    executor: Executor,
    call: Scope,
    reference?: string,
  ): Promise<TicketRow> {
    if (reference === undefined) {
      if (call.ticket !== null) return call.ticket;
      throw refuse(
        'VALIDATION_FAILED',
        part(this.texts, 'plan-ticket-needed', { request: String(call.request.number) }),
        [{ field: 'ticket', message: part(this.texts, 'plan-ticket-needed-field') }],
      );
    }
    const [key, number] = reference.split('-');
    const [row] =
      key === call.project.key
        ? await executor
            .select()
            .from(schema.tickets)
            .where(
              and(
                eq(schema.tickets.projectId, call.project.id),
                eq(schema.tickets.number, Number(number)),
              ),
            )
        : [];
    if (!row) {
      throw refuse(
        'NOT_FOUND',
        part(this.texts, 'ticket-unknown', { reference, project: call.project.key }),
      );
    }
    return row;
  }

  private async profileKeys(executor: Executor): Promise<Map<string, string>> {
    const rows = await executor
      .select({ id: schema.agentProfiles.id, key: schema.agentProfiles.key })
      .from(schema.agentProfiles);
    return new Map(rows.map((row) => [row.id, row.key]));
  }

  /** One ticket as agents see it (06, section 4.1). */
  private async mcpTicket(
    executor: Executor,
    projectKey: string,
    ticket: TicketRow,
  ): Promise<McpTicket> {
    const keys = await this.profileKeys(executor);
    const blocker = alias(schema.tickets, 'blocker');
    const waiting = alias(schema.tickets, 'waiting');
    const blockedBy = await executor
      .select({ number: blocker.number, title: blocker.title, status: blocker.status })
      .from(schema.ticketDependencies)
      .innerJoin(blocker, eq(blocker.id, schema.ticketDependencies.blockedById))
      .where(eq(schema.ticketDependencies.ticketId, ticket.id))
      .orderBy(asc(blocker.number));
    const blocks = await executor
      .select({ number: waiting.number, title: waiting.title, status: waiting.status })
      .from(schema.ticketDependencies)
      .innerJoin(waiting, eq(waiting.id, schema.ticketDependencies.ticketId))
      .where(eq(schema.ticketDependencies.blockedById, ticket.id))
      .orderBy(asc(waiting.number));
    const link = (row: { number: number; title: string; status: string }) => ({
      number: ticketReference(projectKey, row.number),
      title: row.title,
      status: TicketStatus.parse(row.status),
    });
    const creator =
      ticket.createdBy === 'agent' && ticket.createdByProfileId !== null
        ? { agent: keys.get(ticket.createdByProfileId) ?? 'unknown' }
        : ('owner' as const);
    return {
      ...summary(
        projectKey,
        ticket,
        keys,
        blockedBy.some((row) => row.status !== 'done'),
      ),
      description: ticket.description,
      acceptance_criteria: acceptanceCriteria(ticket),
      blocked_by: blockedBy.map(link),
      blocks: blocks.map(link),
      created_by: creator,
      // Kept by index from 0, read by agents by number from 1 (owner's answer, lot 5 step B).
      dod_report:
        ticket.dodReport === null ? null : agentReport(StoredDodReport.parse(ticket.dodReport)),
      pull_request_url: null,
    };
  }

  private async ticketGet(call: Scope, input: McpToolInput<'ticket_get'>) {
    const ticket = await this.findTicket(this.db, call, input.ticket);
    const full = await this.mcpTicket(this.db, call.project.key, ticket);
    if (jsonLength({ ticket: full }) <= MCP_OUTPUT_MAX_CHARACTERS) return { ticket: full };
    // Only raised settings make a ticket this long: its description is cut.
    const description = cutToFit(
      full.description,
      MCP_OUTPUT_MAX_CHARACTERS,
      part(this.texts, 'description-cut'),
      (candidate) => jsonLength({ ticket: { ...full, description: candidate } }),
    );
    return { ticket: { ...full, description } };
  }

  private async ticketList(call: Scope, input: McpToolInput<'ticket_list'>) {
    const after = input.cursor === undefined ? 0 : cursorNumber(this.texts, input.cursor);
    const conditions = [
      eq(schema.tickets.projectId, call.project.id),
      gt(schema.tickets.number, after),
    ];
    if (input.status) conditions.push(inArray(schema.tickets.status, input.status));
    if (input.type) conditions.push(inArray(schema.tickets.type, input.type));
    if (input.assignee !== undefined) {
      const [profile] = await this.db
        .select({ id: schema.agentProfiles.id })
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.key, input.assignee));
      if (!profile) {
        throw refuse('NOT_FOUND', part(this.texts, 'profile-unknown', { key: input.assignee }));
      }
      conditions.push(eq(schema.tickets.assigneeProfileId, profile.id));
    }
    if (input.text !== undefined) {
      const pattern = `%${input.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const match = or(
        ilike(schema.tickets.title, pattern),
        ilike(schema.tickets.description, pattern),
      );
      if (match) conditions.push(match);
    }
    const rows = await this.db
      .select({ ticket: schema.tickets, blocked: blockedFlag })
      .from(schema.tickets)
      .where(and(...conditions))
      .orderBy(asc(schema.tickets.number))
      .limit(MCP_TICKET_LIST_PAGE_SIZE + 1);
    const keys = await this.profileKeys(this.db);
    const summaries = rows.map((row) => summary(call.project.key, row.ticket, keys, row.blocked));
    const page = fitPage(summaries, OUTPUT_OVERHEAD, MCP_TICKET_LIST_PAGE_SIZE);
    const last = rows[page.length - 1];
    const more = rows.length > page.length;
    return {
      tickets: page,
      next_cursor: more && last ? `after-${String(last.ticket.number)}` : null,
    };
  }

  private async ticketComments(call: Scope, input: McpToolInput<'ticket_comments'>) {
    const ticket = await this.findTicket(this.db, call, input.ticket);
    const offset = input.cursor === undefined ? 0 : cursorNumber(this.texts, input.cursor);
    const rows = await this.db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.ticketId, ticket.id))
      .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id))
      .offset(offset);
    const keys = await this.profileKeys(this.db);
    const comments = rows.map((row) => mcpComment(row, keys));
    const page = fitPage(comments, OUTPUT_OVERHEAD);
    const [first] = page;
    // A single comment above the budget (raised settings only) is cut.
    const room = MCP_OUTPUT_MAX_CHARACTERS - OUTPUT_OVERHEAD;
    if (page.length === 1 && first && jsonLength(first) > room) {
      page[0] = {
        ...first,
        body: cutToFit(first.body, room, part(this.texts, 'comment-cut'), (candidate) =>
          jsonLength({ ...first, body: candidate }),
        ),
      };
    }
    const next = offset + page.length;
    return {
      comments: page,
      next_cursor: next < offset + rows.length ? `after-${String(next)}` : null,
    };
  }

  private async agentList() {
    const rows = await this.db
      .select()
      .from(schema.agentProfiles)
      .orderBy(asc(schema.agentProfiles.key));
    return {
      agents: rows.map((row) => ({
        key: row.key,
        name: row.name,
        role: AgentRole.parse(row.role),
        description: row.description,
      })),
    };
  }

  // -----------------------------------------------------------------------------------------------
  // Tools that change something (06, sections 4.2 and 4.3): only the run's own ticket.

  private async write(
    tool: McpToolName,
    runId: string,
    machineId: string,
    message: McpCall,
    input: unknown,
    known: (call: Call) => void,
  ): Promise<unknown> {
    const settings = await resolveSettings(this.db, [
      'commentMaxLength',
      'ticketTitleMaxLength',
      'ticketDescriptionMaxLength',
      'ticketMaxAcceptanceCriteria',
      'acceptanceCriterionMaxLength',
      'progressUpdateIntervalSeconds',
    ]);
    const [projectRow] = await this.db
      .select({ projectId: schema.runs.projectId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    // A ticket's run always has a project: only a planning run may have none.
    if (!projectRow?.projectId) throw ended(this.texts);
    const { projectId } = projectRow;
    const agentTicketsSetting = await resolveSettings(
      this.db,
      ['maxAgentTicketsPerRun'],
      projectId,
    );
    const result = await this.db
      .transaction(async (tx): Promise<Handled> => {
        // The project's row lock first, then the run's: the order of every ticket change.
        await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .for('no key update');
        const call = await this.load(tx, runId, machineId, true);
        known(call);
        this.permit(call, tool);
        if (!ACTIVE.has(call.run.status)) throw ended(this.texts);
        switch (tool) {
          case 'ticket_progress':
            return this.progress(tx, call, input as McpToolInput<'ticket_progress'>, settings);
          case 'ticket_comment':
            return this.comment(tx, call, input as McpToolInput<'ticket_comment'>, settings);
          case 'ticket_ask':
            return this.ask(tx, call, input as McpToolInput<'ticket_ask'>, settings);
          case 'ticket_give_up':
            return this.giveUp(tx, call, input as McpToolInput<'ticket_give_up'>, settings);
          case 'ticket_create':
            return this.create(tx, call, input as McpToolInput<'ticket_create'>, {
              ...settings,
              maxAgentTicketsPerRun:
                call.run.maxAgentTickets ?? agentTicketsSetting.maxAgentTicketsPerRun,
            });
          case 'ticket_submit':
            if (message.payload.tool !== 'ticket_submit') throw new Error('no worktree facts');
            return this.submit(
              tx,
              call,
              input as McpToolInput<'ticket_submit'>,
              message.payload.workspace,
            );
          default:
            throw new Error(`${tool} is not a writing tool`);
        }
      })
      .catch(async (error: unknown) => {
        if (error instanceof SubmissionRefused) await this.recordRefusedSubmission(error);
        throw error;
      });
    if (result.after) result.after();
    return result.output;
  }

  // -----------------------------------------------------------------------------------------------
  // Review decisions (06, section 4.5; owner's answers 2c to 2e and 6g, lot 3 step H2): checked
  // without a lock, the pull request's head read on GitHub outside any transaction, then checked
  // again and stored on the run under the locks. Applied when the run ends (runs/service.ts).

  private async review(
    tool: 'review_approve' | 'review_request_changes',
    runId: string,
    machineId: string,
    input: unknown,
    known: (call: Call) => void,
  ): Promise<unknown> {
    const { commentMaxLength } = await resolveSettings(this.db, ['commentMaxLength']);
    const first = await this.load(this.db, runId, machineId, false);
    known(first);
    await this.reviewAllowed(this.db, first, tool, input, commentMaxLength);
    const commit = first.run.reviewCommit;
    if (commit === null) throw new Error(`review run ${runId} has no commit under review`);
    const number = first.ticket.pullRequestNumber;
    const read =
      number === null
        ? ({ read: false, why: 'the ticket has no pull request' } as const)
        : await this.options.pullRequestHead(first.project, number);
    if (read.read && read.head !== commit) {
      // Read and found moved: refused, and the run stopped (owner's answer 2c).
      await this.options.reviewHeadMoved(runId, read.head);
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'review-head-moved', {
          head: read.head.slice(0, 7),
          commit: commit.slice(0, 7),
        }),
      );
    }
    const headChecked = read.read;

    return this.db.transaction(async (tx) => {
      // The project's row lock first, then the run's: the order of every ticket change.
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, first.project.id))
        .for('no key update');
      const call = await this.load(tx, runId, machineId, true);
      // Checked again: the run, the ticket or an earlier decision may have changed meanwhile.
      await this.reviewAllowed(tx, call, tool, input, commentMaxLength);
      const at = this.now();
      const decision: ReviewDecision =
        tool === 'review_approve'
          ? {
              kind: 'approved',
              commit,
              summary: (input as McpToolInput<'review_approve'>).summary,
              points: [],
              headChecked,
              at: at.toISOString(),
            }
          : {
              kind: 'changes_requested',
              commit,
              summary: null,
              points: (input as McpToolInput<'review_request_changes'>).points.map((point) => ({
                body: point.body,
                file: point.file ?? null,
                line: point.line ?? null,
              })),
              headChecked,
              at: at.toISOString(),
            };
      await tx
        .update(schema.runs)
        .set({ reviewDecision: decision, updatedAt: at })
        .where(eq(schema.runs.id, runId));
      await recordEvent(tx, {
        actor: 'agent',
        entityType: 'run',
        entityId: runId,
        projectId: call.project.id,
        type: 'run.review_decided',
        payload: {
          ...this.agentFacts(call),
          decision: decision.kind,
          commit,
          points: decision.points.length,
          headChecked,
        },
        at,
      });
      const count = decision.points.length;
      const short = { commit: commit.slice(0, 7) };
      const note = [
        decision.kind === 'approved'
          ? part(this.texts, 'decision-approved', short)
          : count === 1
            ? part(this.texts, 'decision-changes-one', short)
            : part(this.texts, 'decision-changes', { ...short, count: String(count) }),
        part(this.texts, 'decision-applied'),
        ...(read.read ? [] : [part(this.texts, 'decision-head-unchecked', { why: read.why })]),
      ].join(' ');
      return {
        decision: decision.kind,
        commit,
        head_checked: headChecked,
        note,
      } satisfies McpToolOutput<'review_approve'>;
    });
  }

  /**
   * Whether `call` may decide: the role, an active review run of a ticket in review with nothing
   * decided yet, the texts' lengths, and a reviewer that never implemented the ticket (06,
   * section 4.5; owner's answer 6g: every profile of an `implement` or `fix_review` run).
   */
  private async reviewAllowed(
    executor: Executor,
    call: Call,
    tool: McpToolName,
    input: unknown,
    commentMaxLength: number,
  ): Promise<void> {
    this.permit(call, tool);
    if (!ACTIVE.has(call.run.status)) throw ended(this.texts);
    if (call.run.purpose !== 'review') {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'review-only', { tool, purpose: call.run.purpose }),
      );
    }
    this.requireReviewing(call, tool);
    if (tool === 'review_approve') {
      const { summary } = input as McpToolInput<'review_approve'>;
      this.tooLongRefusal([this.checkComment('summary', summary, commentMaxLength)]);
    } else {
      const { points } = input as McpToolInput<'review_request_changes'>;
      this.tooLongRefusal(
        points.map((point, index) =>
          this.checkComment(`points.${String(index)}.body`, point.body, commentMaxLength),
        ),
      );
    }
    const [implemented] = await executor
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.ticketId, call.ticket.id),
          eq(schema.runs.profileId, call.profile.id),
          inArray(schema.runs.purpose, ['implement', 'fix_review']),
        ),
      )
      .limit(1);
    if (implemented) {
      throw refuse(
        'FORBIDDEN',
        part(this.texts, 'reviewer-implemented', { name: call.profile.name }),
      );
    }
  }

  /** The actor and payload facts of an agent's event (01, section 3.10). */
  private agentFacts(call: Call) {
    return {
      project: call.project.key,
      ticket: ticketReference(call.project.key, call.ticket.number),
      agent: call.profile.key,
      agentName: call.profile.name,
      runId: call.run.id,
    };
  }

  private async insertComment(
    tx: Transaction,
    call: Call,
    kind: 'note' | 'question',
    body: string,
  ): Promise<CommentRow> {
    const at = this.now();
    const [row] = await tx
      .insert(schema.comments)
      .values({
        ticketId: call.ticket.id,
        author: 'agent',
        authorProfileId: call.profile.id,
        runId: call.run.id,
        kind,
        body,
        createdAt: at,
      })
      .returning();
    if (!row) throw new Error('comment not inserted');
    await recordEvent(tx, {
      actor: 'agent',
      ...ticketEntity(call.ticket),
      type: 'ticket.commented',
      payload: { ...this.agentFacts(call), commentId: row.id, kind },
      at,
    });
    return row;
  }

  /** The ticket must be `in_progress`, with no decision taken yet in this run (05, section 4.8). */
  private requireWorking(call: Call, tool: McpToolName): void {
    if (call.run.decision === 'submitted') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'already-submitted'));
    }
    if (call.run.decision === 'gave_up') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'already-gave-up'));
    }
    if (call.ticket.status === 'waiting_human') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'waiting-answer', { tool }));
    }
    if (call.ticket.status !== 'in_progress') {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'needs-in-progress', { status: call.ticket.status, tool }),
      );
    }
  }

  /**
   * A review run's ticket must be `in_review`, with no decision recorded and no give-up yet in
   * this run (06, section 4.5; owner's answer 2e, lot 3 step H2).
   */
  private requireReviewing(call: Call, tool: McpToolName): void {
    if (call.run.reviewDecision !== null) {
      throw refuse(
        'INVALID_TRANSITION',
        part(
          this.texts,
          ReviewDecision.parse(call.run.reviewDecision).kind === 'approved'
            ? 'already-approved'
            : 'already-requested-changes',
        ),
      );
    }
    if (call.run.decision === 'gave_up') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'already-gave-up-review'));
    }
    if (call.ticket.status === 'waiting_human') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'waiting-answer', { tool }));
    }
    if (call.ticket.status !== 'in_review') {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'needs-in-review', { status: call.ticket.status, tool }),
      );
    }
  }

  /** The checks of `ticket_ask` and `ticket_give_up`: a review run's, or a working run's. */
  private requireDeciding(call: Call, tool: McpToolName): void {
    if (call.run.purpose === 'review') this.requireReviewing(call, tool);
    else this.requireWorking(call, tool);
  }

  /**
   * `ticket_progress` (06, section 4.2): never refused for frequency. The latest line is kept; a
   * new line is shown at once when "Progress update interval" has passed since the last one
   * shown, else when it has, with its event then.
   */
  private async progress(
    tx: Transaction,
    call: Call,
    input: McpToolInput<'ticket_progress'>,
    settings: { progressUpdateIntervalSeconds: number },
  ) {
    const at = this.now();
    const intervalMs = settings.progressUpdateIntervalSeconds * this.options.secondMs;
    const shownAt = call.run.progressShownAt;
    const due = shownAt === null || at.getTime() - shownAt.getTime() >= intervalMs;
    await tx
      .update(schema.runs)
      .set({ progress: input.text, progressAt: at })
      .where(eq(schema.runs.id, call.run.id));
    let after: (() => void) | undefined;
    if (due) {
      await this.showProgress(tx, call, input.text, at);
    } else {
      const runId = call.run.id;
      const when = new Date(shownAt.getTime() + intervalMs);
      after = () => {
        this.armProgress(runId, when);
      };
    }
    return { output: { progress: input.text, at: at.toISOString() }, after };
  }

  private async showProgress(tx: Executor, call: Call, text: string, at: Date): Promise<void> {
    if (call.run.progressShown === text) {
      await tx
        .update(schema.runs)
        .set({ progressShownAt: at })
        .where(eq(schema.runs.id, call.run.id));
      return;
    }
    await tx
      .update(schema.runs)
      .set({ progressShown: text, progressShownAt: at })
      .where(eq(schema.runs.id, call.run.id));
    await recordEvent(tx, {
      actor: 'agent',
      entityType: 'run',
      entityId: call.run.id,
      projectId: call.project.id,
      type: 'run.progress',
      payload: { ...this.agentFacts(call), text: shorten(text, 200) },
      at,
    });
  }

  private armProgress(runId: string, when: Date): void {
    if (this.progressTimers.has(runId)) return;
    const timer = setTimeout(
      () => {
        this.progressTimers.delete(runId);
        void this.progressDue(runId).catch((error: unknown) => {
          this.log.error({ err: error, run: runId }, 'progress line not shown');
        });
      },
      Math.max(0, when.getTime() - this.now().getTime()),
    );
    this.progressTimers.set(runId, timer);
  }

  /** The interval has passed: the latest line is shown if it is newer than the one shown. */
  private async progressDue(runId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!run?.projectId) return;
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, run.projectId))
        .for('no key update');
      const call = await this.load(tx, runId, run.machineId, true).catch((error: unknown) => {
        if (error instanceof Refusal) return null;
        throw error;
      });
      if (!call || !ACTIVE.has(call.run.status)) return;
      const { progress, progressAt, progressShownAt } = call.run;
      if (progress === null || progressAt === null) return;
      if (progressShownAt !== null && progressAt <= progressShownAt) return;
      await this.showProgress(tx, call, progress, this.now());
    });
  }

  /** At start: progress lines received and not shown yet get their timers back. */
  async restoreTimers(): Promise<void> {
    const { progressUpdateIntervalSeconds } = await resolveSettings(this.db, [
      'progressUpdateIntervalSeconds',
    ]);
    const pending = await this.db
      .select({ id: schema.runs.id, shownAt: schema.runs.progressShownAt })
      .from(schema.runs)
      .where(
        and(
          inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
          sql`${schema.runs.progressAt} > ${schema.runs.progressShownAt}`,
        ),
      );
    for (const run of pending) {
      if (!run.shownAt) continue;
      this.armProgress(
        run.id,
        new Date(run.shownAt.getTime() + progressUpdateIntervalSeconds * this.options.secondMs),
      );
    }
  }

  private checkComment(field: string, text: string, max: number): McpErrorDetail | null {
    return text.length > max ? tooLong(this.texts, field, 'commentMaxLength', max) : null;
  }

  private tooLongRefusal(details: (McpErrorDetail | null)[]): void {
    const found = details.filter((detail): detail is McpErrorDetail => detail !== null);
    if (found.length > 0) {
      throw refuse(
        'VALIDATION_FAILED',
        part(this.texts, 'too-long', {
          details: found.map((detail) => detail.message).join('; '),
        }),
        found,
      );
    }
  }

  /** `ticket_comment`: a `note` on the run's ticket. */
  private async comment(
    tx: Transaction,
    call: Call,
    input: McpToolInput<'ticket_comment'>,
    settings: { commentMaxLength: number },
  ) {
    this.tooLongRefusal([this.checkComment('body', input.body, settings.commentMaxLength)]);
    const row = await this.insertComment(tx, call, 'note', input.body);
    const keys = await this.profileKeys(tx);
    return { output: { comment: mcpComment(row, keys) } };
  }

  /** `ticket_ask` (04, section 6): a `question`, and the ticket moves to `waiting_human`. */
  private async ask(
    tx: Transaction,
    call: Call,
    input: McpToolInput<'ticket_ask'>,
    settings: { commentMaxLength: number },
  ) {
    this.requireDeciding(call, 'ticket_ask');
    this.tooLongRefusal([this.checkComment('question', input.question, settings.commentMaxLength)]);
    const row = await this.insertComment(tx, call, 'question', input.question);
    const updated = await applyRunAction(tx, {
      projectKey: call.project.key,
      ticket: call.ticket,
      action: 'question_asked',
      actor: 'agent',
      agent: { key: call.profile.key, name: call.profile.name },
      runId: call.run.id,
      commentId: row.id,
      now: this.now(),
    });
    if (!updated) throw new Error('ticket changed status during ticket_ask');
    const keys = await this.profileKeys(tx);
    return {
      output: {
        comment: mcpComment(row, keys),
        ticket: await this.mcpTicket(tx, call.project.key, updated),
      },
    };
  }

  /**
   * `ticket_give_up`: the reason and what was tried become the agent's note, and the run's
   * outcome; the run ends as failed when the turn ends (05, section 4.8; owner's decision, lot 2
   * step K).
   */
  private async giveUp(
    tx: Transaction,
    call: Call,
    input: McpToolInput<'ticket_give_up'>,
    settings: { commentMaxLength: number },
  ) {
    this.requireDeciding(call, 'ticket_give_up');
    this.tooLongRefusal([
      this.checkComment('reason', input.reason, settings.commentMaxLength),
      this.checkComment('tried', input.tried, settings.commentMaxLength),
    ]);
    await this.insertComment(
      tx,
      call,
      'note',
      `I am giving up on this ticket.\n\nWhy:\n\n${input.reason}\n\nWhat I tried:\n\n${input.tried}`,
    );
    await tx
      .update(schema.runs)
      .set({ decision: 'gave_up', outcome: input.reason, updatedAt: this.now() })
      .where(eq(schema.runs.id, call.run.id));
    return { output: { ticket: await this.mcpTicket(tx, call.project.key, call.ticket) } };
  }

  /**
   * `ticket_update` (06, section 4.3; owner's answer 8, lot 5 step E1): a `proposed` or `todo`
   * ticket of the planning run's project, within the owner's form limits, with the owner's edit's
   * events naming the agent and its run. `blocked_by` replaces the ticket's whole list.
   */
  /**
   * `plan_propose` (06, section 4.4; lot 5 step E1b): the state refusals first and alone, then
   * every problem of the plan at once (`VALIDATION_FAILED`); accepted, the plan is kept with its
   * tickets, the request is `plan_proposed`, and the run's decision is taken.
   */
  private async planPropose(tx: Transaction, call: PlanCall, input: McpToolInput<'plan_propose'>) {
    const number = String(call.request.number);
    if (call.run.decision !== null) {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'plan-decided'));
    }
    // Only a question of a run still active waits: one left by an ended run never blocks.
    if ((await waitingQuestion(tx, call.request.id)) !== null) {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'request-waiting-answer', { request: number, tool: 'plan_propose' }),
      );
    }
    const status = RequestStatus.parse(call.request.status);
    if (status !== 'planning') {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'request-not-planning', { request: number, status, tool: 'plan_propose' }),
      );
    }
    if (call.project?.status === 'archived') {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'plan-project-archived', { project: call.project.key }),
      );
    }
    const checked = await checkPlan(tx, {
      request: call.request,
      project: call.project,
      plan: input,
      texts: this.texts,
      bootstrap: (await this.options.templates()).bootstrap,
    });
    if (!checked.accepted) {
      throw refuse(
        'VALIDATION_FAILED',
        part(this.texts, 'plan-refused', {
          problems: checked.problems
            .map((each) =>
              part(this.texts, 'plan-problem', { place: each.place, message: each.message }),
            )
            .join('\n'),
        }),
        checked.problems.map((each) => ({ field: each.field, message: each.message })),
      );
    }
    const at = this.now();
    const { plan, request } = await recordPlan(tx, {
      request: call.request,
      project: call.project,
      summary: input.summary,
      accepted: checked,
      agent: { key: call.profile.key, name: call.profile.name },
      runId: call.run.id,
      at,
    });
    await tx
      .update(schema.runs)
      .set({ decision: 'submitted', updatedAt: at })
      .where(eq(schema.runs.id, call.run.id));
    const added = new Map(
      checked.bootstrap === null ? [] : [[checked.bootstrap.key, checked.bootstrap.added]],
    );
    return {
      plan: { id: plan.id, status: PlanStatus.parse(plan.status) },
      request: this.mcpRequest({ request, project: call.project }),
      tickets: checked.tickets.map((ticket) => ({
        key: ticket.key,
        title: ticket.title,
        blocked_by: ticket.blocked_by,
        bootstrap: ticket.bootstrap,
        added_criteria: added.get(ticket.key) ?? [],
      })),
      note: [
        part(this.texts, 'plan-accepted', {
          request: number,
          count: String(checked.tickets.length),
        }),
        ...(checked.bootstrap === null
          ? []
          : [
              part(this.texts, 'plan-accepted-bootstrap', {
                key: checked.bootstrap.key,
                added: String(checked.bootstrap.added.length),
              }),
            ]),
      ].join(' '),
    };
  }

  private async planUpdate(
    tx: Transaction,
    call: ProjectPlanCall,
    input: McpToolInput<'ticket_update'>,
  ) {
    const { project } = call;
    if (call.run.decision !== null) {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'plan-decided'));
    }
    if (project.status === 'archived') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'project-archived-update'));
    }
    const ticket = await this.findTicket(tx, call, input.ticket);
    const reference = ticketReference(project.key, ticket.number);
    if (!EDITABLE_STATUSES.includes(TicketStatus.parse(ticket.status))) {
      throw refuse(
        'INVALID_TRANSITION',
        part(this.texts, 'ticket-not-editable', { ticket: reference, status: ticket.status }),
      );
    }
    const limits = await ticketLimits(tx);
    const criteria = input.acceptance_criteria ?? [];
    this.tooLongRefusal([
      input.title !== undefined && input.title.length > limits.ticketTitleMaxLength
        ? tooLong(this.texts, 'title', 'ticketTitleMaxLength', limits.ticketTitleMaxLength)
        : null,
      input.description !== undefined &&
      input.description.length > limits.ticketDescriptionMaxLength
        ? tooLong(
            this.texts,
            'description',
            'ticketDescriptionMaxLength',
            limits.ticketDescriptionMaxLength,
          )
        : null,
      criteria.length > limits.ticketMaxAcceptanceCriteria
        ? tooLong(
            this.texts,
            'acceptance_criteria',
            'ticketMaxAcceptanceCriteria',
            limits.ticketMaxAcceptanceCriteria,
            'criteria',
          )
        : null,
      ...criteria.map((criterion, index) =>
        criterion.length > limits.acceptanceCriterionMaxLength
          ? tooLong(
              this.texts,
              `acceptance_criteria.${String(index)}`,
              'acceptanceCriterionMaxLength',
              limits.acceptanceCriterionMaxLength,
            )
          : null,
      ),
    ]);
    const assignee =
      input.assignee === undefined || input.assignee === null
        ? null
        : await this.assigneeProfile(tx, input.assignee);

    // Dependencies: the new list, refused when it names the ticket or closes a cycle.
    const edges = await tx
      .select({
        ticketId: schema.ticketDependencies.ticketId,
        blockedById: schema.ticketDependencies.blockedById,
      })
      .from(schema.ticketDependencies)
      .where(eq(schema.ticketDependencies.projectId, project.id));
    const current = edges.filter((edge) => edge.ticketId === ticket.id);
    let added: TicketRow[] = [];
    let removed: string[] = [];
    if (input.blocked_by !== undefined) {
      const blockers = await this.blockerTickets(tx, project, input.blocked_by);
      if (blockers.some((row) => row.id === ticket.id)) {
        throw refuse(
          'VALIDATION_FAILED',
          part(this.texts, 'dependency-itself', { ticket: reference }),
          [{ field: 'blocked_by', message: part(this.texts, 'dependency-itself-field') }],
        );
      }
      const others = edges.filter((edge) => edge.ticketId !== ticket.id);
      for (const blocker of blockers) {
        const path = findPath(others, blocker.id, ticket.id);
        if (path === null) continue;
        const numbers = await tx
          .select({ id: schema.tickets.id, number: schema.tickets.number })
          .from(schema.tickets)
          .where(inArray(schema.tickets.id, path));
        const name = (id: string) =>
          ticketReference(project.key, numbers.find((row) => row.id === id)?.number ?? 0);
        const cycle = [ticket.id, ...path].map(name).join(' → ');
        throw refuse(
          'VALIDATION_FAILED',
          part(this.texts, 'dependency-cycle', { ticket: reference, cycle }),
          [{ field: 'blocked_by', message: part(this.texts, 'dependency-cycle-field', { cycle }) }],
        );
      }
      added = blockers.filter((row) => !current.some((edge) => edge.blockedById === row.id));
      removed = current
        .map((edge) => edge.blockedById)
        .filter((id) => !blockers.some((row) => row.id === id));
    }

    const was = {
      type: ticket.type,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: acceptanceCriteria(ticket),
      priority: ticket.priority,
    };
    const asked = {
      type: input.type,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptance_criteria,
      priority: input.priority,
    };
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(asked).filter(
        ([field, value]) =>
          value !== undefined &&
          JSON.stringify(value) !== JSON.stringify(was[field as keyof typeof was]),
      ),
    );
    const assigneeChanged =
      input.assignee !== undefined && (assignee?.id ?? null) !== ticket.assigneeProfileId;
    const dependenciesChanged = added.length > 0 || removed.length > 0;
    if (Object.keys(changes).length === 0 && !assigneeChanged && !dependenciesChanged) {
      return { ticket: await this.mcpTicket(tx, project.key, ticket) };
    }

    const at = this.now();
    const [updated] = await tx
      .update(schema.tickets)
      .set({
        ...changes,
        ...(assigneeChanged ? { assigneeProfileId: assignee?.id ?? null } : {}),
        updatedAt: at,
      })
      .where(eq(schema.tickets.id, ticket.id))
      .returning();
    if (!updated) throw new Error('ticket disappeared');
    const facts = {
      project: project.key,
      ticket: reference,
      agent: call.profile.key,
      agentName: call.profile.name,
      runId: call.run.id,
    };
    if (Object.keys(changes).length > 0 || assigneeChanged) {
      // Long texts are not copied into the event log: the fields changed are named.
      const { type, title, priority } = changes;
      await recordEvent(tx, {
        actor: 'agent',
        ...ticketEntity(updated),
        type: 'ticket.updated',
        payload: {
          ...facts,
          fields: [...Object.keys(changes), ...(assigneeChanged ? ['assignee'] : [])],
          type,
          title,
          priority,
          ...(assigneeChanged ? { assignee: assignee?.key ?? null } : {}),
          ...(assigneeChanged && assignee ? { assigneeName: assignee.name } : {}),
        },
        at,
      });
    }
    if (removed.length > 0) {
      const gone = await tx
        .select({ id: schema.tickets.id, number: schema.tickets.number })
        .from(schema.tickets)
        .where(inArray(schema.tickets.id, removed));
      await tx
        .delete(schema.ticketDependencies)
        .where(
          and(
            eq(schema.ticketDependencies.ticketId, ticket.id),
            inArray(schema.ticketDependencies.blockedById, removed),
          ),
        );
      for (const row of gone.sort((a, b) => a.number - b.number)) {
        await recordEvent(tx, {
          actor: 'agent',
          ...ticketEntity(updated),
          type: 'ticket.dependency_removed',
          payload: { ...facts, blockedBy: ticketReference(project.key, row.number) },
          at,
        });
      }
    }
    if (added.length > 0) {
      await tx.insert(schema.ticketDependencies).values(
        added.map((row) => ({
          projectId: project.id,
          ticketId: ticket.id,
          blockedById: row.id,
          createdAt: at,
        })),
      );
      for (const row of added) {
        await recordEvent(tx, {
          actor: 'agent',
          ...ticketEntity(updated),
          type: 'ticket.dependency_added',
          payload: { ...facts, blockedBy: ticketReference(project.key, row.number) },
          at,
        });
      }
    }
    return { ticket: await this.mcpTicket(tx, project.key, updated) };
  }

  /** The profile `key` names as a ticket's assignee, refused when none or one that reviews. */
  private async assigneeProfile(executor: Executor, key: string): Promise<ProfileRow> {
    const [assignee] = await executor
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, key));
    if (!assignee) {
      throw refuse('NOT_FOUND', part(this.texts, 'profile-unknown', { key }), [
        { field: 'assignee', message: part(this.texts, 'profile-unknown-field') },
      ]);
    }
    // Only a builder or a writer implements a ticket (03, section 4; lot 3 step H1).
    if (assignee.role !== 'builder' && assignee.role !== 'writer') {
      throw refuse(
        'VALIDATION_FAILED',
        part(this.texts, 'assignee-reviewer', { name: assignee.name }),
        [{ field: 'assignee', message: part(this.texts, 'assignee-reviewer-field') }],
      );
    }
    return assignee;
  }

  /** The tickets of the project `blocked_by` names, refused when one is not in the project. */
  private async blockerTickets(
    executor: Executor,
    project: ProjectRow,
    blockedBy: readonly string[],
  ): Promise<TicketRow[]> {
    const references = [...new Set(blockedBy)];
    const blockers: TicketRow[] = [];
    const missing: string[] = [];
    for (const reference of references) {
      const [key, number] = reference.split('-');
      const [row] =
        key === project.key
          ? await executor
              .select()
              .from(schema.tickets)
              .where(
                and(
                  eq(schema.tickets.projectId, project.id),
                  eq(schema.tickets.number, Number(number)),
                ),
              )
          : [];
      if (row) blockers.push(row);
      else missing.push(reference);
    }
    if (missing.length > 0) {
      throw refuse(
        'NOT_FOUND',
        part(this.texts, 'blocked-by-unknown', {
          references: missing.join(', '),
          project: project.key,
        }),
        missing.map((reference) => ({
          field: 'blocked_by',
          message: part(this.texts, 'blocked-by-unknown-field', { reference }),
        })),
      );
    }
    return blockers;
  }

  /**
   * `ticket_create` (06, section 4.3): a `proposed` ticket, created by the agent, within the
   * run's limit and the owner's form limits.
   */
  private async create(
    tx: Transaction,
    call: Call,
    input: McpToolInput<'ticket_create'>,
    settings: {
      ticketTitleMaxLength: number;
      ticketDescriptionMaxLength: number;
      ticketMaxAcceptanceCriteria: number;
      acceptanceCriterionMaxLength: number;
      maxAgentTicketsPerRun: number;
    },
  ) {
    const { project } = call;
    if (project.status === 'archived') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'project-archived'));
    }
    if (project.setupStatus !== 'ready') {
      throw refuse('INVALID_TRANSITION', part(this.texts, 'project-not-ready'));
    }
    const [created] = await tx
      .select({ total: count() })
      .from(schema.tickets)
      .where(eq(schema.tickets.createdByRunId, call.run.id));
    const limit = settings.maxAgentTicketsPerRun;
    if ((created?.total ?? 0) >= limit) {
      throw refuse(
        'LIMIT_REACHED',
        part(this.texts, 'ticket-limit', {
          limit: String(limit),
          setting: SETTINGS.maxAgentTicketsPerRun.label,
        }),
        [
          {
            setting: 'maxAgentTicketsPerRun',
            message: part(this.texts, 'ticket-limit-field', { limit: String(limit) }),
          },
        ],
      );
    }
    this.tooLongRefusal([
      input.title.length > settings.ticketTitleMaxLength
        ? tooLong(this.texts, 'title', 'ticketTitleMaxLength', settings.ticketTitleMaxLength)
        : null,
      input.description.length > settings.ticketDescriptionMaxLength
        ? tooLong(
            this.texts,
            'description',
            'ticketDescriptionMaxLength',
            settings.ticketDescriptionMaxLength,
          )
        : null,
      input.acceptance_criteria.length > settings.ticketMaxAcceptanceCriteria
        ? tooLong(
            this.texts,
            'acceptance_criteria',
            'ticketMaxAcceptanceCriteria',
            settings.ticketMaxAcceptanceCriteria,
            'criteria',
          )
        : null,
      ...input.acceptance_criteria.map((criterion, index) =>
        criterion.length > settings.acceptanceCriterionMaxLength
          ? tooLong(
              this.texts,
              `acceptance_criteria.${String(index)}`,
              'acceptanceCriterionMaxLength',
              settings.acceptanceCriterionMaxLength,
            )
          : null,
      ),
    ]);

    const assignee =
      input.assignee === undefined ? undefined : await this.assigneeProfile(tx, input.assignee);
    const blockers = await this.blockerTickets(tx, project, input.blocked_by ?? []);

    const [counter] = await tx
      .update(schema.projects)
      .set({ lastTicketNumber: sql`${schema.projects.lastTicketNumber} + 1` })
      .where(eq(schema.projects.id, project.id))
      .returning({ number: schema.projects.lastTicketNumber });
    if (!counter) throw new Error('project disappeared');
    const at = this.now();
    const [ticket] = await tx
      .insert(schema.tickets)
      .values({
        projectId: project.id,
        number: counter.number,
        type: input.type,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptance_criteria,
        priority: input.priority,
        status: 'proposed',
        createdBy: 'agent',
        createdByProfileId: call.profile.id,
        createdByRunId: call.run.id,
        assigneeProfileId: assignee?.id ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!ticket) throw new Error('ticket not inserted');
    if (blockers.length > 0) {
      await tx.insert(schema.ticketDependencies).values(
        blockers.map((row) => ({
          projectId: project.id,
          ticketId: ticket.id,
          blockedById: row.id,
          createdAt: at,
        })),
      );
    }
    await recordEvent(tx, {
      actor: 'agent',
      ...ticketEntity(ticket),
      type: 'ticket.created',
      payload: {
        ...this.agentFacts(call),
        ticket: ticketReference(project.key, ticket.number),
        type: ticket.type,
        title: ticket.title,
        priority: ticket.priority,
        status: ticket.status,
        blockedBy: blockers.map((row) => ticketReference(project.key, row.number)).sort(),
        assignee: assignee?.key ?? null,
        ...(assignee ? { assigneeName: assignee.name } : {}),
      },
      at,
    });
    return { output: { ticket: await this.mcpTicket(tx, project.key, ticket) } };
  }

  /**
   * `ticket_submit` (04, sections 3.1 and 3.3; lot 3 step F): every check on the daemon's facts
   * (05, section 4.9), with the texts of `agents/templates/submit-checks.md`. A refused submission
   * is kept on the run (`SubmissionRefused`); an accepted one on the run and the ticket, with each
   * check's result and the workflow flag. The answer is `pending_ci`: the run waits for the CI
   * result of the commit pushed (`CiWatcher`, lot 3 step G1a).
   */
  private async submit(
    tx: Transaction,
    call: Call,
    report: McpToolInput<'ticket_submit'>,
    workspace: WorkspaceFacts,
  ) {
    this.requireWorking(call, 'ticket_submit');
    const texts = (await this.options.templates())['submit-checks'];
    const criteria = acceptanceCriteria(call.ticket);
    const outOfRange = criteriaOutOfRange(texts, criteria, report);
    if (outOfRange) throw new Refusal(outOfRange);
    const roundCommits = z
      .array(CiRound)
      .parse(call.run.ciRounds)
      .filter((round) => round.confirmedAt !== null)
      .map((round) => ({ commit: round.commit, kind: round.kind }));
    const request = standingRequest(call.ticket);
    const checked = checkSubmission(texts, {
      roundCommits,
      requestCommit:
        request === null || request.commit === null
          ? null
          : { commit: request.commit, by: request.by },
      ticketType: TicketType.parse(call.ticket.type),
      criteria,
      report,
      workspace,
      baseBranch: call.run.baseBranch,
    });
    const at = this.now();
    // Converted once, here: kept by index from 0, as lot 4 kept it (owner's answer, lot 5 step B).
    const stored = storedReport(report);
    const record: SubmissionRecord = {
      at: at.toISOString(),
      report: stored,
      checks: checked.checks,
      workflowChanges: checked.workflowChanges,
      workflowReason: checked.workflowReason,
    };
    const refused = refusal(texts, checked);
    if (refused) throw new SubmissionRefused(refused, call, record);
    const [updated] = await tx
      .update(schema.tickets)
      .set({
        dodReport: stored,
        dodChecks: checked.checks,
        workflowChanges: checked.workflowChanges,
        workflowReason: checked.workflowReason,
        // Opened or updated after the answer, never inside the call (04, section 3.1).
        pullRequestWantedSince: at,
        updatedAt: at,
      })
      .where(eq(schema.tickets.id, call.ticket.id))
      .returning();
    if (!updated) throw new Error('ticket disappeared');
    // The CI result is that of the commit pushed now (04, section 3.1; lot 3 step G1a). Runs
    // started before 0.4.0 kept no CI waits: today's values.
    const waits =
      call.run.ciWaitTimeoutMinutes === null || call.run.ciStartWaitMinutes === null
        ? await resolveSettings(tx, ['ciStartWaitMinutes', 'ciWaitTimeoutMinutes'], call.project.id)
        : {
            ciStartWaitMinutes: call.run.ciStartWaitMinutes,
            ciWaitTimeoutMinutes: call.run.ciWaitTimeoutMinutes,
          };
    const ciCommit = workspace.push?.status === 'pushed' ? workspace.push.head : null;
    await tx
      .update(schema.runs)
      .set({
        decision: 'submitted',
        outcome: report.summary,
        submission: record,
        ciCommit,
        ...waits,
        ciWaitStartedAt: null,
        ciResult: null,
        ciCheckedAt: null,
        ciCheckFailure: null,
        ciRoundRefusal: null,
        updatedAt: at,
      })
      .where(eq(schema.runs.id, call.run.id));
    // An open pull request runs CI on the pushed commit at once, whether or not its description
    // is updated: the wait begins now (owner's point 1, step G1).
    if (ciCommit !== null && call.ticket.pullRequestState === 'open') {
      await startCiWait(tx, {
        run: { id: call.run.id, ciCommit },
        ticket: call.ticket,
        projectKey: call.project.key,
        pullRequest: call.ticket.pullRequestNumber,
        at,
      });
    }
    await recordEvent(tx, {
      actor: 'agent',
      ...ticketEntity(call.ticket),
      type: 'ticket.submitted',
      payload: {
        ...this.agentFacts(call),
        criteria: criteria.length,
        workflowChanges: checked.workflowChanges,
      },
      at,
    });
    const ticketId = call.ticket.id;
    return {
      output: {
        result: 'pending_ci' as const,
        ticket: await this.mcpTicket(tx, call.project.key, updated),
      },
      after: () => {
        this.options.pullRequestWanted(ticketId);
      },
    };
  }

  /** A refused submission, kept as the run's latest with its event, in a transaction of its own. */
  private async recordRefusedSubmission({ call, record }: SubmissionRefused) {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, call.project.id))
        .for('no key update');
      const [run] = await tx
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(eq(schema.runs.id, call.run.id))
        .for('update');
      if (!run) return;
      await tx
        .update(schema.runs)
        .set({ refusedSubmission: record, updatedAt: this.now() })
        .where(eq(schema.runs.id, call.run.id));
      // Every failed check, also those the agent was not told about after a failed push.
      const failed = record.checks.flatMap((each) =>
        each.result === 'failed' ? [each.check] : [],
      );
      await recordEvent(tx, {
        actor: 'agent',
        ...ticketEntity(call.ticket),
        type: 'ticket.submission_refused',
        payload: { ...this.agentFacts(call), failed },
        at: this.now(),
      });
    });
  }
}

/** True when at least one ticket this one depends on is not `done` (01, section 3.4). */
const blockedFlag = sql<boolean>`exists (
  select 1 from ticket_dependencies d
  join tickets b on b.id = d.blocked_by_id
  where d.ticket_id = "tickets"."id" and b.status <> 'done'
)`.mapWith(Boolean);

function summary(
  projectKey: string,
  ticket: TicketRow,
  keys: ReadonlyMap<string, string>,
  blocked: boolean,
): McpTicketSummary {
  return {
    number: ticketReference(projectKey, ticket.number),
    type: TicketType.parse(ticket.type),
    title: ticket.title,
    status: TicketStatus.parse(ticket.status),
    priority: TicketPriority.parse(ticket.priority),
    assignee:
      ticket.assigneeProfileId === null ? null : (keys.get(ticket.assigneeProfileId) ?? null),
    blocked,
  };
}

function mcpComment(row: CommentRow, keys: ReadonlyMap<string, string>): McpComment {
  const author: McpComment['author'] =
    row.author === 'agent' && row.authorProfileId !== null
      ? { agent: keys.get(row.authorProfileId) ?? 'unknown' }
      : row.author === 'owner'
        ? 'owner'
        : 'system';
  return {
    id: row.id,
    author,
    kind: CommentKind.parse(row.kind),
    body: row.body,
    answers: row.answersCommentId,
    created_at: row.createdAt.toISOString(),
  };
}

/** The number in a cursor (`after-12`); an unknown cursor is refused. */
function cursorNumber(texts: Texts, cursor: string): number {
  const match = /^after-(\d{1,10})$/.exec(cursor);
  if (!match) {
    throw refuse('VALIDATION_FAILED', part(texts, 'cursor-unknown'), [
      { field: 'cursor', message: part(texts, 'cursor-unknown-field') },
    ]);
  }
  return Number(match[1]);
}
