import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  AgentRole,
  CommentKind,
  DodReport,
  HarnessElement,
  MCP_OUTPUT_MAX_CHARACTERS,
  MCP_TICKET_LIST_PAGE_SIZE,
  MCP_TOOLS,
  McpPermission,
  SETTINGS,
  ProjectKind,
  TicketPriority,
  TicketStatus,
  TicketType,
  shorten,
  type McpCall,
  type McpComment,
  type McpError,
  type McpErrorDetail,
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
import type { RunRow } from '../runs/model.js';
import { resolveSettings } from '../settings/store.js';
import {
  acceptanceCriteria,
  ticketEntity,
  ticketReference,
  type CommentRow,
  type TicketRow,
} from '../tickets/model.js';
import { recordPush } from '../tickets/branch.js';
import { applyRunAction } from '../tickets/transitions.js';
import type { Templates } from '../agents/files.js';
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

const ENDED_MESSAGE =
  'This run has ended (it was stopped, or its time is over): its token is no longer valid. Stop working: nothing you do now will be recorded.';

function tooLong(field: string, setting: SettingName, max: number, unit = 'characters') {
  return {
    field,
    setting,
    message: `${field}: at most ${String(max)} ${unit} (setting "${SETTINGS[setting].label}": ${String(max)})`,
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
}

export class McpBackend {
  private readonly db: Database;
  private readonly log: FastifyBaseLogger;
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: McpBackendOptions) {
    this.db = options.db;
    this.log = options.log;
  }

  private now(): Date {
    return this.options.now();
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
    let code: string = 'ok';
    try {
      const [found] = await this.db
        .select({ id: schema.runs.id, machineId: schema.runs.machineId })
        .from(schema.runs)
        .where(eq(schema.runs.runTokenHash, hashCredential(message.payload.runToken)));
      if (!found || found.machineId !== machineId) throw refuse('FORBIDDEN', ENDED_MESSAGE);
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
          `The input of ${tool} is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`,
          parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || 'input',
            message: issue.message,
          })),
        );
      }
      const output = READING.has(tool)
        ? await this.read(tool, found.id, machineId, parsed.data, (call) => {
            reference = ticketReference(call.project.key, call.ticket.number);
          })
        : await this.write(tool, found.id, machineId, message, parsed.data, (call) => {
            reference = ticketReference(call.project.key, call.ticket.number);
          });
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
      throw refuse('FORBIDDEN', ENDED_MESSAGE);
    }
    if (run.ticketId === null) throw new Error(`run ${run.id} has no ticket`);
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
        run: row.run,
        machine: { id: row.run.machineId, name: row.machineName },
        result,
        branch: workspace.branch,
        when: 'submission',
        now: this.now(),
      });
    });
  }

  /** The profile's MCP permissions (06, section 5): refused with the role named. */
  private permit(call: Call, tool: McpToolName): void {
    const permissions = z.array(McpPermission).parse(call.profile.mcpPermissions);
    if (!permissions.includes(tool)) {
      throw refuse(
        'FORBIDDEN',
        `Your role (${AgentRole.parse(call.profile.role)}) does not allow ${tool}.`,
      );
    }
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
        // No ticket has a pull request before the server opens them (lot 3 step F).
        return { pull_request: null, ci: null } satisfies McpToolOutput<'ci_status'>;
      default:
        throw new Error(`${tool} is not a reading tool`);
    }
  }

  private projectGet({ project }: Call) {
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

  /** A ticket of the run's project by its reference (`WEB-12`), or the run's own. */
  private async findTicket(executor: Executor, call: Call, reference?: string): Promise<TicketRow> {
    if (reference === undefined) return call.ticket;
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
        `No ticket ${reference} in the project ${call.project.key}: use ticket_list to find tickets.`,
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
      dod_report: ticket.dodReport === null ? null : DodReport.parse(ticket.dodReport),
      pull_request_url: null,
    };
  }

  private async ticketGet(call: Call, input: McpToolInput<'ticket_get'>) {
    const ticket = await this.findTicket(this.db, call, input.ticket);
    const full = await this.mcpTicket(this.db, call.project.key, ticket);
    if (jsonLength({ ticket: full }) <= MCP_OUTPUT_MAX_CHARACTERS) return { ticket: full };
    // Only raised settings make a ticket this long: its description is cut.
    const description = cutToFit(
      full.description,
      MCP_OUTPUT_MAX_CHARACTERS,
      'The rest of the description cannot be read through the tools; ask the owner with ticket_ask if you need it.',
      (candidate) => jsonLength({ ticket: { ...full, description: candidate } }),
    );
    return { ticket: { ...full, description } };
  }

  private async ticketList(call: Call, input: McpToolInput<'ticket_list'>) {
    const after = input.cursor === undefined ? 0 : cursorNumber(input.cursor);
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
        throw refuse('NOT_FOUND', `No agent profile ${input.assignee}: use agent_list.`);
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

  private async ticketComments(call: Call, input: McpToolInput<'ticket_comments'>) {
    const ticket = await this.findTicket(this.db, call, input.ticket);
    const offset = input.cursor === undefined ? 0 : cursorNumber(input.cursor);
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
        body: cutToFit(
          first.body,
          room,
          'The rest of this comment cannot be read through the tools; ask the owner with ticket_ask if you need it.',
          (candidate) => jsonLength({ ...first, body: candidate }),
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
    if (!projectRow) throw refuse('FORBIDDEN', ENDED_MESSAGE);
    const agentTicketsSetting = await resolveSettings(
      this.db,
      ['maxAgentTicketsPerRun'],
      projectRow.projectId,
    );
    const result = await this.db
      .transaction(async (tx): Promise<Handled> => {
        // The project's row lock first, then the run's: the order of every ticket change.
        await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectRow.projectId))
          .for('no key update');
        const call = await this.load(tx, runId, machineId, true);
        known(call);
        this.permit(call, tool);
        if (!ACTIVE.has(call.run.status)) throw refuse('FORBIDDEN', ENDED_MESSAGE);
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
          case 'review_approve':
          case 'review_request_changes':
            // Only a review run of a ticket in review (06, section 4.5); the server starts none yet.
            if (call.run.purpose !== 'review') {
              throw refuse(
                'INVALID_TRANSITION',
                `${tool} is only for a review run of a ticket in in_review; the purpose of this run is ${call.run.purpose}.`,
              );
            }
            throw new Error(`${tool} in a review run is not implemented yet`);
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
      throw refuse('INVALID_TRANSITION', 'You already submitted this ticket: end your turn now.');
    }
    if (call.run.decision === 'gave_up') {
      throw refuse('INVALID_TRANSITION', 'You already gave up this ticket: end your turn now.');
    }
    if (call.ticket.status === 'waiting_human') {
      throw refuse(
        'INVALID_TRANSITION',
        `You asked the owner a question and the ticket waits for the answer: ${tool} is not possible now. End your turn; the answer arrives as your next message.`,
      );
    }
    if (call.ticket.status !== 'in_progress') {
      throw refuse(
        'INVALID_TRANSITION',
        `The ticket is ${call.ticket.status}: ${tool} needs it in_progress.`,
      );
    }
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
      if (!run) return;
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
    return text.length > max ? tooLong(field, 'commentMaxLength', max) : null;
  }

  private tooLongRefusal(details: (McpErrorDetail | null)[]): void {
    const found = details.filter((detail): detail is McpErrorDetail => detail !== null);
    if (found.length > 0) {
      throw refuse(
        'VALIDATION_FAILED',
        `Too long: ${found.map((detail) => detail.message).join('; ')}.`,
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
    this.requireWorking(call, 'ticket_ask');
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
    if (!updated) throw new Error('ticket left in_progress during ticket_ask');
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
    this.requireWorking(call, 'ticket_give_up');
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
      throw refuse(
        'INVALID_TRANSITION',
        'The project is archived: no ticket can be created in it.',
      );
    }
    if (project.setupStatus !== 'ready') {
      throw refuse(
        'INVALID_TRANSITION',
        'The repository setup of the project is not finished: no ticket can be created yet.',
      );
    }
    const [created] = await tx
      .select({ total: count() })
      .from(schema.tickets)
      .where(eq(schema.tickets.createdByRunId, call.run.id));
    const limit = settings.maxAgentTicketsPerRun;
    if ((created?.total ?? 0) >= limit) {
      throw refuse(
        'LIMIT_REACHED',
        `Limit of ${String(limit)} tickets per run reached (setting "${SETTINGS.maxAgentTicketsPerRun.label}": ${String(limit)}). Record what you found with ticket_comment instead.`,
        [
          {
            setting: 'maxAgentTicketsPerRun',
            message: `at most ${String(limit)} tickets per run`,
          },
        ],
      );
    }
    this.tooLongRefusal([
      input.title.length > settings.ticketTitleMaxLength
        ? tooLong('title', 'ticketTitleMaxLength', settings.ticketTitleMaxLength)
        : null,
      input.description.length > settings.ticketDescriptionMaxLength
        ? tooLong('description', 'ticketDescriptionMaxLength', settings.ticketDescriptionMaxLength)
        : null,
      input.acceptance_criteria.length > settings.ticketMaxAcceptanceCriteria
        ? tooLong(
            'acceptance_criteria',
            'ticketMaxAcceptanceCriteria',
            settings.ticketMaxAcceptanceCriteria,
            'criteria',
          )
        : null,
      ...input.acceptance_criteria.map((criterion, index) =>
        criterion.length > settings.acceptanceCriterionMaxLength
          ? tooLong(
              `acceptance_criteria.${String(index)}`,
              'acceptanceCriterionMaxLength',
              settings.acceptanceCriterionMaxLength,
            )
          : null,
      ),
    ]);

    let assignee: ProfileRow | undefined;
    if (input.assignee !== undefined) {
      [assignee] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.key, input.assignee));
      if (!assignee) {
        throw refuse('NOT_FOUND', `No agent profile ${input.assignee}: use agent_list.`, [
          { field: 'assignee', message: 'unknown agent profile' },
        ]);
      }
    }
    const references = [...new Set(input.blocked_by ?? [])];
    const blockers: TicketRow[] = [];
    const missing: string[] = [];
    for (const reference of references) {
      const [key, number] = reference.split('-');
      const [row] =
        key === project.key
          ? await tx
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
        `No ticket ${missing.join(', ')} in the project ${project.key}: blocked_by names tickets of the same project.`,
        missing.map((reference) => ({
          field: 'blocked_by',
          message: `unknown ticket ${reference}`,
        })),
      );
    }

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
   * check's result and the workflow flag. The run ends `succeeded` and the ticket moves to
   * `in_review` when the turn ends.
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
    const checked = checkSubmission(texts, {
      ticketType: TicketType.parse(call.ticket.type),
      criteria,
      report,
      workspace,
      baseBranch: call.run.baseBranch,
    });
    const at = this.now();
    const record: SubmissionRecord = {
      at: at.toISOString(),
      report,
      checks: checked.checks,
      workflowChanges: checked.workflowChanges,
      workflowReason: checked.workflowReason,
    };
    const refused = refusal(texts, checked);
    if (refused) throw new SubmissionRefused(refused, call, record);
    const [updated] = await tx
      .update(schema.tickets)
      .set({
        dodReport: report,
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
    await tx
      .update(schema.runs)
      .set({ decision: 'submitted', outcome: report.summary, submission: record, updatedAt: at })
      .where(eq(schema.runs.id, call.run.id));
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
        result: 'accepted' as const,
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
function cursorNumber(cursor: string): number {
  const match = /^after-(\d{1,10})$/.exec(cursor);
  if (!match) {
    throw refuse('VALIDATION_FAILED', 'cursor: pass back a next_cursor returned by this tool.', [
      { field: 'cursor', message: 'unknown cursor' },
    ]);
  }
  return Number(match[1]);
}
