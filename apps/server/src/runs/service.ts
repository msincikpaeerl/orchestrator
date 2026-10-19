import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  ACCOUNT_BUSY_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  CLAUDE_CODE_MIN_VERSION,
  Capability,
  FIRST_MESSAGE_MAX_BYTES,
  PUSH_PERMISSION_WORDS,
  PullRequestState,
  CiCheckFailure,
  CiResult,
  CiRound,
  CiRoundRefusal,
  PushResult,
  ReviewDecision,
  type ReviewMoved,
  type TicketStop,
  SESSION_ALIVE_REFUSAL,
  SESSION_CLOSED_REFUSAL,
  TEXT_CEILING,
  cutText,
  RunStatus,
  SubmissionRecord,
  TicketStatus,
  claudeCodeSupport,
  maskSecrets,
  shorten,
  type Ack,
  type BranchReport,
  type EventPayload,
  FailureReason,
  type GitCredential,
  type GitCredentialRequest,
  type Hello,
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
  McpPermission,
  runMcpTools,
  type RunPurpose,
  type SettingValues,
} from '@orchestrator/protocol';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  type SQL,
} from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  loadShippedAgents,
  loadTemplates,
  type Rules,
  type Template,
  type Templates,
} from '../agents/files.js';
import {
  FirstMessageTooLarge,
  answerMessage,
  answerResumeMessage,
  continueMessage,
  fixReviewFirstMessage,
  implementFirstMessage,
  nudgeMessage,
  runInstructions,
  runRules,
} from '../agents/messages.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { notifyChange, notifyRunLog } from '../realtime/changes.js';
import { createGitHubClient, GitHubUnreachableError } from '../github/client.js';
import { loadToken } from '../github/connection.js';
import { inspectToken } from '../github/token-check.js';
import { HttpError } from '../http.js';
import { hashCredential } from '../machines/credentials.js';
import { McpBackend } from '../mcp/backend.js';
import { type MachineRow } from '../machines/model.js';
import type { ProjectRow } from '../projects/model.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { resolveSettings } from '../settings/store.js';
import {
  ticketEntity,
  ticketReference,
  type CommentRow,
  type TicketRow,
} from '../tickets/model.js';
import {
  commitsNotOnGitHub,
  pushFailure,
  pushPermission,
  pushedCommits,
  recordPush,
} from '../tickets/branch.js';
import { applyRunAction } from '../tickets/transitions.js';
import { fixReviewTicket, implementTicket, reviewTicket } from './first-message.js';
import { standingRequest } from '../tickets/changes.js';
import { ciOutcome, ciSourceRun } from './ci-outcome.js';
import { reviewCiOf } from './review-view.js';
import { reviewFirstMessage, type ReviewCi } from '../agents/review-message.js';
import { storedTokenClient } from '../github/connection.js';
import { readPullRequest } from '../github/pull-requests.js';
import { CiStatusReader } from './ci-status.js';
import { failedChecks } from './ci-result.js';
import { ciFailedMessage } from './ci-failed.js';
import type { CiDecision } from './ci-wait.js';
import {
  ciDeadlines,
  endOfReason,
  failureWords,
  isCounted,
  isLimited,
  reportedCommits,
  resumeAfter,
  statusOfDaemonState,
  statusTimes,
  ticketBranchName,
  toRun,
  type AccountRow,
  type RunRow,
} from './model.js';
import { downloadWords, runDownload } from './download.js';
import {
  githubRefusal,
  machineChoice,
  machineUnavailable,
  preferredMachine,
  projectRefusal,
  refusalMessage,
  resumeRefusal,
  ticketRefusal,
  ticketWork,
  type Fleet,
} from '../scheduler/checks.js';
import { runsToday } from '../scheduler/facts.js';

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
  /** After an accepted submission: open or update its pull request (lot 3 step F3). */
  pullRequestWanted?: (ticketId: string) => void;
  /** After Quality's decision is applied: post its comment review (lot 3 step H3). */
  reviewPostWanted?: (runId: string) => void;
  /** After a run of a ticket reported its end: its machine's clean-up may go (lot 3 step J2b). */
  endReported?: (ticketId: string) => void;
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

/**
 * Runs that may push their ticket branch (05, sections 4.9 and 7): running, at `ticket_submit` or
 * at an end the daemon decided, and "ending" runs (`isEnding`). A review run never pushes.
 */
const PUSHING = new Set<string>(['running']);

/** The settings a run's start resolves (04, section 8; 05, section 5). */
const RUN_START_SETTINGS = [
  'maxRunDurationMinutes',
  'idleTimeoutMinutes',
  'maxNudgesPerRun',
  'waitingRunLifetimeMinutes',
  'sessionStartTimeoutSeconds',
  'mcpCallTimeoutSeconds',
  'claudeCodeMcpToolTimeoutSeconds',
  'pushTimeoutSeconds',
  'dispatchAckTimeoutSeconds',
] as const;

/** A refusal of the checks shared with the scheduler's queue, with its message (lot 4 step D1). */
const refused = (refusal: RunRefusal) => refuse(refusal, refusalMessage(refusal));

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
  private agentFiles:
    Promise<{ templates: Templates; rules: Rules; allowlist: Template }> | undefined;
  private readonly mcp: McpBackend;
  private readonly ciStatus: CiStatusReader;

  constructor(private readonly options: RunServiceOptions) {
    this.db = options.db;
    this.log = options.log;
    this.secondMs = options.secondMs ?? 1000;
    const ciStatus = new CiStatusReader({
      db: options.db,
      key: options.key,
      apiUrl: options.githubApiUrl,
      log: options.log,
      now: () => this.now(),
      templates: async () => (await this.files()).templates,
    });
    this.ciStatus = ciStatus;
    this.mcp = new McpBackend({
      db: options.db,
      log: options.log,
      now: () => this.now(),
      secondMs: this.secondMs,
      templates: async () => (await this.files()).templates,
      pullRequestWanted: (ticketId) => options.pullRequestWanted?.(ticketId),
      ciStatus: (call) => ciStatus.answer(call),
      pullRequestHead: async (project, number) => {
        const read = await this.readPullRequest(project, number);
        return read.read ? { read: true, head: read.head } : { read: false, why: read.why };
      },
      reviewHeadMoved: (runId, head) => this.reviewHeadMoved(runId, head),
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

  /**
   * Sends `run.stop`, recording when: the run is "ending" until its end is reported, so its end
   * push still gets a credential (05, section 7; lot 3 step D2).
   */
  private async sendStop(
    machineId: string,
    runId: string,
    reason: 'owner_stopped' | 'ticket_cancelled' | 'not_active' | 'completed',
  ): Promise<void> {
    await this.db
      .update(schema.runs)
      .set({ stopSentAt: this.now() })
      .where(eq(schema.runs.id, runId));
    this.send(machineId, stopMessage(runId, reason));
  }

  private files() {
    this.agentFiles ??= Promise.all([loadTemplates(), loadShippedAgents()]).then(
      ([templates, shipped]) => ({
        templates,
        rules: shipped.rules,
        allowlist: shipped.allowlist,
      }),
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
    const decision = pendingDecision(updated);
    if (terminal && to !== 'succeeded' && from !== to && decision !== null) {
      await this.reviewDiscarded(tx, locked, decision);
    }
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
    facts: {
      endReason?: RunEndReason;
      detail?: string;
      comment?: string;
      /** Every commit the run reported was on GitHub: the comment says so (lot 3 step D3). */
      onGitHub?: boolean;
      /** A review run's end, in words, when the failure reason does not say it all (lot 3 H2). */
      reviewWhy?: string;
      /** Where a review run found the head moved, and GitHub's head then (lot 3 step H4). */
      reviewMoved?: { where: ReviewMoved; head: string | null };
    } = {},
  ): Promise<void> {
    const status = failureReason === 'cancelled' ? 'cancelled' : 'failed';
    if (facts.reviewMoved) {
      const moved = {
        reviewMoved: facts.reviewMoved.where,
        reviewMovedHead: facts.reviewMoved.head,
      };
      await tx.update(schema.runs).set(moved).where(eq(schema.runs.id, locked.run.id));
      locked.run = { ...locked.run, ...moved };
    }
    await this.setStatus(tx, locked, status, cause, {
      failureReason,
      endReason: facts.endReason,
      detail: facts.detail,
    });
    if (!locked.ticket) return;
    if (locked.run.purpose === 'review') {
      // Never counted, and the ticket stays in review (owner's answer 6c, lot 3 step H2).
      const why =
        facts.reviewWhy ??
        this.reviewWhy(
          locked.run,
          failureReason,
          facts.detail,
          `${locked.project.repoOwner}/${locked.project.repoName}`,
        );
      await this.reviewTicketBack(
        tx,
        locked,
        facts.comment ?? reviewEndComment(locked, why),
        'system',
        failureReason,
      );
      return;
    }
    const counted = isCounted(failureReason);
    const words = failureWords(failureReason);
    const detail = facts.detail ? ` (${facts.detail})` : '';
    const comment =
      facts.comment ??
      (failureReason === 'push_failed'
        ? await this.pushFailedComment(tx, locked.ticket.id, locked.run.id, locked.machine.name)
        : failureReason === 'download_failed'
          ? this.downloadFailedComment(locked)
          : counted
            ? `Attempt ${String(locked.run.attempt)} failed on machine ${locked.machine.name}: ${words}${detail}. ${COUNTED_SENTENCE} ${facts.onGitHub ? `Every commit of the branch ${locked.run.branchName} was on GitHub when the run ended.` : `The branch ${locked.run.branchName} is kept on that machine.`}`
            : `The run on machine ${locked.machine.name} ended: ${words}${detail}. It does not count as a failed attempt.`);
    // The stop at **Failed attempts before asking you**, read now (04, section 5; lot 3 step K1).
    const stop = counted ? await this.failedAttemptsStop(tx, locked) : null;
    const updated = await applyRunAction(tx, {
      projectKey: locked.project.key,
      ticket: locked.ticket,
      action: 'run_ended',
      actor: 'system',
      runId: locked.run.id,
      failureReason,
      attemptCounted: counted,
      comment:
        stop === null
          ? comment
          : comment.replace(
              COUNTED_SENTENCE,
              `It counts as a failed attempt: ${String(stop.count)} failed attempt${stop.count === 1 ? '' : 's'}, ${stop.count > stop.limit ? 'more than' : 'as many as'} Failed attempts before asking you allows (${String(stop.limit)}), so the ticket is stopped. Use Try again to let it continue, or Cancel it, or Mark it as done manually.`,
            ),
      now: this.now(),
    });
    if (updated !== null && stop !== null) await this.stopTicket(tx, locked, stop);
  }

  /**
   * The stop a counted failure brings, before it is applied: when the ticket's failed attempts
   * reach **Failed attempts before asking you** with it; null otherwise, or when the ticket is
   * already stopped.
   */
  private async failedAttemptsStop(tx: Executor, locked: Locked): Promise<TicketStop | null> {
    const { ticket } = locked;
    if (!ticket || ticket.stopped !== null) return null;
    const { maxFailedAttempts } = await resolveSettings(
      tx,
      ['maxFailedAttempts'],
      locked.project.id,
    );
    const count = ticket.attemptCount + 1;
    if (count < maxFailedAttempts) return null;
    return {
      cause: 'failed_attempts',
      count,
      limit: maxFailedAttempts,
      at: this.now().toISOString(),
    };
  }

  /** Marks the ticket stopped, with its `ticket.stopped` event (04, section 5; lot 3 step I). */
  private async stopTicket(tx: Executor, locked: Locked, stop: TicketStop): Promise<void> {
    const { ticket } = locked;
    if (!ticket) return;
    await tx.update(schema.tickets).set({ stopped: stop }).where(eq(schema.tickets.id, ticket.id));
    await recordEvent(tx, {
      actor: 'system',
      ...ticketEntity(ticket),
      type: 'ticket.stopped',
      payload: {
        project: locked.project.key,
        ticket: this.reference(locked),
        cause: stop.cause,
        count: stop.count,
        limit: stop.limit,
        runId: locked.run.id,
      },
      at: new Date(stop.at),
    });
  }

  /** Why a review run ended without its decision applied, for its ticket's comment. */
  private reviewWhy(
    run: RunRow,
    failureReason: FailureReason,
    detail: string | undefined,
    repository: string,
  ): string {
    if (failureReason === 'agent_gave_up') {
      return `Quality gave up: ${sentence(run.outcome ?? 'it gave no reason')}`;
    }
    if (failureReason === 'review_branch_moved') {
      return 'the branch changed on the machine during the review';
    }
    if (failureReason === 'download_failed') {
      const { why } = downloadWords(runDownload(run), repository);
      return `${failureWords(failureReason)} at its start${sentence(why)}`;
    }
    return `${failureWords(failureReason)}${detail ? ` (${sentence(detail)})` : ''}`;
  }

  /**
   * A review run ended without its decision applied: the ticket returns to `in_review` from
   * `waiting_human`, or stays there, with the comment saying what happened; never counted (04,
   * section 2; owner's answer 6c, lot 3 step H2). A ticket the owner moved meanwhile is left.
   */
  private async reviewTicketBack(
    tx: Executor,
    locked: Locked,
    comment: string,
    actor: 'owner' | 'system',
    failureReason: FailureReason,
  ): Promise<void> {
    const { ticket } = locked;
    if (!ticket) return;
    const now = this.now();
    if (ticket.status === 'waiting_human') {
      await applyRunAction(tx, {
        projectKey: locked.project.key,
        ticket,
        action: 'review_ended',
        actor,
        runId: locked.run.id,
        failureReason,
        attemptCounted: false,
        comment,
        now,
      });
      return;
    }
    if (ticket.status !== 'in_review') return;
    const [row] = await tx
      .insert(schema.comments)
      .values({
        ticketId: ticket.id,
        author: 'system',
        kind: 'note',
        body: comment,
        runId: locked.run.id,
        createdAt: now,
      })
      .returning({ id: schema.comments.id });
    if (!row) throw new Error('comment not inserted');
    await recordEvent(tx, {
      actor,
      ...ticketEntity(ticket),
      type: 'ticket.commented',
      payload: {
        project: locked.project.key,
        ticket: this.reference(locked),
        commentId: row.id,
        kind: 'note',
      },
      at: now,
    });
  }

  /**
   * Quality's decision applied when its run ended `submitted` (06, section 4.5; owner's answer
   * 2d, lot 3 step H2): the `review` comments, the ticket's status and their events, with the
   * agent as actor; `review_applied_at` set, and its comment review wanted (true then). A decision
   * the ticket no longer allows is thrown away.
   */
  private async applyReview(tx: Executor, locked: Locked): Promise<boolean> {
    const { run, ticket } = locked;
    const decision = pendingDecision(run);
    if (!ticket || decision === null) return false;
    if (ticket.status !== 'in_review') {
      await this.reviewDiscarded(tx, locked, decision);
      return false;
    }
    const [profile] = await tx
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, run.profileId));
    if (!profile) throw new Error(`profile of run ${run.id} not found`);
    const agent = { key: profile.key, name: profile.name };
    const now = this.now();
    const bodies =
      decision.kind === 'approved' ? [decision.summary ?? ''] : decision.points.map(pointText);
    const ids: string[] = [];
    for (const body of bodies) {
      const [row] = await tx
        .insert(schema.comments)
        .values({
          ticketId: ticket.id,
          author: 'agent',
          authorProfileId: profile.id,
          runId: run.id,
          kind: 'review',
          body,
          createdAt: now,
        })
        .returning({ id: schema.comments.id });
      if (!row) throw new Error('comment not inserted');
      ids.push(row.id);
      await recordEvent(tx, {
        actor: 'agent',
        ...ticketEntity(ticket),
        type: 'ticket.commented',
        payload: {
          project: locked.project.key,
          ticket: this.reference(locked),
          commentId: row.id,
          kind: 'review',
          agent: agent.key,
          agentName: agent.name,
          runId: run.id,
        },
        at: now,
      });
    }
    // Quality's request counts one review round and stands until the next accepted submission
    // (owner's answers 1 and 2, lot 3 step I); never a failed attempt.
    const round = ticket.reviewRounds + 1;
    await applyRunAction(tx, {
      projectKey: locked.project.key,
      ticket,
      action: decision.kind === 'approved' ? 'review_approved' : 'review_changes_requested',
      actor: 'agent',
      agent,
      runId: run.id,
      commentId: ids[0],
      ...(decision.kind === 'changes_requested'
        ? {
            changeRequest: {
              by: 'quality' as const,
              commit: decision.commit,
              runId: run.id,
              round,
              at: now.toISOString(),
            },
          }
        : {}),
      now,
    });
    if (decision.kind === 'changes_requested') await this.stopAfterRounds(tx, locked, round, now);
    // Its comment review is wanted on the pull request reviewed, from this transaction on, so a
    // stop right after it still posts it at the next start (owner's answer 1, lot 3 step H3).
    const pullRequest = ticket.pullRequestNumber;
    await tx
      .update(schema.runs)
      .set({
        reviewAppliedAt: now,
        ...(pullRequest === null
          ? {}
          : { reviewPostWantedAt: now, reviewPostPullRequest: pullRequest }),
      })
      .where(eq(schema.runs.id, run.id));
    return pullRequest !== null;
  }

  /**
   * One request more than **Most review rounds per ticket** (read now) stops the ticket, after it
   * was applied in full (04, section 5; owner's answer 2, lot 3 step I): the stop, its `system`
   * comment and its event.
   */
  private async stopAfterRounds(tx: Executor, locked: Locked, round: number, now: Date) {
    const { ticket } = locked;
    if (!ticket) return;
    const { maxReviewRounds } = await resolveSettings(tx, ['maxReviewRounds'], locked.project.id);
    if (round <= maxReviewRounds) return;
    const stop: TicketStop = {
      cause: 'review_rounds',
      count: round,
      limit: maxReviewRounds,
      at: now.toISOString(),
    };
    const [comment] = await tx
      .insert(schema.comments)
      .values({
        ticketId: ticket.id,
        author: 'system',
        kind: 'status_change',
        body: `Quality requested changes again (round ${String(round)}), more than Most review rounds per ticket allows (${String(maxReviewRounds)}): the ticket is stopped. Use Try again to let it continue, or Cancel it, or Mark it as done manually.`,
        createdAt: now,
      })
      .returning({ id: schema.comments.id });
    if (!comment) throw new Error('comment not inserted');
    await recordEvent(tx, {
      actor: 'system',
      ...ticketEntity(ticket),
      type: 'ticket.commented',
      payload: {
        project: locked.project.key,
        ticket: this.reference(locked),
        commentId: comment.id,
        kind: 'status_change',
      },
      at: now,
    });
    await this.stopTicket(tx, locked, stop);
  }

  /** A decision of a review run that ended without applying it: kept, with its event (H2). */
  private async reviewDiscarded(
    tx: Executor,
    locked: Locked,
    decision: ReviewDecision,
  ): Promise<void> {
    await recordEvent(tx, {
      actor: 'system',
      entityType: 'run',
      entityId: locked.run.id,
      projectId: locked.project.id,
      type: 'run.review_discarded',
      payload: {
        project: locked.project.key,
        ticket: this.reference(locked),
        machine: locked.machine.name,
        decision: decision.kind,
        commit: decision.commit,
        failureReason:
          locked.run.failureReason === null ? null : FailureReason.parse(locked.run.failureReason),
      },
      at: this.now(),
    });
  }

  /** The head moved on GitHub at a review decision: the run fails, not counted (06, 4.5). */
  private async reviewHeadMoved(runId: string, head: string): Promise<void> {
    const machineId = await this.withRun(runId, async (tx, locked) => {
      if (!ACTIVE.has(locked.run.status) || locked.run.purpose !== 'review') return null;
      const commit = locked.run.reviewCommit ?? '';
      await this.fail(tx, locked, 'review_branch_moved', 'review_decision', {
        detail: `The pull request's head on GitHub is now ${head.slice(0, 7)}, not the commit under review ${commit.slice(0, 7)}`,
        reviewWhy: `the pull request changed on GitHub during the review (now ${head.slice(0, 7)})`,
        reviewMoved: { where: 'github', head },
      });
      return locked.machine.id;
    });
    if (machineId) await this.sendStop(machineId, runId, 'not_active');
  }

  /**
   * The `system` comment of a builder run ended `download_failed` (owner's answer 2, lot 3 step
   * K2): which of the three causes, what to do, and that it is not counted.
   */
  private downloadFailedComment(locked: Locked): string {
    const repository = `${locked.project.repoOwner}/${locked.project.repoName}`;
    const { why, todo } = downloadWords(runDownload(locked.run), repository);
    return `The run on machine ${locked.machine.name} ended: the project could not be downloaded from GitHub at its start${why} It does not count as a failed attempt. ${todo}`;
  }

  /**
   * The `system` comment of a run ended `push_failed` (04, section 5; lot 3 step F), from the
   * ticket's failure as it stands after the run's end push: gone when the end push was done.
   */
  private async pushFailedComment(
    tx: Executor,
    ticketId: string,
    runId: string,
    machineName: string,
  ): Promise<string> {
    const [ticket] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
    if (!ticket) throw new Error(`ticket ${ticketId} not found`);
    const [run] = await tx
      .select({ push: schema.runs.push })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    const failure = pushFailure(ticket);
    const ended = `The run on machine ${machineName} ended: its branch could not be pushed to GitHub`;
    const uncounted = 'It does not count as a failed attempt.';
    if (failure === null) {
      // The run's own latest push is its end push when it made one.
      return PushResult.nullable().parse(run?.push ?? null)?.status === 'pushed'
        ? `${ended} when the agent submitted, but the push at the run's end succeeded, so the branch is on GitHub now. ${uncounted} Run now continues the work on any machine.`
        : `${ended}. ${uncounted}`;
    }
    const permission = failure.reason === 'refused' ? pushPermission(failure.message) : null;
    const why =
      failure.reason === 'diverged'
        ? ", because GitHub's copy of the branch has commits that machine does not have. The next run brings them in with a merge."
        : failure.reason === 'unreachable'
          ? ', because GitHub could not be reached.'
          : permission === null
            ? `, because GitHub refused it: ${shorten(failure.message, 300)}`
            : `, because GitHub refused it. The token needs the permission ${PUSH_PERMISSION_WORDS[permission]}.`;
    return `${ended}${why} ${uncounted} The work is committed on ${machineName}: "Needs you" says what to do, then Run now continues it there.`;
  }

  /** Whether every commit of a branch report is on GitHub (07, section 3; lot 3 step D3). */
  private async allOnGitHub(
    tx: Executor,
    ticketId: string,
    branch: BranchReport,
  ): Promise<boolean> {
    const [ticket] = await tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId));
    if (!ticket) throw new Error(`ticket ${ticketId} not found`);
    return (
      commitsNotOnGitHub(ticket, {
        head: branch.head,
        commits: branch.commitsAhead,
        notOnGitHub: branch.notOnGitHub,
      }).count === 0
    );
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
      await this.sendStop(undone.machine.id, runId, 'not_active');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Machines

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
      .set({ state: 'available', limitedUntil: null, limitedUntilEstimated: false, updatedAt: now })
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
    const refusal = githubRefusal(connection);
    if (refusal !== null || !connection)
      throw refused(refusal ?? { reason: 'github_not_connected' });
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
    const { templates, rules, allowlist } = await this.files();
    const settings = await resolveSettings(this.db, RUN_START_SETTINGS);

    const prepared = await this.db.transaction(async (tx) => {
      const now = this.now();
      const project = await this.lockProject(tx, eq(schema.projects.key, projectKey));
      const projectRefused = projectRefusal(project);
      if (projectRefused !== null || project.defaultBranch === null) {
        throw refused(projectRefused ?? { reason: 'project_not_ready' });
      }
      const [ticket] = await tx
        .select()
        .from(schema.tickets)
        .where(
          and(eq(schema.tickets.projectId, project.id), eq(schema.tickets.number, ticketNumber)),
        )
        .for('update');
      if (!ticket) throw new HttpError(404, 'ticket_not_found', 'No ticket with this number');
      const blockers = await tx
        .select({ number: schema.tickets.number })
        .from(schema.ticketDependencies)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketDependencies.blockedById))
        .where(
          and(eq(schema.ticketDependencies.ticketId, ticket.id), ne(schema.tickets.status, 'done')),
        );
      // In todo, assigned, not stopped by the retry policy until **Try again** (04, section 5;
      // lot 3 step I), waiting for no ticket: the scheduler's checks (lot 4 step D1).
      const ticketRefused = ticketRefusal(
        ticket,
        blockers.map((row) => ticketReference(project.key, row.number)).sort(),
      );
      if (ticketRefused !== null || ticket.assigneeProfileId === null) {
        throw refused(ticketRefused ?? { reason: 'no_assignee' });
      }
      // A request for changes standing: the run addresses it (07, section 3; lot 3 step I).
      const request = standingRequest(ticket);
      const purpose = request === null ? ('implement' as const) : ('fix_review' as const);
      const [profile] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, ticket.assigneeProfileId));
      if (!profile) throw new Error(`profile ${ticket.assigneeProfileId} not found`);
      const required = z.array(Capability).parse(profile.requiredCapabilities);
      // Kept for the whole run: a later change of the setting applies to later runs (04, 8).
      const {
        maxAgentTicketsPerRun,
        ciStartWaitMinutes,
        ciWaitTimeoutMinutes,
        maxCiFailuresPerRun,
      } = await resolveSettings(
        tx,
        [
          'maxAgentTicketsPerRun',
          'ciStartWaitMinutes',
          'ciWaitTimeoutMinutes',
          'maxCiFailuresPerRun',
        ],
        project.id,
      );

      // The ticket's earlier runs, newest first, and the machine holding its commits not on
      // GitHub (07, section 3): once pushed, any machine can take the branch from GitHub.
      const earlier = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.ticketId, ticket.id))
        .orderBy(desc(schema.runs.createdAt));
      // A review run reports GitHub's head: it never holds work, nor moves it (lot 3 step D3).
      const { worked, withCommits, held, holding } = ticketWork(ticket, earlier);

      const { machine, account, lostWork } = await this.chooseMachine(tx, {
        projectId: project.id,
        earlier,
        required,
        now,
        holding: holding ? { machineId: holding.machineId, commits: held } : null,
      });

      // The first message (03, section 3.2): attempt, and earlier commits on this machine.
      // A review run is never an attempt of its own (owner's review of step H1).
      const attempt = worked.filter((run) => run.acknowledgedAt !== null).length + 1;
      // Earlier commits: on this machine, or pushed to GitHub, where the daemon takes them from.
      const lastHere = worked.find((run) => run.machineId === machine.id && run.commits !== null);
      const baseBranch = project.defaultBranch;
      const earlierWorkBase =
        (lastHere && (reportedCommits(lastHere)?.length ?? 0) > 0) ||
        (withCommits !== undefined && held === 0) ||
        pushedCommits(ticket).size > 0
          ? `origin/${baseBranch}`
          : null;
      // A push that failed and none done since: the work is committed but not on GitHub.
      const failure = pushFailure(ticket);
      const branchName = ticket.branchName ?? ticketBranchName(ticket.number, ticket.title);
      // Only on the machine whose push failed: another machine starts from GitHub's branch.
      const notPushed =
        failure === null || failure.machineId !== machine.id
          ? null
          : { branch: branchName, diverged: failure.reason === 'diverged' };
      // The previous run ended on CI: one sentence says so (owner's answer 8 and addition 4, G2b).
      const previous = worked[0];
      const previousResult =
        previous?.ciResult === null || previous === undefined
          ? null
          : CiResult.parse(previous.ciResult).state;
      // The owner's request made while GitHub reported a conflict (lot 3 step J3b): the same
      // conflict part as after a CI round's conflict, whatever the comment says.
      const previousCi =
        request?.by === 'owner' && request.conflict !== null
          ? { kind: 'conflict' as const, base: request.conflict.base }
          : previous === undefined
            ? null
            : (previous.failureReason === 'ci_failed' || previous.failureReason === 'ci_timeout') &&
                previousResult === 'conflict'
              ? { kind: 'conflict' as const, base: previous.baseBranch }
              : previous.failureReason === 'ci_failed'
                ? { kind: 'failed' as const }
                : previous.failureReason === 'ci_timeout' && previousResult === 'failed'
                  ? { kind: 'failed_unsent' as const }
                  : null;
      let initialPrompt: string;
      try {
        const implement = {
          projectKey: project.key,
          projectName: project.name,
          ticket,
          attempt,
          earlierWorkBase,
          notPushed,
          previousCi,
        };
        initialPrompt =
          request === null
            ? implementFirstMessage(templates.implement, await implementTicket(tx, implement))
            : fixReviewFirstMessage(
                templates['fix-review'],
                templates.implement,
                await fixReviewTicket(tx, {
                  ...implement,
                  request,
                  branch: branchName,
                  base: `origin/${baseBranch}`,
                  // Nothing pushed and the machine holding the work revoked (answer 5).
                  lost: lostWork !== undefined && ticket.githubBranchHead === null,
                }),
              );
      } catch (error) {
        if (!(error instanceof FirstMessageTooLarge)) throw error;
        throw refuse(
          { reason: 'first_message_too_large', maxBytes: FIRST_MESSAGE_MAX_BYTES },
          error.message,
        );
      }

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
          purpose,
          machineId: machine.id,
          accountId: account.id,
          status: 'queued',
          attempt,
          maxAgentTickets: maxAgentTicketsPerRun,
          ciStartWaitMinutes,
          ciWaitTimeoutMinutes,
          maxCiFailures: maxCiFailuresPerRun,
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
          purpose,
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
        const from =
          ticket.githubBranchHead === null
            ? `starts again from the base branch on machine ${machine.name}`
            : `starts from the branch as last pushed to GitHub, on machine ${machine.name}`;
        const body = `The earlier work on machine ${lostWork.machine.name} is no longer available: that machine was revoked, and the ${String(lostWork.commits)} commit${lostWork.commits === 1 ? '' : 's'} of the branch ${branchName} on it${ticket.githubBranchHead === null ? '' : ' not on GitHub'} ${lostWork.commits === 1 ? 'is' : 'are'} lost. This run ${from}.`;
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

      const start = this.startMessage({
        messageId: dispatchMessageId,
        runId: run.id,
        purpose,
        project,
        ticket: { id: ticket.id, reference },
        baseBranch,
        branchName,
        profile,
        github,
        files: { templates, rules, allowlist },
        runToken,
        initialPrompt,
        settings,
      });
      return { run, start, machine, reference, ackDeadline };
    });

    return this.dispatch(prepared);
  }

  /**
   * **Start review** (04, sections 2 and 3.2; owner's answers 2a and 4, lot 3 step H1): a `review`
   * run with the `quality` profile on any machine, for the commit CI checked for the accepted
   * submission. The pull request is read on GitHub first, outside the transaction: its head must
   * still be that commit. The ticket stays `in_review`.
   */
  async startReview(projectKey: string, ticketNumber: number): Promise<Run> {
    const github = await this.githubIdentity();
    const files = await this.files();
    const settings = await resolveSettings(this.db, RUN_START_SETTINGS);
    const before = await this.reviewSubject(this.db, projectKey, ticketNumber);
    const head = await this.pullRequestHead(before.project, before.pullRequest.number);
    if (head !== before.commit) {
      throw refuse(
        { reason: 'review_head_moved', commit: before.commit, head },
        `The pull request's head on GitHub (${head.slice(0, 7)}) is not the commit CI checked (${before.commit.slice(0, 7)})`,
      );
    }

    const prepared = await this.db.transaction(async (tx) => {
      const now = this.now();
      await this.lockProject(tx, eq(schema.projects.id, before.project.id));
      // Checked again under the lock: nothing changed since GitHub was read.
      const subject = await this.reviewSubject(tx, projectKey, ticketNumber, true);
      if (subject.commit !== before.commit) {
        throw refuse(
          { reason: 'review_head_moved', commit: subject.commit, head },
          'The work changed while the review was being started',
        );
      }
      const { project, ticket, source } = subject;
      const [profile] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.key, 'quality'));
      if (!profile) throw new Error('the quality profile is not seeded');
      const required = z.array(Capability).parse(profile.requiredCapabilities);
      const earlier = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.ticketId, ticket.id))
        .orderBy(desc(schema.runs.createdAt));
      const { machine, account } = await this.chooseMachine(tx, {
        projectId: project.id,
        earlier,
        required,
        now,
        holding: null,
      });
      const reference = ticketReference(project.key, ticket.number);
      const baseBranch = source.baseBranch;
      const branchName = ticket.branchName ?? source.branchName;
      let initialPrompt: string;
      try {
        initialPrompt = reviewFirstMessage(
          files.templates.review,
          await reviewTicket(tx, {
            projectKey: project.key,
            projectName: project.name,
            ticket,
            commit: subject.commit,
            pullRequest: subject.pullRequest,
            base: baseBranch,
            ci: subject.ci,
          }),
        );
      } catch (error) {
        if (!(error instanceof FirstMessageTooLarge)) throw error;
        throw refuse(
          { reason: 'first_message_too_large', maxBytes: FIRST_MESSAGE_MAX_BYTES },
          error.message,
        );
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
          purpose: 'review',
          machineId: machine.id,
          accountId: account.id,
          status: 'queued',
          // The attempt reviewed: a review is never an attempt of its own (04, section 3.2).
          attempt: source.attempt,
          reviewCommit: subject.commit,
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
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'run',
        entityId: run.id,
        projectId: project.id,
        type: 'run.created',
        payload: {
          project: project.key,
          ticket: reference,
          purpose: 'review',
          machine: machine.name,
          account: account.label,
          profile: profile.key,
          profileName: profile.name,
          profileVersion: profile.version,
          attempt: source.attempt,
        },
        at: now,
      });
      const start = this.startMessage({
        messageId: dispatchMessageId,
        runId: run.id,
        purpose: 'review',
        project,
        ticket: { id: ticket.id, reference },
        baseBranch,
        branchName,
        profile,
        github,
        files,
        runToken,
        initialPrompt,
        settings,
        reviewCommit: subject.commit,
      });
      return { run, start, machine, reference, ackDeadline };
    });
    return this.dispatch(prepared);
  }

  /**
   * What **Start review** reviews, or its refusal: a ticket in review, with a pull request, no run
   * active, and the commit CI checked for its accepted submission (passed, or "No CI found", in its
   * run or by **Check CI again** since).
   */
  private async reviewSubject(
    executor: Executor,
    projectKey: string,
    ticketNumber: number,
    lock = false,
  ): Promise<{
    project: ProjectRow;
    ticket: TicketRow;
    source: RunRow;
    commit: string;
    ci: ReviewCi;
    pullRequest: { number: number; url: string };
  }> {
    const [project] = await executor
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.key, projectKey));
    if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
    const projectRefused = projectRefusal(project);
    if (projectRefused !== null) throw refused(projectRefused);
    const query = executor
      .select()
      .from(schema.tickets)
      .where(
        and(eq(schema.tickets.projectId, project.id), eq(schema.tickets.number, ticketNumber)),
      );
    const [ticket] = lock ? await query.for('update') : await query;
    if (!ticket) throw new HttpError(404, 'ticket_not_found', 'No ticket with this number');
    if (ticket.status !== 'in_review') {
      throw refuse(
        { reason: 'ticket_not_in_review', status: TicketStatus.parse(ticket.status) },
        `Start review needs a ticket in in_review; it is ${ticket.status}`,
      );
    }
    const active = await executor
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.ticketId, ticket.id),
          inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );
    if (active.length > 0) throw refuse({ reason: 'review_active' }, 'A review is already running');
    const source = await ciSourceRun(executor, ticket.id);
    const outcome = source === null ? null : ciOutcome(source);
    const ci = reviewCiOf(outcome);
    // A ticket left in review by 0.3.0 has neither a pull request nor work CI checked.
    if (
      source === null ||
      outcome === null ||
      ci === null ||
      ticket.pullRequestNumber === null ||
      ticket.pullRequestUrl === null
    ) {
      throw refuse({ reason: 'no_pull_request' }, 'The ticket has no pull request to review');
    }
    return {
      project,
      ticket,
      source,
      commit: outcome.commit,
      ci,
      pullRequest: { number: ticket.pullRequestNumber, url: ticket.pullRequestUrl },
    };
  }

  /** The pull request's head on GitHub; a refusal when it cannot be read or is not open. */
  private async pullRequestHead(project: ProjectRow, number: number): Promise<string> {
    const read = await this.readPullRequest(project, number);
    if (!read.read) throw read.refusal;
    if (read.merged || !read.open) {
      throw refuse(
        { reason: 'pull_request_not_open', pullRequest: number, merged: read.merged },
        `Pull request #${String(number)} is not open on GitHub`,
      );
    }
    return read.head;
  }

  /**
   * One read of the pull request on GitHub (one request): its head and state, or why it could not
   * be read, as **Start review**'s refusal and in words for an agent (lot 3 steps H1 and H2).
   */
  private async readPullRequest(
    project: ProjectRow,
    number: number,
  ): Promise<
    | { read: true; head: string; open: boolean; merged: boolean }
    | { read: false; why: string; refusal: HttpError }
  > {
    const problem = (message: string) => ({
      read: false as const,
      why: message,
      refusal: refuse(
        { reason: 'github_problem', message },
        `GitHub could not be read: ${message}`,
      ),
    });
    let client;
    try {
      client = await storedTokenClient({
        db: this.db,
        key: this.options.key,
        apiUrl: this.options.githubApiUrl,
        log: this.log,
      });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return {
        read: false,
        why: 'the saved GitHub token cannot be read',
        refusal: refuse(
          { reason: 'github_token_unreadable' },
          'The saved GitHub token cannot be read',
        ),
      };
    }
    if (client === null) {
      return {
        read: false,
        why: 'GitHub is not connected',
        refusal: refuse({ reason: 'github_not_connected' }, 'GitHub is not connected'),
      };
    }
    let pull;
    try {
      pull = await readPullRequest(
        client,
        { owner: project.repoOwner, name: project.repoName },
        number,
      );
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return problem('GitHub could not be reached, or answered with a server error.');
    }
    if (!pull.ok) return problem(maskSecrets(pull.refusal.message));
    return {
      read: true,
      head: pull.value.headSha,
      open: pull.value.state === 'open',
      merged: pull.value.merged,
    };
  }

  /** Sends a run's `run.start` once its transaction is committed: `dispatched`, or cancelled. */
  private async dispatch(prepared: {
    run: RunRow;
    start: RunStart;
    machine: MachineRow;
    reference: string;
    ackDeadline: Date;
  }): Promise<Run> {
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

  /** A run's `run.start` (05, section 4.1), for Run now and Start review. */
  private startMessage(input: {
    messageId: string;
    runId: string;
    purpose: RunPurpose;
    project: ProjectRow;
    ticket: { id: string; reference: string };
    baseBranch: string;
    branchName: string;
    profile: typeof schema.agentProfiles.$inferSelect;
    github: { login: string; id: number };
    files: { templates: Templates; rules: Rules; allowlist: Template };
    runToken: string;
    initialPrompt: string;
    settings: Pick<SettingValues, (typeof RUN_START_SETTINGS)[number]>;
    reviewCommit?: string;
  }): RunStart {
    const { project, profile, github, settings, files } = input;
    const allowedTools = z.array(z.string()).parse(profile.allowedTools);
    return {
      type: 'run.start',
      id: input.messageId,
      payload: {
        runId: input.runId,
        purpose: input.purpose,
        subject: { kind: 'ticket', id: input.ticket.id, number: input.ticket.reference },
        repository: {
          owner: project.repoOwner,
          name: project.repoName,
          cloneUrl: `${this.options.gitBaseUrl.replace(/\/+$/, '')}/${project.repoOwner}/${project.repoName}.git`,
          baseBranch: input.baseBranch,
          ticketBranch: input.branchName,
        },
        commitAuthor: {
          name: `${profile.name} (Orchestrator)`,
          email: `${String(github.id)}+${github.login}@users.noreply.github.com`,
        },
        profile: {
          key: profile.key,
          version: profile.version,
          instructions: runInstructions(
            runRules(files.rules, input.purpose),
            profile.instructions,
            files.allowlist,
            allowedTools,
          ),
          model: profile.model,
          allowedTools,
        },
        runToken: input.runToken,
        initialPrompt: input.initialPrompt,
        nudgeMessage: nudgeMessage(files.templates, input.purpose),
        limits: {
          maxRunDurationMinutes: settings.maxRunDurationMinutes,
          idleTimeoutMinutes: settings.idleTimeoutMinutes,
          maxNudgesPerRun: settings.maxNudgesPerRun,
          waitingRunLifetimeMinutes: settings.waitingRunLifetimeMinutes,
          sessionStartTimeoutSeconds: settings.sessionStartTimeoutSeconds,
          mcpCallTimeoutSeconds: settings.mcpCallTimeoutSeconds,
          claudeCodeMcpToolTimeoutSeconds: settings.claudeCodeMcpToolTimeoutSeconds,
          pushTimeoutSeconds: settings.pushTimeoutSeconds,
        },
        resumeSessionId: null,
        mcpTools: runMcpTools(z.array(McpPermission).parse(profile.mcpPermissions), input.purpose),
        ...(input.reviewCommit === undefined ? {} : { reviewCommit: input.reviewCommit }),
      },
    };
  }

  /**
   * The machine a run starts on (07, sections 3 and 4) and its account, locked: the machine
   * holding the ticket's commits not on GitHub when there is one (`holding`), else the preferred
   * machine that can take it. A holder revoked gives `lostWork`.
   */
  private async chooseMachine(
    tx: Executor,
    input: {
      projectId: string;
      earlier: readonly RunRow[];
      required: Capability[];
      now: Date;
      holding: { machineId: string; commits: number } | null;
    },
  ): Promise<{
    machine: MachineRow;
    account: AccountRow;
    lostWork: { machine: MachineRow; commits: number } | undefined;
  }> {
    const { projectId, earlier, required, now, holding } = input;
    const fleet: Fleet = {
      machines: await tx.select().from(schema.machines),
      accounts: new Map(
        (await tx.select().from(schema.claudeAccounts)).map((account) => [account.id, account]),
      ),
      busy: await this.busyRuns(tx),
      now,
    };
    const choice = machineChoice(fleet, { required, holding });
    if (choice.refusal !== null) throw refused(choice.refusal);
    const { lostWork } = choice;
    const chosen =
      choice.machines.length === 1 && holding?.machineId === choice.machines[0]?.id
        ? choice.machines[0]
        : await this.preferred(tx, projectId, earlier, choice.machines);
    if (!chosen) throw new Error('no machine chosen');

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
    const unavailable = machineUnavailable(machine, account, recount, required, now);
    if (unavailable) {
      throw refused({
        reason: 'no_machine',
        machines: [{ machine: { id: machine.id, name: machine.name }, unavailable }],
      });
    }
    return { machine, account, lostWork };
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
    const today = await runsToday(tx, ids, this.now());
    return preferredMachine(available, { cloned, today, last: earlier[0]?.machineId });
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
        // Quality's question returns the ticket to review (04, section 2; lot 3 step H2).
        action: run.purpose === 'review' ? 'review_answered' : 'answered',
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
      comment:
        locked.run.purpose === 'review'
          ? `Your answer could not reach the review run: ${why}. The review run failed as "machine offline" and does not count as a failed attempt; the ticket stays in review, and your answer stays here.`
          : `Your answer could not reach the run: ${why}. The run failed as "machine offline" and does not count as a failed attempt. The branch ${locked.run.branchName} is kept on machine ${name}, and your answer stays here: the next run reads it in its first message.`,
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
      const busy = (await this.busyRuns(tx, account.id)).get(account.id) ?? 0;
      // The account, then its own machine: the scheduler's checks of a resume (lot 4 step D1).
      const resumeRefused = resumeRefusal(machine, account, busy, this.now());
      if (resumeRefused !== null) throw refused(resumeRefused);
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
      const decision = pendingDecision(locked.run);
      await this.setStatus(tx, locked, online ? 'cancelled' : 'failed', 'owner_stopped', {
        failureReason: online ? 'cancelled' : 'machine_offline',
      });
      if (locked.ticket && locked.run.purpose === 'review') {
        // The ticket stays in review, or returns to it from a question (owner's answer 6c).
        const stoppedHow = online
          ? 'Review run stopped by the owner'
          : `Review run stopped by the owner while machine ${locked.machine.name} was offline (it failed as "machine offline")`;
        await this.reviewTicketBack(
          tx,
          locked,
          decision === null
            ? `${stoppedHow}. It does not count as a failed attempt.`
            : `${stoppedHow} before ${decisionWords(decision)} was applied: it is not applied. It does not count as a failed attempt.`,
          'owner',
          online ? 'cancelled' : 'machine_offline',
        );
      } else if (locked.ticket) {
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
    if (stopped.online) await this.sendStop(stopped.locked.machine.id, runId, 'owner_stopped');
    this.log.info(
      { run: runId, ticket: this.reference(stopped.locked), machine: stopped.locked.machine.name },
      'run stopped by the owner',
    );
    return this.view(runId);
  }

  /**
   * **Cancel** or **Mark as done manually** on a ticket with an active run, in the owner action's
   * transaction (the project is locked), or its pull request found merged (lot 3 step J1): the run
   * is cancelled and its token revoked, never counted; a review decision not applied yet is kept
   * with `run.review_discarded`. Returns what to do once the transaction committed: send
   * `run.stop`.
   */
  async endForTicket(
    tx: Executor,
    project: ProjectRow,
    ticket: TicketRow,
    cause: 'ticket_cancelled' | 'ticket_done' | 'pull_request_merged',
  ): Promise<() => Promise<void>> {
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
    if (!run) return () => Promise.resolve();
    const [machine] = await tx
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, run.machineId));
    if (!machine) throw new Error('machine not found');
    const locked: Locked = { run, project, ticket, machine };
    await this.setStatus(tx, locked, 'cancelled', cause, { failureReason: 'cancelled' });
    return () =>
      this.sendStop(
        machine.id,
        run.id,
        cause === 'ticket_cancelled'
          ? 'ticket_cancelled'
          : cause === 'ticket_done'
            ? 'owner_stopped'
            : 'not_active',
      );
  }

  // ---------------------------------------------------------------------------------------------
  // The wait for CI (04, section 3.1; lot 3 step G1a): what `CiWatcher` found

  /**
   * The run still waits for CI of `commit`: active, with that commit (a later submission replaces
   * it, a confirmed CI round removes it). Starting is possible while a round resumes the session.
   */
  private waitsFor(locked: Locked, commit: string): boolean {
    return ACTIVE.has(locked.run.status) && locked.run.ciCommit === commit;
  }

  private ciFacts(locked: Locked) {
    return { project: locked.project.key, ticket: this.reference(locked) };
  }

  /** The result read, or the failed check, kept on the run with their events. */
  async ciRecorded(
    runId: string,
    commit: string,
    found: { result: CiResult } | { failure: Omit<CiCheckFailure, 'since' | 'at'> },
  ): Promise<void> {
    await this.withRun(runId, async (tx, locked) => {
      if (!this.waitsFor(locked, commit)) return;
      const now = this.now();
      // Every check changes the run page's CI card (its time, its checks), also when it writes no
      // event (lot 3 step G1b): the screens read the run again.
      await notifyChange(tx, { entity: 'run', id: runId, projectId: locked.project.id });
      const previous =
        locked.run.ciCheckFailure === null ? null : CiCheckFailure.parse(locked.run.ciCheckFailure);
      const event = <T extends 'run.ci_check_failed' | 'run.ci_check_recovered' | 'run.ci_result'>(
        type: T,
        payload: Omit<EventPayload<T>, 'project' | 'ticket'>,
      ) =>
        recordEvent(tx, {
          actor: 'system',
          entityType: 'run',
          entityId: runId,
          projectId: locked.project.id,
          type,
          payload: { ...this.ciFacts(locked), ...payload },
          at: now,
        });
      if ('failure' in found) {
        const same = previous !== null && previous.reason === found.failure.reason;
        const failure: CiCheckFailure = {
          ...found.failure,
          since: same ? previous.since : now.toISOString(),
          at: now.toISOString(),
        };
        await tx
          .update(schema.runs)
          .set({ ciCheckFailure: failure, updatedAt: now })
          .where(eq(schema.runs.id, runId));
        // Once when checking starts failing, or its reason changes; never at each tick.
        if (!same) {
          await event('run.ci_check_failed', {
            reason: failure.reason,
            message: failure.message,
          });
        }
        return;
      }
      await tx
        .update(schema.runs)
        .set({ ciResult: found.result, ciCheckedAt: now, ciCheckFailure: null, updatedAt: now })
        .where(eq(schema.runs.id, runId));
      if (previous !== null) await event('run.ci_check_recovered', {});
    });
  }

  private ciResultFacts(
    locked: Locked,
    commit: string,
    result: CiResult,
    pullRequestHead: string | null,
  ) {
    const submission =
      locked.run.submission === null ? null : SubmissionRecord.parse(locked.run.submission);
    return {
      commit,
      state: result.state,
      checks: result.checks.length,
      failed: result.checks.filter((check) => check.state === 'failed').map((check) => check.name),
      workflowChanges: submission?.workflowChanges
        ? (submission.workflowReason ?? 'not_listed')
        : null,
      baseBranch: locked.run.baseBranch,
      pullRequestHead,
    };
  }

  /**
   * The result read, kept on the run with its events: `ci_check_recovered` when a failed check
   * came before, `ci_result` when the state is new to the run (a conflict tried again after the
   * machine could not take its round writes nothing more).
   */
  private async recordDecision(
    tx: Executor,
    locked: Locked,
    commit: string,
    result: CiResult,
    pullRequestHead: string | null,
  ): Promise<void> {
    const now = this.now();
    const before = locked.run.ciResult === null ? null : CiResult.parse(locked.run.ciResult).state;
    await tx
      .update(schema.runs)
      .set({
        ciResult: result,
        ciCheckedAt: now,
        ciCheckFailure: null,
        ciPullRequestHead: pullRequestHead,
        updatedAt: now,
      })
      .where(eq(schema.runs.id, locked.run.id));
    await notifyChange(tx, { entity: 'run', id: locked.run.id, projectId: locked.project.id });
    if (locked.run.ciCheckFailure !== null) {
      await recordEvent(tx, {
        actor: 'system',
        entityType: 'run',
        entityId: locked.run.id,
        projectId: locked.project.id,
        type: 'run.ci_check_recovered',
        payload: this.ciFacts(locked),
        at: now,
      });
    }
    locked.run = { ...locked.run, ciResult: result, ciCheckedAt: now, ciCheckFailure: null };
    if (before === result.state || result.state === 'pending') return;
    await recordEvent(tx, {
      actor: 'system',
      entityType: 'run',
      entityId: locked.run.id,
      projectId: locked.project.id,
      type: 'run.ci_result',
      payload: {
        ...this.ciFacts(locked),
        ...this.ciResultFacts(locked, commit, result, pullRequestHead),
        state: result.state,
      },
      at: now,
    });
  }

  /**
   * A result that decides (04, section 3.1). Passed or "No CI found": the run succeeds and the
   * ticket moves to `in_review` in one transaction, then `run.stop` `completed` ends the session
   * (a machine offline gets its stop at its reconnection); it wins over a deadline passed
   * meanwhile. A failure or a conflict is a CI round (`ciRound`); a failure whose runs GitHub
   * cancelled because the branch moved ends the run `ci_cancelled`, not counted (lot 3 step G2b).
   */
  async ciDecided(runId: string, commit: string, decided: CiDecision): Promise<void> {
    const { result } = decided;
    if (result.state === 'failed' || result.state === 'conflict') {
      if (result.state === 'failed' && decided.branchMoved === true) {
        await this.ciCancelled(runId, commit, decided);
        return;
      }
      await this.ciRound(runId, commit, {
        result: { ...result, state: result.state },
        pullRequestHead: decided.pullRequestHead,
      });
      return;
    }
    const ended = await this.withRun(runId, async (tx, locked) => {
      if (!this.waitsFor(locked, commit) || locked.run.ciRoundMessageId !== null) return null;
      await this.recordDecision(tx, locked, commit, result, decided.pullRequestHead);
      await this.setStatus(tx, locked, 'succeeded', 'ci_result');
      if (locked.ticket) {
        await applyRunAction(tx, {
          projectKey: locked.project.key,
          ticket: locked.ticket,
          action: 'run_submitted',
          actor: 'system',
          runId,
          now: this.now(),
        });
      }
      return locked.machine.id;
    });
    if (ended) await this.sendStop(ended, runId, 'completed');
  }

  /**
   * Every failed check of the submitted commit is a workflow run GitHub cancelled, and the pull
   * request's head is another commit: the branch moved on GitHub, not the agent's failure. The
   * run ends at once, not counted; the next run takes GitHub's branch (owner's answer 2, step G2b).
   */
  private async ciCancelled(runId: string, commit: string, decided: CiDecision): Promise<void> {
    const ended = await this.withRun(runId, async (tx, locked) => {
      if (!this.waitsFor(locked, commit) || locked.run.ciRoundMessageId !== null) return null;
      await this.recordDecision(tx, locked, commit, decided.result, decided.pullRequestHead);
      const head = (decided.pullRequestHead ?? '').slice(0, 7);
      const words = failureWords('ci_cancelled');
      await this.fail(tx, locked, 'ci_cancelled', 'ci_result', {
        detail: `${words}: the pull request's head is now ${head}, not the submitted commit ${commit.slice(0, 7)}`,
        comment: `The run on machine ${locked.machine.name} ended: ${words} (the pull request's head is now ${head}, not the submitted commit ${commit.slice(0, 7)}). It does not count as a failed attempt. Run now starts the next run from the branch as it is on GitHub.`,
      });
      return locked.machine.id;
    });
    if (ended) await this.sendStop(ended, runId, 'not_active');
  }

  /** **Most CI failures per run** as the run keeps it; today's value for a run started before. */
  private async maxCiFailures(executor: Executor, run: RunRow): Promise<number> {
    if (run.maxCiFailures !== null) return run.maxCiFailures;
    const { maxCiFailuresPerRun } = await resolveSettings(
      executor,
      ['maxCiFailuresPerRun'],
      run.projectId,
    );
    return maxCiFailuresPerRun;
  }

  /**
   * A failed result or a conflict (owner's answers 1 to 4, lot 3 step G2b). One more than **Most
   * CI failures per run** confirmed rounds ends the run `ci_failed`, counted; past **CI wait at
   * submission**, `ci_timeout`; otherwise it becomes the run's unanswered round, with its message
   * id, and is sent. A failure's jobs and excerpts are read first, outside the run's lock.
   */
  private async ciRound(
    runId: string,
    commit: string,
    decided: {
      result: CiResult & { state: 'failed' | 'conflict' };
      pullRequestHead: string | null;
    },
  ): Promise<void> {
    const kind = decided.result.state;
    let result: CiResult = decided.result;
    const [row] = await this.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (!row || row.ciCommit !== commit || row.ciRoundMessageId !== null) return;
    if (kind === 'failed') {
      const [project] = await this.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, row.projectId));
      const counted = z.array(CiRound).parse(row.ciRounds).length;
      if (project && counted < (await this.maxCiFailures(this.db, row))) {
        result = await this.ciStatus.withFailedJobs(row, project, commit, result);
      }
    }
    const outcome = await this.withRun(runId, async (tx, locked) => {
      if (!this.waitsFor(locked, commit) || locked.run.ciRoundMessageId !== null) return null;
      const now = this.now();
      const done = z
        .array(CiRound)
        .parse(locked.run.ciRounds)
        .filter((round) => round.confirmedAt !== null);
      const max = await this.maxCiFailures(tx, locked.run);
      await this.recordDecision(tx, locked, commit, result, decided.pullRequestHead);
      if (done.length >= max) {
        await this.ciTooMany(tx, locked, commit, kind, result, done.length, max);
        return { machineId: locked.machine.id, send: false };
      }
      const deadlines = ciDeadlines(locked.run);
      if (deadlines !== null && now >= deadlines.deadline) {
        // A result read only after the wait ended still says what it was (owner's review, G2b).
        const late =
          kind === 'failed'
            ? `CI failed on GitHub (failed: ${failedChecks(result)}), and the result was read only after the wait had ended.`
            : `the pull request conflicts with ${locked.run.baseBranch}, so GitHub started no CI`;
        await this.ciTimeout(tx, locked, this.ciTimeoutDetail(locked, late));
        return { machineId: locked.machine.id, send: false };
      }
      const round: CiRound = {
        round: done.length + 1,
        kind,
        commit,
        messageId: randomUUID(),
        via: locked.run.sessionAlive || locked.run.claudeSessionId === null ? 'input' : 'resume',
        decidedAt: now.toISOString(),
        sentAt: null,
        confirmedAt: null,
        result,
        readAt: (locked.run.ciCheckedAt ?? now).toISOString(),
      };
      await tx
        .update(schema.runs)
        .set({ ciRounds: [...done, round], ciRoundMessageId: round.messageId, updatedAt: now })
        .where(eq(schema.runs.id, runId));
      return { machineId: locked.machine.id, send: true };
    });
    if (outcome === null) return;
    if (outcome.send) await this.sendRound(runId);
    else await this.sendStop(outcome.machineId, runId, 'not_active');
  }

  /** One failure more than **Most CI failures per run**: the run ends `ci_failed`, counted. */
  private async ciTooMany(
    tx: Executor,
    locked: Locked,
    commit: string,
    kind: 'failed' | 'conflict',
    result: CiResult,
    rounds: number,
    max: number,
  ): Promise<void> {
    const sent = `after ${String(rounds)} CI round${rounds === 1 ? '' : 's'} sent back to the agent, the most this run allows (Most CI failures per run: ${String(max)})`;
    const names = result.checks
      .filter((check) => check.state === 'failed')
      .map((check) => check.name)
      .join(', ');
    const what =
      kind === 'conflict'
        ? `the pull request of the submitted commit ${commit.slice(0, 7)} conflicts with ${locked.run.baseBranch}`
        : `CI failed on GitHub for the submitted commit ${commit.slice(0, 7)} (${names})`;
    await this.fail(tx, locked, 'ci_failed', 'ci_result', {
      detail: `${what.charAt(0).toUpperCase()}${what.slice(1)} ${sent}`,
      comment: `Attempt ${String(locked.run.attempt)} failed on machine ${locked.machine.name}: ${what} ${sent}. ${COUNTED_SENTENCE} The branch ${locked.run.branchName} is on GitHub, with its pull request.`,
    });
  }

  /** Sends the run's unanswered CI round, the same message each time; when sent, its time. */
  private async sendRound(runId: string): Promise<void> {
    const { templates } = await this.files();
    const settings = await resolveSettings(this.db, ['githubPollSeconds', 'ciLogReadMaxMegabytes']);
    const prepared = await this.withRun(runId, async (tx, locked) => {
      const id = locked.run.ciRoundMessageId;
      const round = z.array(CiRound).parse(locked.run.ciRounds).at(-1);
      if (id === null || round?.messageId !== id || !ACTIVE.has(locked.run.status)) return null;
      const text = ciFailedMessage(templates, {
        kind: round.kind,
        round: round.round,
        max: await this.maxCiFailures(tx, locked.run),
        commit: round.commit,
        base: locked.run.baseBranch,
        result: round.result,
        settings,
      });
      const fetchBase = round.kind === 'conflict' ? { fetchBase: true } : {};
      const sessionId = locked.run.claudeSessionId;
      const message: ServerMessage =
        round.via === 'resume' && sessionId !== null
          ? {
              type: 'run.resume',
              id,
              payload: { runId, claudeSessionId: sessionId, message: text, ...fetchBase },
            }
          : { type: 'run.input', id, payload: { runId, text, ...fetchBase } };
      return { machineId: locked.machine.id, message };
    });
    if (prepared === null || !this.send(prepared.machineId, prepared.message)) return;
    await this.withRun(runId, async (tx, locked) => {
      if (locked.run.ciRoundMessageId !== prepared.message.id) return;
      const rounds = z.array(CiRound).parse(locked.run.ciRounds);
      const last = rounds.at(-1);
      if (!last) return;
      await tx
        .update(schema.runs)
        .set({ ciRounds: [...rounds.slice(0, -1), { ...last, sentAt: this.now().toISOString() }] })
        .where(eq(schema.runs.id, runId));
    });
  }

  /** The watcher's turn for an unanswered round: sent again, the same message. */
  async ciRoundDue(runId: string): Promise<void> {
    await this.sendRound(runId);
  }

  /**
   * The daemon's answer to a CI round (owner's answer 1 of step G2b, point 2). Confirmed: the
   * round counts, the run's wait and decision go, and the agent works on. The session closed (or
   * still alive): the round goes the other way, a new message. Any other refusal (the base
   * branch not downloaded): not counted, and the next check decides again.
   */
  private async ciRoundAnswered(runId: string, ack: Ack): Promise<void> {
    const again = await this.withRun(runId, async (tx, locked) => {
      if (locked.run.ciRoundMessageId !== ack.id || !ACTIVE.has(locked.run.status)) return false;
      const rounds = z.array(CiRound).parse(locked.run.ciRounds);
      const pending = rounds.at(-1);
      if (pending?.messageId !== ack.id) return false;
      const now = this.now();
      const earlier = rounds.slice(0, -1);
      if (ack.payload.ok) {
        await tx
          .update(schema.runs)
          .set({
            ciRounds: [...earlier, { ...pending, confirmedAt: now.toISOString() }],
            ciRoundMessageId: null,
            ciRoundRefusal: null,
            // The wait and the decision go with the round (owner's answer 3): the agent hands in
            // again, and a later result of this commit finds nothing to decide.
            ciCommit: null,
            ciWaitStartedAt: null,
            ciResult: null,
            ciCheckedAt: null,
            ciCheckFailure: null,
            decision: null,
            updatedAt: now,
          })
          .where(eq(schema.runs.id, runId));
        await recordEvent(tx, {
          actor: 'system',
          entityType: 'run',
          entityId: runId,
          projectId: locked.project.id,
          type: 'run.ci_round_sent',
          payload: {
            ...this.ciFacts(locked),
            commit: pending.commit,
            kind: pending.kind,
            round: pending.round,
            of: await this.maxCiFailures(tx, locked.run),
          },
          at: now,
        });
        await notifyChange(tx, { entity: 'run', id: runId, projectId: locked.project.id });
        return false;
      }
      const { message } = ack.payload;
      const via =
        message === SESSION_CLOSED_REFUSAL && pending.via === 'input'
          ? 'resume'
          : message === SESSION_ALIVE_REFUSAL && pending.via === 'resume'
            ? 'input'
            : null;
      if (via !== null && (via === 'input' || locked.run.claudeSessionId !== null)) {
        // Not delivered: a new message id is safe, and the daemon never gave the first one.
        const switched: CiRound = { ...pending, via, messageId: randomUUID(), sentAt: null };
        await tx
          .update(schema.runs)
          .set({ ciRounds: [...earlier, switched], ciRoundMessageId: switched.messageId })
          .where(eq(schema.runs.id, runId));
        return true;
      }
      const refusal: CiRoundRefusal = {
        kind: pending.kind,
        message: cutText(maskSecrets(message), TEXT_CEILING, 'end'),
        at: now.toISOString(),
      };
      const previous =
        locked.run.ciRoundRefusal === null ? null : CiRoundRefusal.parse(locked.run.ciRoundRefusal);
      await tx
        .update(schema.runs)
        .set({ ciRounds: earlier, ciRoundMessageId: null, ciRoundRefusal: refusal, updatedAt: now })
        .where(eq(schema.runs.id, runId));
      if (previous?.message !== refusal.message || previous.kind !== refusal.kind) {
        await recordEvent(tx, {
          actor: 'system',
          entityType: 'run',
          entityId: runId,
          projectId: locked.project.id,
          type: 'run.ci_round_not_taken',
          payload: {
            ...this.ciFacts(locked),
            commit: pending.commit,
            kind: pending.kind,
            message: refusal.message,
          },
          at: now,
        });
      }
      return false;
    });
    if (again === true) await this.sendRound(runId);
  }

  /**
   * Why **CI wait at submission** ended the run, saying a round the machine did not confirm or
   * could not take (owner's answer 2 of step G2b: "The pull request conflicts with <base>, and the
   * machine could not download <base> from GitHub: <reason>.").
   */
  private ciTimeoutDetail(locked: Locked, fallback: string): string {
    const base = locked.run.baseBranch;
    const machine = locked.machine.name;
    const pending =
      locked.run.ciRoundMessageId === null
        ? undefined
        : z.array(CiRound).parse(locked.run.ciRounds).at(-1);
    if (pending !== undefined) {
      return pending.kind === 'conflict'
        ? `The pull request conflicts with ${base}, and machine ${machine} did not confirm it received the message telling the agent to merge it.`
        : `CI failed on GitHub, and machine ${machine} did not confirm it received the result.`;
    }
    const refusal =
      locked.run.ciRoundRefusal === null ? null : CiRoundRefusal.parse(locked.run.ciRoundRefusal);
    if (refusal !== null) {
      const prefix = `Downloading ${base} from GitHub failed: `;
      const reason = refusal.message.startsWith(prefix)
        ? refusal.message.slice(prefix.length)
        : refusal.message;
      const ended = /[.!?]$/.test(reason) ? reason : `${reason}.`;
      return refusal.kind === 'conflict'
        ? `The pull request conflicts with ${base}, and the machine could not download ${base} from GitHub: ${ended}`
        : `CI failed on GitHub, and machine ${machine} could not take the result: ${ended}`;
    }
    const result = locked.run.ciResult === null ? null : CiResult.parse(locked.run.ciResult);
    if (result?.state === 'conflict') {
      return `the pull request conflicts with ${base}, so GitHub started no CI`;
    }
    return fallback;
  }

  /** The run fails with `ci_timeout`, not counted, and the ticket returns to `todo`. */
  private async ciTimeout(tx: Executor, locked: Locked, detail: string): Promise<void> {
    const minutes = locked.run.ciWaitTimeoutMinutes ?? 0;
    await tx
      .update(schema.runs)
      .set({ ciRoundMessageId: null })
      .where(eq(schema.runs.id, locked.run.id));
    // What was found, never "CI did not finish" when it did (owner's answer 1, lot 3 step G2c).
    const found = /[.!?]$/.test(detail) ? detail : `${detail}.`;
    await this.fail(tx, locked, 'ci_timeout', 'ci_timeout', {
      detail: `CI wait at submission (${String(minutes)} minutes) reached: ${detail}`,
      comment: `The run on machine ${locked.machine.name} ended when CI wait at submission (${String(minutes)} minutes) was reached: ${found.charAt(0).toUpperCase()}${found.slice(1)} It does not count as a failed attempt.`,
    });
  }

  /**
   * **CI wait at submission** reached without a result that decides: the run fails with
   * `ci_timeout`, not counted, and the ticket returns to `todo` (04, sections 3.1 and 5). Step G2c
   * adds "CI did not finish" and **Check CI again**.
   */
  async ciTimedOut(runId: string, commit: string, detail: string): Promise<void> {
    const ended = await this.withRun(runId, async (tx, locked) => {
      if (!this.waitsFor(locked, commit)) return null;
      await this.ciTimeout(tx, locked, this.ciTimeoutDetail(locked, detail));
      return locked.machine.id;
    });
    if (ended) await this.sendStop(ended, runId, 'not_active');
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
    const [run] = await this.list(eq(schema.runs.id, runId), []);
    if (!run) throw runNotFound();
    return run;
  }

  /** The runs matching `where`, in `order`, at most `limit`, as the API shows them. */
  async list(where: SQL | undefined, order: SQL[], limit?: number): Promise<Run[]> {
    const query = this.db
      .select({
        run: schema.runs,
        projectKey: schema.projects.key,
        base: schema.projects.defaultBranch,
        ticketNumber: schema.tickets.number,
        pullRequestNumber: schema.tickets.pullRequestNumber,
        pullRequestUrl: schema.tickets.pullRequestUrl,
        pullRequestState: schema.tickets.pullRequestState,
        profile: { key: schema.agentProfiles.key, name: schema.agentProfiles.name },
        machine: {
          id: schema.machines.id,
          name: schema.machines.name,
          status: schema.machines.status,
        },
        account: schema.claudeAccounts,
      })
      .from(schema.runs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
      .innerJoin(schema.agentProfiles, eq(schema.agentProfiles.id, schema.runs.profileId))
      .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
      .innerJoin(schema.claudeAccounts, eq(schema.claudeAccounts.id, schema.runs.accountId))
      .where(where)
      .orderBy(...order);
    const rows = await (limit === undefined ? query : query.limit(limit));
    const now = this.now();
    return rows.map((row) =>
      toRun(row.run, {
        projectKey: row.projectKey,
        ticketNumber: row.ticketNumber,
        profile: row.profile,
        machine: {
          id: row.machine.id,
          name: row.machine.name,
          online: row.machine.status === 'online',
        },
        account: { id: row.account.id, label: row.account.label },
        resumeAfter: resumeAfter(row.run, row.account, now),
        pullRequest:
          row.pullRequestNumber === null ||
          row.pullRequestUrl === null ||
          row.pullRequestState === null
            ? null
            : {
                number: row.pullRequestNumber,
                url: row.pullRequestUrl,
                state: PullRequestState.parse(row.pullRequestState),
              },
        base: row.base,
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // The daemon's messages (05, section 3.3)

  /** The daemon acknowledged a command: a `run.start` or `run.resume` is then dispatched. */
  async acknowledged(machineId: string, ack: Ack): Promise<void> {
    const [round] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ciRoundMessageId, ack.id), eq(schema.runs.machineId, machineId)));
    if (round) {
      await this.ciRoundAnswered(round.id, ack);
      return;
    }
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
    if (result === 'late') await this.sendStop(machineId, run.id, 'not_active');
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
    const after: (() => Promise<void>)[] = [];
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
        const ticketId = locked.ticket?.id;
        if (ticketId !== undefined) {
          after.push(() => {
            this.options.endReported?.(ticketId);
            return Promise.resolve();
          });
        }
        if (payload.gitConfigRestored !== null) {
          // Information only: never a "Needs you" item, never a refusal (lot 3 step D2).
          await recordEvent(tx, {
            actor: 'system',
            entityType: 'run',
            entityId: run.id,
            projectId: locked.project.id,
            type: 'run.git_config_restored',
            payload: {
              project: locked.project.key,
              ticket: this.reference(locked),
              machine: locked.machine.name,
              repository: `${locked.project.repoOwner}/${locked.project.repoName}`,
              changes: maskSecrets(payload.gitConfigRestored),
            },
            at: this.now(),
          });
        }
        if (payload.push !== null && locked.ticket) {
          await recordPush(tx, {
            project: locked.project,
            ticket: locked.ticket,
            run: locked.run,
            machine: locked.machine,
            result: payload.push,
            branch: payload.branch,
            when: 'end',
            now: this.now(),
          });
        }
        const branch = payload.branch
          ? {
              branchHead: payload.branch.head,
              commits: payload.branch.commitsAhead,
              notOnGitHub: payload.branch.notOnGitHub,
            }
          : {};
        if (!ACTIVE.has(run.status)) {
          // Already ended on the server (Stop run, revocation, CI passed): the report adds the
          // branch only, which open screens read again.
          await tx
            .update(schema.runs)
            .set({
              ...branch,
              sessionAlive: false,
              endReportedAt: this.now(),
              updatedAt: this.now(),
            })
            .where(eq(schema.runs.id, run.id));
          await notifyChange(tx, { entity: 'run', id: run.id, projectId: locked.project.id });
          return true;
        }
        await tx
          .update(schema.runs)
          .set({
            ...session,
            ...branch,
            endReportedAt: this.now(),
            ...(payload.reason === 'download_failed' ? { downloadFailure: payload.download } : {}),
          })
          .where(eq(schema.runs.id, run.id));
        if (payload.reason === 'submitted' && run.ciCommit !== null) {
          // Only the CI result accepts a submission waiting for it: the run keeps waiting with
          // its session gone, as when Claude Code ends during the wait (lot 3 step G1a).
          return true;
        }
        if (
          run.purpose === 'review' &&
          payload.reason === 'submitted' &&
          payload.headMoved !== true &&
          pendingDecision(run) !== null
        ) {
          // Quality's decision applies now, and only now (owner's answer 2d, lot 3 step H2).
          await this.setStatus(tx, locked, 'succeeded', 'daemon', {
            endReason: payload.reason,
            detail: payload.detail ?? undefined,
          });
          if (await this.applyReview(tx, locked)) {
            after.push(() => {
              this.options.reviewPostWanted?.(run.id);
              return Promise.resolve();
            });
          }
          return true;
        }
        const end = endOfReason(
          run.purpose === 'review' && payload.headMoved === true
            ? 'review_branch_moved'
            : payload.reason,
        );
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
          // Where a review found the head moved (owner's answer 3, lot 3 step H4): at the end on
          // the machine, or at preparation, before any session, with GitHub's head then.
          const moved =
            run.purpose === 'review' && end.failureReason === 'review_branch_moved'
              ? payload.headMoved === true
                ? { where: 'machine' as const, head: null }
                : { where: 'before_start' as const, head: payload.movedHead }
              : undefined;
          await this.fail(tx, locked, end.failureReason, 'daemon', {
            endReason: payload.reason,
            detail,
            reviewMoved: moved,
            ...(moved?.where === 'before_start'
              ? {
                  reviewWhy: `the pull request changed on GitHub before the review started${moved.head === null ? '' : ` (now ${moved.head.slice(0, 7)})`}`,
                }
              : {}),
            onGitHub:
              payload.branch !== null &&
              locked.ticket !== null &&
              (await this.allOnGitHub(tx, locked.ticket.id, payload.branch)),
          });
        }
        return true;
      }

      if (!ACTIVE.has(run.status)) {
        // The server ended it: the daemon stops the session (05, section 6).
        after.push(() => this.sendStop(machineId, run.id, 'not_active'));
        return true;
      }
      // The session idle waiting for CI: its time counts as waiting from now, and as working
      // again when the agent works on (01, section 3.7; lot 3 step G1a).
      const waitingForCi = payload.state === 'waiting_ci';
      if (waitingForCi !== (run.ciWaitingSince !== null)) {
        const ciTimes = {
          ...statusTimes(run, this.now()),
          ciWaitingSince: waitingForCi ? this.now() : null,
        };
        await tx.update(schema.runs).set(ciTimes).where(eq(schema.runs.id, run.id));
        locked.run = { ...run, ...ciTimes };
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
          after.push(() => this.sendStop(machineId, run.id, 'not_active'));
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
    for (const action of after) await action();
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
        .set({
          // The owner's Stop new runs stays: Resume goes back to the limit (lot 4 step C).
          state: account.state === 'paused_manual' ? 'paused_manual' : 'limited',
          limitedUntil: until,
          limitedUntilEstimated: !known,
          updatedAt: now,
        })
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
            enrolledAt: schema.machines.enrolledAt,
          })
          .from(schema.runs)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
          .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
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
    const { command } = message.payload;
    if (command === 'push' && row.enrolledAt !== null && row.run.createdAt < row.enrolledAt) {
      // A run of an earlier enrollment of this machine (revoked, then enrolled again) never
      // pushes again: the clean-up after a merge stops waiting for it at the revocation (owner's
      // answer 1, lot 3 step J2).
      return refused('the run started before this machine was enrolled again');
    }
    if (command === 'push' && !PUSHING.has(row.run.status)) {
      const ending = await this.endingWindow(row.run);
      if (ending === null) return refused(`the run is ${row.run.status}`);
      if (!ending.open) {
        return refused(
          `the run was stopped more than ${String(ending.seconds)} seconds ago (MCP call timeout plus Longest push)`,
        );
      }
    } else if (command === 'fetch' && !FETCHING.has(row.run.status)) {
      return refused(`the run is ${row.run.status}`);
    }
    if (command === 'push' && row.run.purpose === 'review') {
      return refused('a review run never pushes');
    }
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
    this.log.info({ machine: machineId, run: runId }, `git credential sent for a ${command}`);
    return { ok: true, username: 'x-access-token', password: token };
  }

  /**
   * An "ending" run (05, section 7; lot 3 step D2): ended by the server, which sent `run.stop`,
   * and whose end the machine has not reported yet. Its end push gets a credential until MCP call
   * timeout plus Longest push after `run.stop`; null for a run that is not ending.
   */
  private async endingWindow(run: RunRow): Promise<{ open: boolean; seconds: number } | null> {
    if (!TERMINAL.has(run.status) || run.stopSentAt === null || run.endReportedAt !== null) {
      return null;
    }
    const settings = await resolveSettings(this.db, [
      'mcpCallTimeoutSeconds',
      'pushTimeoutSeconds',
    ]);
    const seconds = settings.mcpCallTimeoutSeconds + settings.pushTimeoutSeconds;
    return { open: this.now().getTime() - run.stopSentAt.getTime() <= seconds * 1000, seconds };
  }

  /**
   * At `hello` (05, section 6, lot 2 part): a run the daemon still has but the server no longer
   * considers active is stopped, which also ends a session whose end was never reported.
   */
  async reconcile(machineId: string, runs: Hello['payload']['runs']): Promise<void> {
    // A started run whose end was never reported and that the daemon no longer has: it never
    // pushes for it again, so the clean-up after a merge stops waiting for it (lot 3 step J2a).
    const held = runs
      .map((reported) => reported.runId)
      .filter((id) => z.uuid().safeParse(id).success);
    await this.db
      .update(schema.runs)
      .set({ endMissingAt: this.now() })
      .where(
        and(
          eq(schema.runs.machineId, machineId),
          isNotNull(schema.runs.acknowledgedAt),
          isNull(schema.runs.endReportedAt),
          isNull(schema.runs.endMissingAt),
          ...(held.length > 0 ? [notInArray(schema.runs.id, held)] : []),
        ),
      );
    for (const reported of runs) {
      const [run] = await this.db
        .select({ status: schema.runs.status, machineId: schema.runs.machineId })
        .from(schema.runs)
        .where(eq(schema.runs.id, reported.runId));
      if (run && run.machineId === machineId && ACTIVE.has(run.status)) continue;
      this.log.info({ machine: machineId, run: reported.runId }, 'run no longer active: stopped');
      await this.sendStop(machineId, reported.runId, 'not_active');
    }
  }
}

function stopMessage(
  runId: string,
  reason: 'owner_stopped' | 'ticket_cancelled' | 'not_active' | 'completed',
): ServerMessage {
  return { type: 'run.stop', id: randomUUID(), payload: { runId, reason } };
}

export const runNotFound = () => new HttpError(404, 'run_not_found', 'No run with this id');

/** A text as the end of a sentence: without its own final full stop. */
function sentence(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}

/** A review run's decision not applied yet; null when it made none or it was applied (H2). */
function pendingDecision(run: RunRow): ReviewDecision | null {
  if (run.purpose !== 'review' || run.reviewDecision === null || run.reviewAppliedAt !== null) {
    return null;
  }
  return ReviewDecision.parse(run.reviewDecision);
}

/** "Quality's approval of commit abc1234", for the ticket's comments (owner's answer 5). */
function decisionWords(decision: ReviewDecision): string {
  const commit = decision.commit.slice(0, 7);
  if (decision.kind === 'approved') return `Quality's approval of commit ${commit}`;
  const count = decision.points.length;
  return `Quality's request for changes (${String(count)} point${count === 1 ? '' : 's'}) on commit ${commit}`;
}

/** The comment of a review run that ended without its decision applied (owner's answer 5). */
function reviewEndComment(locked: Pick<Locked, 'run' | 'machine'>, why: string): string {
  const machine = locked.machine.name;
  const decision = pendingDecision(locked.run);
  if (decision === null) {
    return `The review run on machine ${machine} ended without a decision: ${why}. It does not count as a failed attempt.`;
  }
  const what = decision.kind === 'approved' ? 'The approval is' : 'The request for changes is';
  return `The review run on machine ${machine} ended before ${decisionWords(decision)} was applied: ${why}. ${what} not applied, and the ticket stays in review. It does not count as a failed attempt.`;
}

/**
 * The sentence of a counted failure's comment; with the stop it brings, it says so instead (owner's
 * answer 3, lot 3 step K).
 */
const COUNTED_SENTENCE = 'It counts as a failed attempt.';

/** A point of a request for changes as its `review` comment: `src/contact.ts:42 — <point>`. */
function pointText(point: ReviewDecision['points'][number]): string {
  if (point.file === null) return point.body;
  return `${point.file}${point.line === null ? '' : `:${String(point.line)}`} — ${point.body}`;
}
