import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  ACCOUNT_BUSY_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  CLAUDE_CODE_MIN_VERSION,
  Capability,
  FIRST_MESSAGE_MAX_BYTES,
  RunStatus,
  TicketStatus,
  claudeCodeSupport,
  maskSecrets,
  type Ack,
  type FailureReason,
  type GitCredential,
  type GitCredentialRequest,
  type Hello,
  type MachineUnavailable,
  type McpCall,
  type McpResult,
  type PauseReason,
  type Run,
  type RunChangeCause,
  type RunEndReason,
  type RunEvents,
  type RunQuotaLimited,
  type RunRefusal,
  type RunStart,
  type RunState,
  type ServerMessage,
} from '@orchestrator/protocol';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { loadShippedAgents, loadTemplates, type Templates } from '../agents/files.js';
import {
  FirstMessageTooLarge,
  answerMessage,
  answerResumeMessage,
  continueMessage,
  implementFirstMessage,
  nudgeMessage,
  runInstructions,
} from '../agents/messages.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { notifyRunLog } from '../realtime/changes.js';
import { createGitHubClient, GitHubUnreachableError } from '../github/client.js';
import { loadToken } from '../github/connection.js';
import { inspectToken } from '../github/token-check.js';
import { HttpError } from '../http.js';
import { hashCredential } from '../machines/credentials.js';
import { McpBackend } from '../mcp/backend.js';
import {
  capabilityLists,
  effectiveCapabilities,
  machineState,
  unusableReasons,
  type MachineRow,
} from '../machines/model.js';
import type { ProjectRow } from '../projects/model.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { resolveSettings } from '../settings/store.js';
import {
  ticketEntity,
  ticketReference,
  type CommentRow,
  type TicketRow,
} from '../tickets/model.js';
import { applyRunAction } from '../tickets/transitions.js';
import { implementTicket } from './first-message.js';
import {
  endOfReason,
  failureWords,
  isCounted,
  isLimited,
  reportedCommits,
  statusOfDaemonState,
  statusTimes,
  ticketBranchName,
  toRun,
  type AccountRow,
  type RunRow,
} from './model.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** What the run service needs of the daemon gateway. */
export interface RunGateway {
  /** Sends to the machine's current connection; false when it has none. */
  send(machineId: string, message: ServerMessage): boolean;
  isConnected(machineId: string): boolean;
}

export interface RunServiceOptions {
  db: Database;
  log: FastifyBaseLogger;
  key: SecretKey;
  githubApiUrl: string;
  /** Base of the clone URLs sent to daemons: `https://github.com`; tests use a local remote. */
  gitBaseUrl: string;
  now?: () => Date;
  /** Milliseconds in one second of the dispatch acknowledgement timeout; tests shorten it. */
  secondMs?: number;
}

/** Everything about one run, locked for the rest of the transaction. */
interface Locked {
  run: RunRow;
  project: ProjectRow;
  ticket: TicketRow | null;
  machine: MachineRow;
}

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);
const TERMINAL = new Set<string>(['succeeded', 'failed', 'cancelled']);

/** Runs a machine can be working on: fetching with a credential is allowed only for them. */
const FETCHING = new Set<string>(['dispatched', 'starting', 'running']);

const refuse = (refusal: RunRefusal, message: string) =>
  new HttpError(409, 'run_not_possible', message, { runRefusal: refusal });

/** `ort_` and 256 random bits: scoped to one run (06, section 2); only its hash is kept. */
function newRunToken(): string {
  return `ort_${randomBytes(32).toString('base64url')}`;
}

/**
 * Runs on the server (lot 2 step J): **Run now**, **Resume** and **Stop run** (07, section 3; 04,
 * section 2), the dispatch acknowledgement timeout (07, section 2), and the daemon's reports and
 * requests about runs (05, section 3.3). Every status change is written with its event in one
 * transaction holding the project's row lock, then the run's: the same order as ticket changes.
 */
export class RunService {
  private readonly db: Database;
  private readonly log: FastifyBaseLogger;
  private readonly secondMs: number;
  private gateway: RunGateway | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private agentFiles: Promise<{ templates: Templates; commonRules: string }> | undefined;
  private readonly mcp: McpBackend;

  constructor(private readonly options: RunServiceOptions) {
    this.db = options.db;
    this.log = options.log;
    this.secondMs = options.secondMs ?? 1000;
    this.mcp = new McpBackend({
      db: options.db,
      log: options.log,
      now: () => this.now(),
      secondMs: this.secondMs,
    });
  }

  /** The gateway is created with the service; the two know each other. */
  attach(gateway: RunGateway): void {
    this.gateway = gateway;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private send(machineId: string, message: ServerMessage): boolean {
    return this.gateway?.send(machineId, message) ?? false;
  }

  private files() {
    this.agentFiles ??= Promise.all([loadTemplates(), loadShippedAgents()]).then(
      ([templates, shipped]) => ({ templates, commonRules: shipped.commonRules }),
    );
    return this.agentFiles;
  }

  // ---------------------------------------------------------------------------------------------
  // Locks, status changes and ends

  private async lockProject(tx: Executor, where: ReturnType<typeof eq>): Promise<ProjectRow> {
    const [project] = await tx.select().from(schema.projects).where(where).for('no key update');
    if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
    return project;
  }

  /** Runs `work` with the run's project, then the run, locked; null when there is no such run. */
  private async withRun<T>(
    runId: string,
    work: (tx: Transaction, locked: Locked) => Promise<T>,
  ): Promise<T | null> {
    if (!z.uuid().safeParse(runId).success) return null;
    const [found] = await this.db
      .select({ projectId: schema.runs.projectId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    if (!found) return null;
    return this.db.transaction(async (tx) => {
      const project = await this.lockProject(tx, eq(schema.projects.id, found.projectId));
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update');
      if (!run) return null;
      const [ticket] =
        run.ticketId === null
          ? []
          : await tx.select().from(schema.tickets).where(eq(schema.tickets.id, run.ticketId));
      const [machine] = await tx
        .select()
        .from(schema.machines)
        .where(eq(schema.machines.id, run.machineId));
      if (!machine) throw new Error(`machine of run ${run.id} not found`);
      return work(tx, { run, project, ticket: ticket ?? null, machine });
    });
  }

  private reference(locked: Pick<Locked, 'project' | 'ticket'>): string {
    return locked.ticket ? ticketReference(locked.project.key, locked.ticket.number) : '';
  }

  /** Changes the run's status with its event; a terminal status also revokes the run's token. */
  private async setStatus(
    tx: Executor,
    locked: Locked,
    to: RunStatus,
    cause: RunChangeCause,
    facts: {
      pauseReason?: PauseReason;
      failureReason?: FailureReason;
      endReason?: RunEndReason;
      detail?: string;
      set?: Partial<typeof schema.runs.$inferInsert>;
    } = {},
  ): Promise<RunRow> {
    const now = this.now();
    const from = RunStatus.parse(locked.run.status);
    const terminal = TERMINAL.has(to);
    const [updated] = await tx
      .update(schema.runs)
      .set({
        status: to,
        updatedAt: now,
        ...(from === to ? {} : statusTimes(locked.run, now)),
        ...(facts.pauseReason === undefined ? {} : { pauseReason: facts.pauseReason }),
        ...(facts.failureReason === undefined ? {} : { failureReason: facts.failureReason }),
        ...(facts.endReason === undefined ? {} : { endReason: facts.endReason }),
        ...(facts.detail === undefined ? {} : { endDetail: facts.detail }),
        ...(terminal
          ? {
              endedAt: now,
              runTokenRevokedAt: locked.run.runTokenRevokedAt ?? now,
              ackDeadline: null,
            }
          : {}),
        ...facts.set,
      })
      .where(eq(schema.runs.id, locked.run.id))
      .returning();
    if (!updated) throw new Error(`run ${locked.run.id} not updated`);
    if (from !== to) {
      await recordEvent(tx, {
        actor:
          cause === 'owner_stopped' || cause === 'run_now' || cause === 'resume'
            ? 'owner'
            : 'system',
        entityType: 'run',
        entityId: locked.run.id,
        projectId: locked.project.id,
        type: 'run.status_changed',
        payload: {
          project: locked.project.key,
          ticket: this.reference(locked),
          machine: locked.machine.name,
          from,
          to,
          cause,
          ...(facts.pauseReason === undefined ? {} : { pauseReason: facts.pauseReason }),
          ...(facts.failureReason === undefined ? {} : { failureReason: facts.failureReason }),
          ...(facts.endReason === undefined ? {} : { endReason: facts.endReason }),
          ...(facts.detail === undefined ? {} : { detail: facts.detail }),
        },
        at: now,
      });
    }
    if (terminal) this.clearTimer(locked.run.id);
    locked.run = updated;
    return updated;
  }

  /**
   * Ends a run that failed or was cancelled, and returns its ticket to `todo` with a `system`
   * comment; a counted failure raises `attempt_count` (04, section 5).
   */
  private async fail(
    tx: Executor,
    locked: Locked,
    failureReason: FailureReason,
    cause: RunChangeCause,
    facts: { endReason?: RunEndReason; detail?: string; comment?: string } = {},
  ): Promise<void> {
    const status = failureReason === 'cancelled' ? 'cancelled' : 'failed';
    await this.setStatus(tx, locked, status, cause, {
      failureReason,
      endReason: facts.endReason,
      detail: facts.detail,
    });
    if (!locked.ticket) return;
    const counted = isCounted(failureReason);
    const words = failureWords(failureReason);
    const detail = facts.detail ? ` (${facts.detail})` : '';
    const comment =
      facts.comment ??
      (counted
        ? `Attempt ${String(locked.run.attempt)} failed on machine ${locked.machine.name}: ${words}${detail}. It counts as a failed attempt. The branch ${locked.run.branchName} is kept on that machine.`
        : `The run on machine ${locked.machine.name} ended: ${words}${detail}. It does not count as a failed attempt.`);
    await applyRunAction(tx, {
      projectKey: locked.project.key,
      ticket: locked.ticket,
      action: 'run_ended',
      actor: 'system',
      runId: locked.run.id,
      failureReason,
      attemptCounted: counted,
      comment,
      now: this.now(),
    });
  }

  private clearTimer(runId: string): void {
    clearTimeout(this.timers.get(runId));
    this.timers.delete(runId);
  }

  private armTimer(runId: string, messageId: string, deadline: Date): void {
    this.clearTimer(runId);
    const delay = Math.max(0, deadline.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      void this.dispatchTimedOut(runId, messageId).catch((error: unknown) => {
        this.log.error({ err: error, run: runId }, 'dispatch acknowledgement timeout failed');
      });
    }, delay);
    this.timers.set(runId, timer);
  }

  /** At start: the dispatches still waiting for their acknowledgement get their timers back. */
  async restoreTimers(): Promise<void> {
    const waiting = await this.db
      .select()
      .from(schema.runs)
      .where(
        and(
          isNotNull(schema.runs.ackDeadline),
          isNull(schema.runs.acknowledgedAt),
          inArray(schema.runs.status, ['queued', 'dispatched']),
        ),
      );
    for (const run of waiting) {
      if (run.ackDeadline && run.dispatchMessageId) {
        this.armTimer(run.id, run.dispatchMessageId, run.ackDeadline);
      }
    }
    await this.mcp.restoreTimers();
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.mcp.close();
  }

  /**
   * Undoes a dispatch the machine did not acknowledge in time or refused: a start is cancelled
   * (ticket back to `todo`, not counted), a resume goes back to `paused_quota` (07, section 3).
   */
  private async undoDispatch(
    tx: Executor,
    locked: Locked,
    cause: 'dispatch_timeout' | 'dispatch_refused' | 'machine_offline',
    detail?: string,
  ): Promise<void> {
    if (locked.run.dispatchKind === 'resume') {
      await this.setStatus(tx, locked, 'paused_quota', cause, {
        detail,
        set: { dispatchMessageId: null, ackDeadline: null },
      });
      return;
    }
    if (locked.run.dispatchKind === 'answer') {
      // As when the machine is offline at the answer (owner's decision, lot 2 step K).
      await this.answerUndelivered(tx, locked, cause, detail);
      return;
    }
    const why =
      cause === 'dispatch_timeout'
        ? `machine ${locked.machine.name} did not confirm the start in time`
        : cause === 'machine_offline'
          ? `machine ${locked.machine.name} went offline before the start`
          : `machine ${locked.machine.name} refused the start${detail ? ` (${detail})` : ''}`;
    await this.fail(tx, locked, 'cancelled', cause, {
      detail,
      comment: `The run was cancelled: ${why}. It does not count as a failed attempt.`,
    });
  }

  private async dispatchTimedOut(runId: string, messageId: string): Promise<void> {
    const undone = await this.withRun(runId, async (tx, locked) => {
      const { run } = locked;
      if (run.dispatchMessageId !== messageId || run.acknowledgedAt !== null) return false;
      if (run.status !== 'queued' && run.status !== 'dispatched') return false;
      await this.undoDispatch(tx, locked, 'dispatch_timeout');
      return locked;
    });
    if (!undone) return;
    this.log.warn(
      { run: runId, ticket: this.reference(undone), machine: undone.machine.name },
      'dispatch not acknowledged in time',
    );
    // A late `run.start` or answer reaching the daemon is stopped at once, or at its next `hello`.
    if (undone.run.dispatchKind === 'start' || undone.run.dispatchKind === 'answer') {
      this.send(undone.machine.id, stopMessage(runId, 'not_active'));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Machines

  /**
   * Why the machine cannot take a run now, or null. `busy` is the account's runs using it now.
   */
  private unavailable(
    machine: MachineRow,
    account: AccountRow,
    busy: number,
    required: readonly string[],
    now: Date,
  ): MachineUnavailable | null {
    const state = machineState(machine);
    if (state === 'revoked') return { why: 'revoked' };
    if (state === 'waiting_enrollment') return { why: 'waiting_enrollment' };
    if (state === 'disabled') return { why: 'disabled' };
    if (state === 'offline') return { why: 'offline' };
    if (machine.daemonIncompatibleSince) return { why: 'daemon_incompatible' };
    const reasons = unusableReasons(machine);
    if (reasons.length > 0) return { why: 'unusable', reasons };
    const capabilities = new Set(effectiveCapabilities(capabilityLists(machine)));
    const missing = required.filter((tag) => !capabilities.has(tag));
    if (missing.length > 0) return { why: 'missing_capabilities', capabilities: missing };
    const accountRef = { id: account.id, label: account.label };
    if (isLimited(account, now) && account.limitedUntil) {
      return {
        why: 'account_limited',
        account: accountRef,
        until: account.limitedUntil.toISOString(),
      };
    }
    if (busy >= account.maxConcurrentRuns) {
      return {
        why: 'account_busy',
        account: accountRef,
        maxConcurrentRuns: account.maxConcurrentRuns,
      };
    }
    return null;
  }

  private async busyRuns(tx: Executor, accountId?: string): Promise<Map<string, number>> {
    const rows = await tx
      .select({ accountId: schema.runs.accountId, busy: count() })
      .from(schema.runs)
      .where(
        and(
          inArray(schema.runs.status, [...ACCOUNT_BUSY_RUN_STATUSES]),
          accountId === undefined ? undefined : eq(schema.runs.accountId, accountId),
        ),
      )
      .groupBy(schema.runs.accountId);
    return new Map(rows.map((row) => [row.accountId, row.busy]));
  }

  /** A limit whose time has passed: the account becomes available, with its event (07, section 3). */
  private async releaseAccount(tx: Executor, account: AccountRow): Promise<AccountRow> {
    const now = this.now();
    if (account.state !== 'limited' || isLimited(account, now)) return account;
    const [updated] = await tx
      .update(schema.claudeAccounts)
      .set({ state: 'available', limitedUntil: null, updatedAt: now })
      .where(
        and(eq(schema.claudeAccounts.id, account.id), eq(schema.claudeAccounts.state, 'limited')),
      )
      .returning();
    if (!updated) return account;
    await recordEvent(tx, {
      actor: 'system',
      entityType: 'claude_account',
      entityId: account.id,
      type: 'account.available',
      payload: { label: account.label },
      at: now,
    });
    return updated;
  }

  // ---------------------------------------------------------------------------------------------
  // Run now

  /** The GitHub login and account id, reading the id at the first run when unknown (02, 3.2). */
  private async githubIdentity(): Promise<{ login: string; id: number; token: string }> {
    const [connection] = await this.db.select().from(schema.githubConnection);
    if (!connection) {
      throw refuse({ reason: 'github_not_connected' }, 'GitHub is not connected');
    }
    if (connection.unreadableSince) {
      throw refuse({ reason: 'github_token_unreadable' }, 'The saved GitHub token cannot be read');
    }
    if (connection.invalidSince) {
      throw refuse({ reason: 'github_token_invalid' }, 'GitHub does not accept the saved token');
    }
    let token: string | null;
    try {
      token = await loadToken(this.db, this.options.key);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      throw refuse({ reason: 'github_token_unreadable' }, 'The saved GitHub token cannot be read');
    }
    if (token === null) throw refuse({ reason: 'github_not_connected' }, 'GitHub is not connected');
    if (connection.accountId !== null)
      return { login: connection.account, id: connection.accountId, token };

    const unknown = () =>
      refuse(
        { reason: 'github_account_unknown' },
        'The GitHub account id, needed for the commit author, could not be read',
      );
    const { githubRequestTimeoutSeconds } = await resolveSettings(this.db, [
      'githubRequestTimeoutSeconds',
    ]);
    const client = createGitHubClient({
      apiUrl: this.options.githubApiUrl,
      token,
      timeoutSeconds: githubRequestTimeoutSeconds,
    });
    try {
      const identity = await inspectToken(client, this.now());
      if (!identity.valid) {
        throw refuse({ reason: 'github_token_invalid' }, 'GitHub does not accept the saved token');
      }
      await this.db
        .update(schema.githubConnection)
        .set({ accountId: identity.accountId })
        .where(eq(schema.githubConnection.id, 1));
      return { login: identity.account, id: identity.accountId, token };
    } catch (error) {
      if (error instanceof GitHubUnreachableError) throw unknown();
      throw error;
    }
  }

  /** **Run now** on a ticket (07, section 3): checks, machine, run `queued`, then `dispatched`. */
  async runNow(projectKey: string, ticketNumber: number): Promise<Run> {
    const github = await this.githubIdentity();
    const { templates, commonRules } = await this.files();
    const settings = await resolveSettings(this.db, [
      'maxRunDurationMinutes',
      'idleTimeoutMinutes',
      'maxNudgesPerRun',
      'waitingRunLifetimeMinutes',
      'sessionStartTimeoutSeconds',
      'mcpCallTimeoutSeconds',
      'claudeCodeMcpToolTimeoutSeconds',
      'dispatchAckTimeoutSeconds',
    ]);

    const prepared = await this.db.transaction(async (tx) => {
      const now = this.now();
      const project = await this.lockProject(tx, eq(schema.projects.key, projectKey));
      if (project.status === 'archived') {
        throw refuse({ reason: 'project_archived' }, 'The project is archived');
      }
      if (project.setupStatus !== 'ready' || project.defaultBranch === null) {
        throw refuse({ reason: 'project_not_ready' }, 'The repository setup is not finished');
      }
      const [ticket] = await tx
        .select()
        .from(schema.tickets)
        .where(
          and(eq(schema.tickets.projectId, project.id), eq(schema.tickets.number, ticketNumber)),
        )
        .for('update');
      if (!ticket) throw new HttpError(404, 'ticket_not_found', 'No ticket with this number');
      if (ticket.status !== 'todo') {
        throw refuse(
          { reason: 'ticket_not_todo', status: TicketStatus.parse(ticket.status) },
          `Run now needs a ticket in todo; it is ${ticket.status}`,
        );
      }
      if (ticket.assigneeProfileId === null) {
        throw refuse({ reason: 'no_assignee' }, 'The ticket has no assignee');
      }
      const blockers = await tx
        .select({ number: schema.tickets.number })
        .from(schema.ticketDependencies)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketDependencies.blockedById))
        .where(
          and(eq(schema.ticketDependencies.ticketId, ticket.id), ne(schema.tickets.status, 'done')),
        );
      if (blockers.length > 0) {
        const tickets = blockers.map((row) => ticketReference(project.key, row.number)).sort();
        throw refuse({ reason: 'blocked', tickets }, `The ticket waits for ${tickets.join(', ')}`);
      }
      const [profile] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, ticket.assigneeProfileId));
      if (!profile) throw new Error(`profile ${ticket.assigneeProfileId} not found`);
      const required = z.array(Capability).parse(profile.requiredCapabilities);
      // Kept for the whole run: a later change of the setting applies to later runs (04, 8).
      const { maxAgentTicketsPerRun } = await resolveSettings(
        tx,
        ['maxAgentTicketsPerRun'],
        project.id,
      );

      // The ticket's earlier runs, newest first, and the machine holding its commits (07, 3).
      const earlier = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.ticketId, ticket.id))
        .orderBy(desc(schema.runs.createdAt));
      const withCommits = earlier.find((run) => (reportedCommits(run)?.length ?? 0) > 0);
      const holding =
        withCommits &&
        !earlier.some(
          (run) => run.createdAt > withCommits.createdAt && run.machineId !== withCommits.machineId,
        )
          ? withCommits
          : undefined;

      const machines = await tx.select().from(schema.machines);
      const accounts = new Map(
        (await tx.select().from(schema.claudeAccounts)).map((account) => [account.id, account]),
      );
      const busy = await this.busyRuns(tx);
      const verdict = (machine: MachineRow) => {
        const account = accounts.get(machine.accountId);
        if (!account) throw new Error(`account of machine ${machine.id} not found`);
        return this.unavailable(machine, account, busy.get(account.id) ?? 0, required, now);
      };

      let chosen: MachineRow | undefined;
      let lostWork: { machine: MachineRow; commits: number } | undefined;
      const holder = holding && machines.find((machine) => machine.id === holding.machineId);
      if (holding && holder && !holder.revokedAt) {
        const unavailable = verdict(holder);
        const commits = reportedCommits(holding)?.length ?? 0;
        if (unavailable) {
          throw refuse(
            {
              reason: 'machine_unavailable',
              machine: { id: holder.id, name: holder.name },
              commits,
              unavailable,
            },
            `The ticket's branch is on machine ${holder.name}, which cannot take the run now (${unavailable.why})`,
          );
        }
        chosen = holder;
      } else {
        if (holding && holder) {
          lostWork = { machine: holder, commits: reportedCommits(holding)?.length ?? 0 };
        }
        const candidates = machines.filter((machine) => !machine.revokedAt);
        const available = candidates.filter((machine) => verdict(machine) === null);
        if (available.length === 0) {
          const listed = candidates
            .map((machine) => ({
              machine: { id: machine.id, name: machine.name },
              unavailable: verdict(machine) as MachineUnavailable,
            }))
            .sort((a, b) => a.machine.name.localeCompare(b.machine.name));
          throw refuse({ reason: 'no_machine', machines: listed }, 'No machine can take the run');
        }
        chosen = await this.preferred(tx, project.id, earlier, available);
      }

      // The account is locked, so two starts cannot both take its last place (01, invariant 3).
      const [lockedAccount] = await tx
        .select()
        .from(schema.claudeAccounts)
        .where(eq(schema.claudeAccounts.id, chosen.accountId))
        .for('update');
      if (!lockedAccount) throw new Error('account not found');
      const account = await this.releaseAccount(tx, lockedAccount);
      const [machine] = await tx
        .select()
        .from(schema.machines)
        .where(eq(schema.machines.id, chosen.id))
        .for('share');
      if (!machine) throw new Error('machine not found');
      const recount = (await this.busyRuns(tx, account.id)).get(account.id) ?? 0;
      const unavailable = this.unavailable(machine, account, recount, required, now);
      if (unavailable) {
        throw refuse(
          {
            reason: 'no_machine',
            machines: [{ machine: { id: machine.id, name: machine.name }, unavailable }],
          },
          'No machine can take the run',
        );
      }

      // The first message (03, section 3.2): attempt, and earlier commits on this machine.
      const attempt = earlier.filter((run) => run.acknowledgedAt !== null).length + 1;
      const lastHere = earlier.find((run) => run.machineId === machine.id && run.commits !== null);
      const baseBranch = project.defaultBranch;
      const earlierWorkBase =
        lastHere && (reportedCommits(lastHere)?.length ?? 0) > 0 ? `origin/${baseBranch}` : null;
      let initialPrompt: string;
      try {
        initialPrompt = implementFirstMessage(
          templates.implement,
          await implementTicket(tx, {
            projectKey: project.key,
            projectName: project.name,
            ticket,
            attempt,
            earlierWorkBase,
          }),
        );
      } catch (error) {
        if (!(error instanceof FirstMessageTooLarge)) throw error;
        throw refuse(
          { reason: 'first_message_too_large', maxBytes: FIRST_MESSAGE_MAX_BYTES },
          error.message,
        );
      }

      const branchName = ticket.branchName ?? ticketBranchName(ticket.number, ticket.title);
      if (ticket.branchName === null) {
        await tx.update(schema.tickets).set({ branchName }).where(eq(schema.tickets.id, ticket.id));
      }
      const runToken = newRunToken();
      const dispatchMessageId = randomUUID();
      const ackDeadline = new Date(Date.now() + settings.dispatchAckTimeoutSeconds * this.secondMs);
      const [run] = await tx
        .insert(schema.runs)
        .values({
          projectId: project.id,
          ticketId: ticket.id,
          profileId: profile.id,
          profileVersion: profile.version,
          purpose: 'implement',
          machineId: machine.id,
          accountId: account.id,
          status: 'queued',
          attempt,
          maxAgentTickets: maxAgentTicketsPerRun,
          runTokenHash: hashCredential(runToken),
          dispatchMessageId,
          dispatchKind: 'start',
          ackDeadline,
          branchName,
          baseBranch,
          statusSince: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!run) throw new Error('run not inserted');
      const reference = ticketReference(project.key, ticket.number);
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'run',
        entityId: run.id,
        projectId: project.id,
        type: 'run.created',
        payload: {
          project: project.key,
          ticket: reference,
          purpose: 'implement',
          machine: machine.name,
          account: account.label,
          profile: profile.key,
          profileName: profile.name,
          profileVersion: profile.version,
          attempt,
        },
        at: now,
      });
      const started = await applyRunAction(tx, {
        projectKey: project.key,
        ticket,
        action: 'run_now',
        actor: 'owner',
        runId: run.id,
        now,
      });
      if (!started) throw new Error('ticket left todo during Run now');

      if (lostWork) {
        const body = `The earlier work on machine ${lostWork.machine.name} is no longer available: that machine was revoked, and the ${String(lostWork.commits)} commit${lostWork.commits === 1 ? '' : 's'} of the branch ${branchName} on it are lost. This run starts again from the base branch on machine ${machine.name}.`;
        const [comment] = await tx
          .insert(schema.comments)
          .values({ ticketId: ticket.id, author: 'system', kind: 'note', body, createdAt: now })
          .returning({ id: schema.comments.id });
        if (!comment) throw new Error('comment not inserted');
        await recordEvent(tx, {
          actor: 'system',
          ...ticketEntity(ticket),
          type: 'ticket.commented',
          payload: { project: project.key, ticket: reference, commentId: comment.id, kind: 'note' },
          at: now,
        });
      }

      const start: RunStart = {
        type: 'run.start',
        id: dispatchMessageId,
        payload: {
          runId: run.id,
          purpose: 'implement',
          subject: { kind: 'ticket', id: ticket.id, number: reference },
          repository: {
            owner: project.repoOwner,
            name: project.repoName,
            cloneUrl: `${this.options.gitBaseUrl.replace(/\/+$/, '')}/${project.repoOwner}/${project.repoName}.git`,
            baseBranch,
            ticketBranch: branchName,
          },
          commitAuthor: {
            name: `${profile.name} (Orchestrator)`,
            email: `${String(github.id)}+${github.login}@users.noreply.github.com`,
          },
          profile: {
            key: profile.key,
            version: profile.version,
            instructions: runInstructions(commonRules, profile.instructions),
            model: profile.model,
            allowedTools: z.array(z.string()).parse(profile.allowedTools),
          },
          runToken,
          initialPrompt,
          nudgeMessage: nudgeMessage(templates),
          limits: {
            maxRunDurationMinutes: settings.maxRunDurationMinutes,
            idleTimeoutMinutes: settings.idleTimeoutMinutes,
            maxNudgesPerRun: settings.maxNudgesPerRun,
            waitingRunLifetimeMinutes: settings.waitingRunLifetimeMinutes,
            sessionStartTimeoutSeconds: settings.sessionStartTimeoutSeconds,
            mcpCallTimeoutSeconds: settings.mcpCallTimeoutSeconds,
            claudeCodeMcpToolTimeoutSeconds: settings.claudeCodeMcpToolTimeoutSeconds,
          },
          resumeSessionId: null,
        },
      };
      return { run, start, machine, reference, ackDeadline };
    });

    const { run, start, machine, reference, ackDeadline } = prepared;
    this.armTimer(run.id, start.id, ackDeadline);
    const sent = this.send(machine.id, start);
    await this.withRun(run.id, async (tx, locked) => {
      if (locked.run.status !== 'queued') return;
      if (sent) await this.setStatus(tx, locked, 'dispatched', 'run_now');
      else await this.undoDispatch(tx, locked, 'machine_offline');
    });
    this.log.info(
      { run: run.id, ticket: reference, machine: machine.name, sent },
      sent ? 'run dispatched' : 'run cancelled: machine offline at dispatch',
    );
    return this.view(run.id);
  }

  /**
   * Among machines that can take the run (07, section 4): the one with the repository already
   * cloned, then the one that ran the ticket last, then the fewest runs today.
   */
  private async preferred(
    tx: Executor,
    projectId: string,
    earlier: readonly RunRow[],
    available: readonly MachineRow[],
  ): Promise<MachineRow> {
    const ids = available.map((machine) => machine.id);
    const cloned = new Set(
      (
        await tx
          .select({ machineId: schema.runs.machineId })
          .from(schema.runs)
          .where(and(eq(schema.runs.projectId, projectId), inArray(schema.runs.machineId, ids)))
          .groupBy(schema.runs.machineId)
      ).map((row) => row.machineId),
    );
    const midnight = new Date(this.now());
    midnight.setUTCHours(0, 0, 0, 0);
    const today = new Map(
      (
        await tx
          .select({ machineId: schema.runs.machineId, runs: count() })
          .from(schema.runs)
          .where(and(inArray(schema.runs.machineId, ids), gte(schema.runs.createdAt, midnight)))
          .groupBy(schema.runs.machineId)
      ).map((row) => [row.machineId, row.runs]),
    );
    const last = earlier[0]?.machineId;
    const sorted = [...available].sort(
      (a, b) =>
        Number(cloned.has(b.id)) - Number(cloned.has(a.id)) ||
        Number(b.id === last) - Number(a.id === last) ||
        (today.get(a.id) ?? 0) - (today.get(b.id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    return sorted[0] as MachineRow;
  }

  // ---------------------------------------------------------------------------------------------
  // The owner's answer (04, section 6)

  /** The ticket's latest question and the answer to it, if any. */
  private async lastQuestion(
    tx: Executor,
    ticketId: string,
  ): Promise<{ question: CommentRow; answer: CommentRow | null } | null> {
    const [question] = await tx
      .select()
      .from(schema.comments)
      .where(and(eq(schema.comments.ticketId, ticketId), eq(schema.comments.kind, 'question')))
      .orderBy(desc(schema.comments.createdAt))
      .limit(1);
    if (!question) return null;
    const [answer] = await tx
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.ticketId, ticketId),
          eq(schema.comments.answersCommentId, question.id),
        ),
      )
      .orderBy(desc(schema.comments.createdAt))
      .limit(1);
    return { question, answer: answer ?? null };
  }

  /**
   * The owner's **answer** to the ticket's open question: the ticket moves back to `in_progress`
   * and the waiting run receives it live (`run.input`), or, after the waiting run lifetime,
   * resumes on its machine at once with the answer cut to the byte budget (`run.resume`, 03
   * section 3.2), whatever the account's state (owner's decision, lot 2 step K). With its machine
   * offline, the run fails with `machine_offline` and the ticket returns to `todo`.
   */
  async answer(projectKey: string, ticketNumber: number, body: string): Promise<void> {
    const { templates } = await this.files();
    const { dispatchAckTimeoutSeconds } = await resolveSettings(this.db, [
      'dispatchAckTimeoutSeconds',
    ]);
    const after: (() => Promise<void>)[] = [];
    await this.db.transaction(async (tx) => {
      const now = this.now();
      const project = await this.lockProject(tx, eq(schema.projects.key, projectKey));
      if (project.status === 'archived') {
        throw new HttpError(
          409,
          'project_archived',
          'This project is archived and read-only: unarchive it first',
        );
      }
      const [ticket] = await tx
        .select()
        .from(schema.tickets)
        .where(
          and(eq(schema.tickets.projectId, project.id), eq(schema.tickets.number, ticketNumber)),
        )
        .for('update');
      if (!ticket) {
        throw new HttpError(404, 'ticket_not_found', 'No ticket with this number in this project');
      }
      const asked =
        ticket.status === 'waiting_human' ? await this.lastQuestion(tx, ticket.id) : null;
      if (!asked || asked.answer !== null) {
        throw new HttpError(
          409,
          'no_open_question',
          `The ticket has no question waiting for an answer: it is ${ticket.status}`,
        );
      }
      const [run] = await tx
        .select()
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.ticketId, ticket.id),
            inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
          ),
        )
        .for('update');
      if (!run) throw new Error(`waiting ticket ${ticket.id} has no active run`);
      const [machine] = await tx
        .select()
        .from(schema.machines)
        .where(eq(schema.machines.id, run.machineId));
      if (!machine) throw new Error('machine not found');

      const [answer] = await tx
        .insert(schema.comments)
        .values({
          ticketId: ticket.id,
          author: 'owner',
          kind: 'answer',
          body,
          answersCommentId: asked.question.id,
          createdAt: now,
        })
        .returning();
      if (!answer) throw new Error('comment not inserted');
      const reference = ticketReference(project.key, ticket.number);
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(ticket),
        type: 'ticket.commented',
        payload: { project: project.key, ticket: reference, commentId: answer.id, kind: 'answer' },
        at: now,
      });
      const updated = await applyRunAction(tx, {
        projectKey: project.key,
        ticket,
        action: 'answered',
        actor: 'owner',
        runId: run.id,
        commentId: answer.id,
        now,
      });
      if (!updated) throw new Error('ticket left waiting_human during the answer');
      const locked: Locked = { run, project, ticket: updated, machine };

      if (run.status === 'paused_quota') {
        // Its session is closed on a usage limit: Resume sends the "please continue" message,
        // which points the agent to ticket_comments, where the answer is.
        this.log.info({ run: run.id, ticket: reference }, 'answer kept for a paused run');
        return;
      }
      if (!(this.gateway?.isConnected(machine.id) ?? false)) {
        await this.answerUndelivered(tx, locked, 'machine_offline');
        return;
      }
      if (run.sessionAlive) {
        const inputId = randomUUID();
        await tx
          .update(schema.runs)
          .set({ answerInputId: inputId, updatedAt: now })
          .where(eq(schema.runs.id, run.id));
        const text = answerMessage(templates, asked.question.body, body);
        after.push(async () => {
          const sent = this.send(machine.id, {
            type: 'run.input',
            id: inputId,
            payload: { runId: run.id, text },
          });
          if (!sent) {
            await this.withRun(run.id, async (inner, again) => {
              if (again.run.answerInputId !== inputId || !ACTIVE.has(again.run.status)) return;
              await this.answerUndelivered(inner, again, 'machine_offline');
            });
          }
        });
        return;
      }
      const prepared = await this.prepareAnswerResume(
        tx,
        locked,
        templates,
        asked.question.body,
        body,
        dispatchAckTimeoutSeconds,
      );
      after.push(() => this.deliverResume(prepared));
    });
    for (const action of after) await action();
  }

  /**
   * The answer could not reach the run's machine (offline, no confirmation in time, or a
   * refusal): the run fails with `machine_offline`, not counted, and the ticket returns to `todo`;
   * the answer stays in the comments for the next run (04, section 6; owner's decision, lot 2
   * step K).
   */
  private async answerUndelivered(
    tx: Executor,
    locked: Locked,
    cause: 'machine_offline' | 'dispatch_timeout' | 'dispatch_refused',
    detail?: string,
  ): Promise<void> {
    const name = locked.machine.name;
    const why =
      cause === 'machine_offline'
        ? `machine ${name} is offline`
        : cause === 'dispatch_timeout'
          ? `machine ${name} did not confirm it in time`
          : `machine ${name} refused it${detail ? ` (${detail})` : ''}`;
    await this.fail(tx, locked, 'machine_offline', cause, {
      detail,
      comment: `Your answer could not reach the run: ${why}. The run failed as "machine offline" and does not count as a failed attempt. The branch ${locked.run.branchName} is kept on machine ${name}, and your answer stays here: the next run reads it in its first message.`,
    });
  }

  /** The answer after the waiting run lifetime: `run.resume` on the run's machine (04, 6). */
  private async prepareAnswerResume(
    tx: Executor,
    locked: Locked,
    templates: Templates,
    question: string,
    answer: string,
    ackTimeoutSeconds: number,
  ): Promise<{ runId: string; machineId: string; message: ServerMessage; ackDeadline: Date }> {
    const { run } = locked;
    if (run.claudeSessionId === null) {
      throw new Error(`waiting run ${run.id} has no Claude session to resume`);
    }
    const dispatchMessageId = randomUUID();
    const ackDeadline = new Date(Date.now() + ackTimeoutSeconds * this.secondMs);
    await this.setStatus(tx, locked, 'dispatched', 'answer', {
      set: {
        dispatchMessageId,
        dispatchKind: 'answer',
        ackDeadline,
        acknowledgedAt: null,
        answerInputId: null,
      },
    });
    return {
      runId: run.id,
      machineId: locked.machine.id,
      ackDeadline,
      message: {
        type: 'run.resume',
        id: dispatchMessageId,
        payload: {
          runId: run.id,
          claudeSessionId: run.claudeSessionId,
          message: answerResumeMessage(templates, question, answer),
        },
      },
    };
  }

  private async deliverResume(prepared: {
    runId: string;
    machineId: string;
    message: ServerMessage;
    ackDeadline: Date;
  }): Promise<void> {
    this.armTimer(prepared.runId, prepared.message.id, prepared.ackDeadline);
    if (this.send(prepared.machineId, prepared.message)) return;
    await this.withRun(prepared.runId, async (tx, locked) => {
      if (locked.run.status === 'dispatched' && locked.run.acknowledgedAt === null) {
        await this.undoDispatch(tx, locked, 'machine_offline');
      }
    });
  }

  /**
   * The daemon's answer to the `run.input` carrying the owner's answer. A refusal means the
   * session closed meanwhile (the waiting run lifetime): the answer then resumes it (05, 4.4).
   */
  private async answerInputAcknowledged(runId: string, ack: Ack): Promise<void> {
    const { templates } = await this.files();
    const { dispatchAckTimeoutSeconds } = await resolveSettings(this.db, [
      'dispatchAckTimeoutSeconds',
    ]);
    const prepared = await this.withRun(runId, async (tx, locked) => {
      if (locked.run.answerInputId !== ack.id) return null;
      await tx
        .update(schema.runs)
        .set({ answerInputId: null, updatedAt: this.now() })
        .where(eq(schema.runs.id, runId));
      locked.run.answerInputId = null;
      if (ack.payload.ok || !ACTIVE.has(locked.run.status) || !locked.ticket) return null;
      const asked = await this.lastQuestion(tx, locked.ticket.id);
      if (!asked?.answer) return null;
      this.log.info({ run: runId, reason: ack.payload.message }, 'answer refused live: resuming');
      return this.prepareAnswerResume(
        tx,
        locked,
        templates,
        asked.question.body,
        asked.answer.body,
        dispatchAckTimeoutSeconds,
      );
    });
    if (prepared) await this.deliverResume(prepared);
  }

  // ---------------------------------------------------------------------------------------------
  // Resume and Stop run

  /** **Resume** of a paused run, on its own machine only (07, section 3). */
  async resume(runId: string): Promise<Run> {
    const { templates } = await this.files();
    const { dispatchAckTimeoutSeconds } = await resolveSettings(this.db, [
      'dispatchAckTimeoutSeconds',
    ]);
    const prepared = await this.withRun(runId, async (tx, locked) => {
      const { run, machine } = locked;
      if (run.status !== 'paused_quota') {
        throw refuse(
          { reason: 'run_not_paused', status: RunStatus.parse(run.status) },
          `Only a paused run can be resumed; this one is ${run.status}`,
        );
      }
      const [lockedAccount] = await tx
        .select()
        .from(schema.claudeAccounts)
        .where(eq(schema.claudeAccounts.id, run.accountId))
        .for('update');
      if (!lockedAccount) throw new Error('account not found');
      const account = await this.releaseAccount(tx, lockedAccount);
      const now = this.now();
      const accountRef = { id: account.id, label: account.label };
      if (isLimited(account, now) && account.limitedUntil) {
        throw refuse(
          {
            reason: 'account_limited',
            account: accountRef,
            until: account.limitedUntil.toISOString(),
          },
          `The account ${account.label} is limited until ${account.limitedUntil.toISOString()}`,
        );
      }
      const busy = (await this.busyRuns(tx, account.id)).get(account.id) ?? 0;
      if (busy >= account.maxConcurrentRuns) {
        throw refuse(
          {
            reason: 'account_busy',
            account: accountRef,
            maxConcurrentRuns: account.maxConcurrentRuns,
          },
          `The account ${account.label} already runs its maximum of ${String(account.maxConcurrentRuns)}`,
        );
      }
      // Its own machine: capabilities and the account were checked when it started.
      const unavailable = this.unavailable(machine, account, 0, [], now);
      if (unavailable) {
        throw refuse(
          {
            reason: 'machine_unavailable',
            machine: { id: machine.id, name: machine.name },
            commits: null,
            unavailable,
          },
          `The run's machine ${machine.name} cannot take it now (${unavailable.why})`,
        );
      }
      if (run.claudeSessionId === null) {
        throw new Error(`paused run ${run.id} has no Claude session to resume`);
      }
      const dispatchMessageId = randomUUID();
      const ackDeadline = new Date(Date.now() + dispatchAckTimeoutSeconds * this.secondMs);
      await this.setStatus(tx, locked, 'dispatched', 'resume', {
        set: {
          dispatchMessageId,
          dispatchKind: 'resume',
          ackDeadline,
          acknowledgedAt: null,
        },
      });
      return {
        machine,
        ackDeadline,
        message: {
          type: 'run.resume',
          id: dispatchMessageId,
          payload: {
            runId: run.id,
            claudeSessionId: run.claudeSessionId,
            message: continueMessage(templates),
          },
        } satisfies ServerMessage,
      };
    });
    if (!prepared) throw runNotFound();
    this.armTimer(runId, prepared.message.id, prepared.ackDeadline);
    if (!this.send(prepared.machine.id, prepared.message)) {
      await this.withRun(runId, async (tx, locked) => {
        if (locked.run.status === 'dispatched' && locked.run.acknowledgedAt === null) {
          await this.undoDispatch(tx, locked, 'machine_offline');
        }
      });
    }
    this.log.info({ run: runId, machine: prepared.machine.name }, 'run resumed');
    return this.view(runId);
  }

  /**
   * The owner's **Stop run** (04, section 2): cancelled at once with the ticket back to `todo`,
   * its comment and the run token revoked, then `run.stop`. With its machine offline, the run fails
   * with `machine_offline` (05, section 6). Neither counts as an attempt.
   */
  async stop(runId: string): Promise<Run> {
    const stopped = await this.withRun(runId, async (tx, locked) => {
      if (!ACTIVE.has(locked.run.status)) {
        throw new HttpError(409, 'run_not_active', `The run already ended: ${locked.run.status}`);
      }
      const online = this.gateway?.isConnected(locked.machine.id) ?? false;
      const kept = `The branch ${locked.run.branchName} is kept on machine ${locked.machine.name}.`;
      await this.setStatus(tx, locked, online ? 'cancelled' : 'failed', 'owner_stopped', {
        failureReason: online ? 'cancelled' : 'machine_offline',
      });
      if (locked.ticket) {
        await applyRunAction(tx, {
          projectKey: locked.project.key,
          ticket: locked.ticket,
          action: 'stop_run',
          actor: 'owner',
          runId: locked.run.id,
          failureReason: online ? 'cancelled' : 'machine_offline',
          attemptCounted: false,
          comment: online
            ? `Run stopped by the owner. ${kept} It does not count as a failed attempt.`
            : `Run stopped by the owner while machine ${locked.machine.name} was offline: it failed as "machine offline" and does not count as a failed attempt. ${kept}`,
          now: this.now(),
        });
      }
      return { locked, online };
    });
    if (!stopped) throw runNotFound();
    if (stopped.online) this.send(stopped.locked.machine.id, stopMessage(runId, 'owner_stopped'));
    this.log.info(
      { run: runId, ticket: this.reference(stopped.locked), machine: stopped.locked.machine.name },
      'run stopped by the owner',
    );
    return this.view(runId);
  }

  /**
   * **Cancel** or **Mark as done manually** on a ticket with an active run, in the owner action's
   * transaction (the project is locked): the run is cancelled and its token revoked. Returns what
   * to do once the transaction committed: send `run.stop`.
   */
  async endForTicket(
    tx: Executor,
    project: ProjectRow,
    ticket: TicketRow,
    cause: 'ticket_cancelled' | 'ticket_done',
  ): Promise<() => void> {
    const [run] = await tx
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.ticketId, ticket.id),
          inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .for('update');
    if (!run) return () => undefined;
    const [machine] = await tx
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, run.machineId));
    if (!machine) throw new Error('machine not found');
    const locked: Locked = { run, project, ticket, machine };
    await this.setStatus(tx, locked, 'cancelled', cause, { failureReason: 'cancelled' });
    return () => {
      this.send(
        machine.id,
        stopMessage(run.id, cause === 'ticket_cancelled' ? 'ticket_cancelled' : 'owner_stopped'),
      );
    };
  }

  /** After **Revoke**: the machine's active runs fail with `machine_revoked`, not counted. */
  async failMachineRuns(machineId: string): Promise<void> {
    const active = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.machineId, machineId),
          inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    for (const { id } of active) {
      await this.withRun(id, async (tx, locked) => {
        if (!ACTIVE.has(locked.run.status)) return;
        await this.fail(tx, locked, 'machine_revoked', 'machine_revoked');
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Views

  async view(runId: string): Promise<Run> {
    const [row] = await this.db
      .select({
        run: schema.runs,
        projectKey: schema.projects.key,
        ticketNumber: schema.tickets.number,
        profile: { key: schema.agentProfiles.key, name: schema.agentProfiles.name },
        machine: {
          id: schema.machines.id,
          name: schema.machines.name,
          status: schema.machines.status,
        },
        account: { id: schema.claudeAccounts.id, label: schema.claudeAccounts.label },
      })
      .from(schema.runs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
      .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.runs.profileId))
      .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
      .innerJoin(schema.claudeAccounts, eq(schema.claudeAccounts.id, schema.runs.accountId))
      .where(eq(schema.runs.id, runId));
    if (!row) throw runNotFound();
    return toRun(row.run, {
      projectKey: row.projectKey,
      ticketNumber: row.ticketNumber,
      profile: row.profile,
      machine: {
        id: row.machine.id,
        name: row.machine.name,
        online: row.machine.status === 'online',
      },
      account: row.account,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The daemon's messages (05, section 3.3)

  /** The daemon acknowledged a command: a `run.start` or `run.resume` is then dispatched. */
  async acknowledged(machineId: string, ack: Ack): Promise<void> {
    const [answered] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.answerInputId, ack.id), eq(schema.runs.machineId, machineId)));
    if (answered) {
      await this.answerInputAcknowledged(answered.id, ack);
      return;
    }
    const [run] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.dispatchMessageId, ack.id), eq(schema.runs.machineId, machineId)));
    if (!run) return; // An acknowledgement of `run.stop` or `run.input`: nothing to record.
    const result = await this.withRun(run.id, async (tx, locked) => {
      if (locked.run.dispatchMessageId !== ack.id || locked.run.acknowledgedAt !== null)
        return 'ignored';
      if (!ack.payload.ok) {
        if (locked.run.status === 'queued' || locked.run.status === 'dispatched') {
          await this.undoDispatch(tx, locked, 'dispatch_refused', ack.payload.message);
        }
        return 'refused';
      }
      await tx
        .update(schema.runs)
        .set({ acknowledgedAt: this.now(), ackDeadline: null, updatedAt: this.now() })
        .where(eq(schema.runs.id, locked.run.id));
      this.clearTimer(locked.run.id);
      if (locked.run.status === 'queued') await this.setStatus(tx, locked, 'dispatched', 'daemon');
      return ACTIVE.has(locked.run.status) ? 'acknowledged' : 'late';
    });
    if (result === 'late') this.send(machineId, stopMessage(run.id, 'not_active'));
  }

  /** Records a report's id; false when it was handled already (a duplicate, 05 section 3.3). */
  private async firstTime(tx: Executor, machineId: string, id: string, type: string) {
    const inserted = await tx
      .insert(schema.daemonMessages)
      .values({ id, machineId, type })
      .onConflictDoNothing()
      .returning({ id: schema.daemonMessages.id });
    return inserted.length > 0;
  }

  /** `run.state` (05, section 4.7): the run's status, the Claude Code check, the end. */
  async runState(machineId: string, message: RunState): Promise<Ack['payload']> {
    const { payload } = message;
    const after: (() => void)[] = [];
    const handled = await this.withRun(payload.runId, async (tx, locked) => {
      if (locked.run.machineId !== machineId) return false;
      if (!(await this.firstTime(tx, machineId, message.id, message.type))) return true;
      const { run } = locked;
      const session = {
        sessionAlive: payload.sessionAlive,
        ...(payload.claudeSessionId === null ? {} : { claudeSessionId: payload.claudeSessionId }),
        ...(run.acknowledgedAt === null ? { acknowledgedAt: this.now(), ackDeadline: null } : {}),
        updatedAt: this.now(),
      };

      if (payload.state === 'ended') {
        const branch = payload.branch
          ? { branchHead: payload.branch.head, commits: payload.branch.commitsAhead }
          : {};
        if (!ACTIVE.has(run.status)) {
          // Already ended on the server (Stop run, revocation): the report adds the branch only.
          await tx
            .update(schema.runs)
            .set({ ...branch, sessionAlive: false, updatedAt: this.now() })
            .where(eq(schema.runs.id, run.id));
          return true;
        }
        await tx
          .update(schema.runs)
          .set({ ...session, ...branch })
          .where(eq(schema.runs.id, run.id));
        const end = endOfReason(payload.reason);
        const detail = payload.detail ?? undefined;
        if (end.status === 'succeeded') {
          await this.setStatus(tx, locked, 'succeeded', 'daemon', {
            endReason: payload.reason,
            detail,
          });
          if (locked.ticket) {
            await applyRunAction(tx, {
              projectKey: locked.project.key,
              ticket: locked.ticket,
              action: 'run_submitted',
              actor: 'system',
              runId: run.id,
              now: this.now(),
            });
          }
        } else {
          if (end.failureReason === 'claude_code_unsupported') {
            await this.claudeCodeUnsupported(
              tx,
              locked.machine,
              run.id,
              locked.machine.claudeCodeVersion,
            );
          }
          await this.fail(tx, locked, end.failureReason, 'daemon', {
            endReason: payload.reason,
            detail,
          });
        }
        return true;
      }

      if (!ACTIVE.has(run.status)) {
        // The server ended it: the daemon stops the session (05, section 6).
        after.push(() => this.send(machineId, stopMessage(run.id, 'not_active')));
        return true;
      }
      await tx.update(schema.runs).set(session).where(eq(schema.runs.id, run.id));
      this.clearTimer(run.id);

      if (payload.state === 'starting') {
        // The version of the `claude` launched is checked again as at `hello` (05, section 4.3).
        const support = claudeCodeSupport(payload.claudeCodeVersion);
        if (support === 'missing' || support === 'below_minimum') {
          await this.claudeCodeUnsupported(tx, locked.machine, run.id, payload.claudeCodeVersion);
          await this.fail(tx, locked, 'claude_code_unsupported', 'claude_code_unsupported', {
            detail: `Claude Code ${payload.claudeCodeVersion ?? 'missing'}, minimum ${CLAUDE_CODE_MIN_VERSION}`,
          });
          after.push(() => this.send(machineId, stopMessage(run.id, 'not_active')));
          return true;
        }
        if (
          locked.machine.claudeCodeVersion !== payload.claudeCodeVersion ||
          locked.machine.claudeCodeUnsupportedSince !== null
        ) {
          await tx
            .update(schema.machines)
            .set({ claudeCodeVersion: payload.claudeCodeVersion, claudeCodeUnsupportedSince: null })
            .where(eq(schema.machines.id, machineId));
        }
      }
      const to = statusOfDaemonState(payload.state);
      if (to !== run.status) {
        await this.setStatus(tx, locked, to, 'daemon', {
          set: {
            ...(to === 'starting' && run.startedAt === null ? { startedAt: this.now() } : {}),
            ...(to === 'running' ? { pauseReason: null } : {}),
          },
        });
      }
      return true;
    });
    for (const action of after) action();
    if (!handled) return { ok: false, message: 'unknown run' };
    return { ok: true };
  }

  /** The machine's Claude Code is missing or too old at a run's start: it becomes unusable. */
  private async claudeCodeUnsupported(
    tx: Executor,
    machine: MachineRow,
    runId: string,
    version: string | null,
  ): Promise<void> {
    await tx
      .update(schema.machines)
      .set({
        claudeCodeVersion: version,
        claudeCodeUnsupportedSince: machine.claudeCodeUnsupportedSince ?? this.now(),
        updatedAt: this.now(),
      })
      .where(eq(schema.machines.id, machine.id));
    await recordEvent(tx, {
      actor: 'system',
      entityType: 'machine',
      entityId: machine.id,
      type: 'machine.claude_code_unsupported',
      payload: { name: machine.name, version, minimum: CLAUDE_CODE_MIN_VERSION },
    });
    this.log.warn(
      { machine: machine.name, run: runId, version },
      'Claude Code unsupported at run start',
    );
  }

  /**
   * `run.quota_limited` (05, section 4.10; 07, section 5.2): the run is paused; a detected limit
   * makes the account `limited` until the reset time, or now plus the fallback delay.
   */
  async quotaLimited(machineId: string, message: RunQuotaLimited): Promise<Ack['payload']> {
    const { payload } = message;
    const { quotaFallbackDelayMinutes } = await resolveSettings(this.db, [
      'quotaFallbackDelayMinutes',
    ]);
    const handled = await this.withRun(payload.runId, async (tx, locked) => {
      if (locked.run.machineId !== machineId) return false;
      if (!(await this.firstTime(tx, machineId, message.id, message.type))) return true;
      if (!ACTIVE.has(locked.run.status)) return true;
      const pauseReason: PauseReason =
        payload.kind === 'detected' ? 'usage_limit' : 'suspected_usage_limit';
      await this.setStatus(tx, locked, 'paused_quota', 'daemon', {
        pauseReason,
        detail: payload.evidence.message ?? undefined,
        set: { pauseReason, sessionAlive: false },
      });
      if (payload.kind !== 'detected') return true;

      const now = this.now();
      const reset = payload.resetsAt === null ? null : new Date(payload.resetsAt);
      const known = reset !== null && reset.getTime() > now.getTime();
      const until = known ? reset : new Date(now.getTime() + quotaFallbackDelayMinutes * 60_000);
      const [account] = await tx
        .select()
        .from(schema.claudeAccounts)
        .where(eq(schema.claudeAccounts.id, locked.run.accountId))
        .for('update');
      if (!account) throw new Error('account not found');
      // Two limits reported close together keep the later reset.
      if (isLimited(account, now) && account.limitedUntil && account.limitedUntil >= until)
        return true;
      await tx
        .update(schema.claudeAccounts)
        .set({ state: 'limited', limitedUntil: until, updatedAt: now })
        .where(eq(schema.claudeAccounts.id, account.id));
      await recordEvent(tx, {
        actor: 'system',
        entityType: 'claude_account',
        entityId: account.id,
        type: 'account.limited',
        payload: {
          label: account.label,
          until: until.toISOString(),
          source: known ? 'reset_time' : 'fallback',
          ...(known ? {} : { fallbackMinutes: quotaFallbackDelayMinutes }),
        },
        at: now,
      });
      return true;
    });
    if (!handled) return { ok: false, message: 'unknown run' };
    this.log.info({ run: payload.runId, kind: payload.kind }, 'run paused on a usage limit');
    return { ok: true };
  }

  /**
   * `run.events`: log entries stored once per position, masked and cut to "Longest stored log
   * entry" (02, section 7), and the latest usage estimate.
   */
  async runEvents(machineId: string, message: RunEvents): Promise<Ack['payload']> {
    const { payload } = message;
    const [run] = await this.db
      .select({ id: schema.runs.id, machineId: schema.runs.machineId })
      .from(schema.runs)
      .where(eq(schema.runs.id, payload.runId));
    if (!run || run.machineId !== machineId) return { ok: false, message: 'unknown run' };
    const { logEntryMaxLength } = await resolveSettings(this.db, ['logEntryMaxLength']);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.runLogEntries)
        .values(
          payload.events.map((event) => {
            const masked = maskSecrets(event.text);
            const cut = masked.length > logEntryMaxLength;
            return {
              runId: run.id,
              seq: event.seq,
              at: new Date(event.at),
              kind: event.kind,
              tool: event.tool === null ? null : maskSecrets(event.tool),
              text: cut
                ? `${masked.slice(0, logEntryMaxLength)}\n[… ${String(masked.length - logEntryMaxLength)} more characters not kept]`
                : masked,
              cut,
            };
          }),
        )
        .onConflictDoNothing();
      await notifyRunLog(tx, run.id, Math.max(...payload.events.map((event) => event.seq)));
      if (payload.estimatedUsageUsd !== null) {
        await tx
          .update(schema.runs)
          .set({ estimatedUsageUsd: payload.estimatedUsageUsd })
          .where(eq(schema.runs.id, run.id));
      }
    });
    return { ok: true };
  }

  /** `mcp.call`: the MCP backend answers (06; lot 2 step K). */
  mcpCall(machineId: string, message: McpCall): Promise<McpResult['payload']> {
    return this.mcp.call(machineId, message);
  }

  /**
   * `git.credential_request` (05, section 7): the token only for a fetch of the run's own
   * repository while the run is active on this machine.
   */
  async credential(
    machineId: string,
    message: GitCredentialRequest,
  ): Promise<GitCredential['payload']> {
    const { runId, repository } = message.payload;
    const [row] = z.uuid().safeParse(runId).success
      ? await this.db
          .select({
            run: schema.runs,
            owner: schema.projects.repoOwner,
            name: schema.projects.repoName,
          })
          .from(schema.runs)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
          .where(eq(schema.runs.id, runId))
      : [];
    const refused = (why: string): GitCredential['payload'] => {
      this.log.warn(
        { machine: machineId, run: runId, repository: `${repository.owner}/${repository.name}` },
        `git credential refused: ${why}`,
      );
      return { ok: false, message: why };
    };
    if (!row || row.run.machineId !== machineId) return refused('unknown run');
    if (!FETCHING.has(row.run.status)) return refused(`the run is ${row.run.status}`);
    if (
      row.owner.toLowerCase() !== repository.owner.toLowerCase() ||
      row.name.toLowerCase() !== repository.name.toLowerCase()
    ) {
      return refused("not the run's repository");
    }
    let token: string | null;
    try {
      token = await loadToken(this.db, this.options.key);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return refused('the saved GitHub token cannot be read');
    }
    if (token === null) return refused('GitHub is not connected');
    this.log.info({ machine: machineId, run: runId }, 'git credential sent for a fetch');
    return { ok: true, username: 'x-access-token', password: token };
  }

  /**
   * At `hello` (05, section 6, lot 2 part): a run the daemon still has but the server no longer
   * considers active is stopped, which also ends a session whose end was never reported.
   */
  async reconcile(machineId: string, runs: Hello['payload']['runs']): Promise<void> {
    for (const reported of runs) {
      const [run] = await this.db
        .select({ status: schema.runs.status, machineId: schema.runs.machineId })
        .from(schema.runs)
        .where(eq(schema.runs.id, reported.runId));
      if (run && run.machineId === machineId && ACTIVE.has(run.status)) continue;
      this.log.info({ machine: machineId, run: reported.runId }, 'run no longer active: stopped');
      this.send(machineId, stopMessage(reported.runId, 'not_active'));
    }
  }
}

function stopMessage(
  runId: string,
  reason: 'owner_stopped' | 'ticket_cancelled' | 'not_active',
): ServerMessage {
  return { type: 'run.stop', id: randomUUID(), payload: { runId, reason } };
}

export const runNotFound = () => new HttpError(404, 'run_not_found', 'No run with this id');
