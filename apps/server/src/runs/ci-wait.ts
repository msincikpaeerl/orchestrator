import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  CiRound,
  maskSecrets,
  type CiCheckFailure,
  type CiResult,
  type CiState,
} from '@orchestrator/protocol';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { retryAt, type GitHubRefusal } from '../github/answers.js';
import { listCommitRuns, readCommitStatus } from '../github/ci.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import { readPullRequest, type PullRequest } from '../github/pull-requests.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { resolveSettings } from '../settings/store.js';
import { ticketReference } from '../tickets/model.js';
import { ciChecks, ciChecksState } from './ci-result.js';
import { ciDeadlines, type RunRow } from './model.js';

// The wait for CI after an accepted submission (04, section 3.1; lot 3 steps G1a and G2b). The
// run keeps its session open and stays `running`; the server polls GitHub at **GitHub check
// interval** for the commit pushed at the submission, and decides: passed or "No CI found" accept
// the submission; a failure or a conflict is sent back to the agent as a CI round (the run
// service's `ciDecided`), unless the branch moved on GitHub and cancelled the runs; and **CI wait
// at submission** ends a wait without a result. A round the machine has not confirmed yet is sent
// again, the same message, after **Machine answer timeout** plus **Longest push**; GitHub is not
// read for it meanwhile. GitHub unreachable, its request limit or an answer that cannot be read
// never end a wait: only the deadline does. Everything the loop needs is stored on the run, so a
// restarted server goes on where it stopped.

/**
 * The wait begins (owner's point 1, step G1): at the submission when the ticket's pull request
 * is open, or when the pull request is opened or reopened. Writes `run.ci_waiting`.
 */
export async function startCiWait(
  tx: Executor,
  facts: {
    run: Pick<RunRow, 'id' | 'ciCommit'>;
    ticket: { id: string; projectId: string; number: number };
    projectKey: string;
    pullRequest: number | null;
    at: Date;
  },
): Promise<void> {
  const { run, ticket, at } = facts;
  if (run.ciCommit === null) return;
  await tx.update(schema.runs).set({ ciWaitStartedAt: at }).where(eq(schema.runs.id, run.id));
  await recordEvent(tx, {
    actor: 'system',
    entityType: 'run',
    entityId: run.id,
    projectId: ticket.projectId,
    type: 'run.ci_waiting',
    payload: {
      project: facts.projectKey,
      ticket: ticketReference(facts.projectKey, ticket.number),
      commit: run.ciCommit,
      pullRequest: facts.pullRequest,
    },
    at,
  });
}

/**
 * When the ticket's pull request is opened or updated: the wait of its active run waiting for
 * one begins, in the caller's transaction.
 */
export async function pullRequestReady(
  tx: Executor,
  ticket: { id: string; projectId: string; number: number },
  projectKey: string,
  pullRequest: number,
  at: Date,
): Promise<void> {
  const [run] = await tx
    .select({ id: schema.runs.id, ciCommit: schema.runs.ciCommit })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.ticketId, ticket.id),
        eq(schema.runs.status, 'running'),
        isNotNull(schema.runs.ciCommit),
        isNull(schema.runs.ciWaitStartedAt),
      ),
    )
    .for('update');
  if (!run) return;
  await startCiWait(tx, { run, ticket, projectKey, pullRequest, at });
}

/** What the run service does with what the loop found. */
export interface CiOutcomes {
  /** Keeps the result read, or the failed check, on the run, with their events. */
  recorded(
    runId: string,
    commit: string,
    found: { result: CiResult } | { failure: Omit<CiCheckFailure, 'since' | 'at'> },
  ): Promise<void>;
  /**
   * A result that decides: `passed` or `no_ci` accept the submission; `failed` or `conflict` is
   * a CI round, or ends the run when it is one too many; `branchMoved` (every failed check a
   * cancelled workflow run, the pull request's head another commit) ends it `ci_cancelled`.
   */
  decided(runId: string, commit: string, decided: CiDecision): Promise<void>;
  /** **CI wait at submission** reached without a result that decides. */
  timedOut(runId: string, commit: string, detail: string): Promise<void>;
  /** The run's unanswered CI round, sent again: the same message. */
  roundDue(runId: string): Promise<void>;
}

export interface CiDecision {
  result: CiResult & { state: 'passed' | 'no_ci' | 'failed' | 'conflict' };
  pullRequestHead: string | null;
  branchMoved?: boolean;
}

export interface CiWatcherOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  outcomes: CiOutcomes;
  /** One more attempt at the pull request of a ticket whose pull request is not opened. */
  retryPullRequest: (ticketId: string) => Promise<void>;
  /**
   * The ticket's pull requests watched on GitHub (lot 3 step J1): looked at before the CI waits
   * in each tick, so a ticket merged during a wait ends as merged; every read of a pull request
   * the CI wait makes is handed to `seen`. `check` returns when GitHub allows requests again
   * after its request limit, which holds the whole tick.
   */
  pullRequests?: {
    check(): Promise<Date | null>;
    seen(ticketId: string, pull: PullRequest): Promise<void>;
  };
  /** The clean-up after a merge (lot 3 step J2a), tried after the CI waits. */
  branchCleanUps?: { check(): Promise<Date | null> };
  now?: () => Date;
  /** False in tests: no tick starts by itself, the test calls `tick()`. */
  timers?: boolean;
}

/** One reading of a commit's CI on GitHub: its result, or why GitHub could not be read. */
export type CiRead =
  | {
      ok: true;
      result: CiResult;
      pullRequestHead: string | null;
      branchMoved: boolean;
      /** The pull request when this reading read it (lot 3 step J1). */
      pullRequest?: PullRequest;
      /**
       * No CI found, and the pull request closed on GitHub: not accepted, the wait goes on
       * (lot 3 step J3a).
       */
      pullRequestClosed?: true;
      /**
       * Passed on statuses alone, and not decided (lot 3 step J3b): GitHub had not said whether
       * the pull request conflicts, or it conflicts while it is closed.
       */
      statusesOnly?: CiStatusesOnly;
    }
  | { ok: false; failure: Omit<CiCheckFailure, 'since' | 'at'>; retryAt?: Date };

/** Why green statuses alone did not decide (lot 3 step J3b). */
export type CiStatusesOnly = 'mergeable_unknown' | 'conflict_closed';

/** A refusal of GitHub's as a failed check: its words masked, never a value of an answer. */
export function failureOf(refusal: GitHubRefusal): Omit<CiCheckFailure, 'since' | 'at'> {
  const base = { message: maskSecrets(refusal.message), fields: [], retryAt: null };
  switch (refusal.kind) {
    case 'token_invalid':
      return { ...base, reason: 'token' };
    case 'permission_missing':
      return { ...base, reason: 'permission_missing' };
    case 'rate_limited':
      return { ...base, reason: 'rate_limited' };
    case 'unreadable':
      return { ...base, reason: 'unreadable', fields: refusal.fields };
    default:
      return { ...base, reason: 'refused' };
  }
}

/**
 * A loop running `work` every `intervalMs()` milliseconds, the interval read again each time; a
 * tick never overlaps the previous one, and `pauseUntil` holds the next one back.
 */
export class PollLoop {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private closed = false;
  private resumeAt: number | null = null;

  constructor(
    private readonly options: {
      intervalMs: () => Promise<number>;
      work: () => Promise<void>;
      log: Pick<FastifyBaseLogger, 'error'>;
      now: () => number;
    },
  ) {}

  /** Starts with a tick at once. */
  start(): void {
    this.schedule(0);
  }

  /** The next tick waits at least until `at`. */
  pauseUntil(at: number): void {
    this.resumeAt = Math.max(this.resumeAt ?? 0, at);
  }

  /** One tick now, after the one in flight; never rejects. */
  tick(): Promise<void> {
    const previous = this.running ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.options.work();
      } catch (error) {
        this.options.log.error({ err: error }, 'CI check failed');
      }
    });
    this.running = next.finally(() => {
      if (this.running === next) this.running = null;
    });
    return next;
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.loop();
    }, delayMs);
  }

  private async loop(): Promise<void> {
    const now = this.options.now();
    if (this.resumeAt !== null && now < this.resumeAt) {
      this.schedule(this.resumeAt - now);
      return;
    }
    this.resumeAt = null;
    // A tick still running (a slow GitHub) is not doubled: the next one waits for it.
    await this.tick();
    let interval = 60_000;
    try {
      interval = await this.options.intervalMs();
    } catch (error) {
      this.options.log.error({ err: error }, 'GitHub check interval not read');
    }
    this.schedule(interval);
  }

  /** Stops the loop; resolves once the tick in flight is over. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

export class CiWatcher {
  private readonly loop: PollLoop;

  /** What the loop's findings do; also for a test delivering a late result (lot 3 step G2b). */
  get outcomes(): CiOutcomes {
    return this.options.outcomes;
  }

  constructor(private readonly options: CiWatcherOptions) {
    this.loop = new PollLoop({
      intervalMs: async () =>
        (await resolveSettings(options.db, ['githubPollSeconds'])).githubPollSeconds * 1000,
      work: () => this.checkAll(),
      log: options.log,
      now: () => this.now().getTime(),
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** At server start: the first tick at once, then every **GitHub check interval**. */
  start(): void {
    if (this.options.timers !== false) this.loop.start();
  }

  /** One check of every waiting run, after the tick in flight. */
  tick(): Promise<void> {
    return this.loop.tick();
  }

  close(): Promise<void> {
    return this.loop.close();
  }

  /**
   * One reading of `commit` for the owner's **Check CI again** (lot 3 step G2c): with nothing on
   * GitHub, the pull request's `mergeable` decides between "No CI found" and a conflict only once
   * **Wait for CI to start** is over (`startWaitOver`); before, it is not finished.
   */
  readCommit(
    repo: { owner: string; name: string },
    commit: string,
    pullRequest: number,
    startWaitOver: boolean,
  ): Promise<CiRead> {
    return this.check(repo, commit, pullRequest, startWaitOver);
  }

  /**
   * The watched pull requests first (merges before the CI waits, owner's answer 1, lot 3 step
   * J1), then every run waiting for CI, one after another, then the clean-ups after a merge
   * (step J2a); the request limit stops the tick.
   */
  private async checkAll(): Promise<void> {
    let limited: Date | null = null;
    try {
      limited = (await this.options.pullRequests?.check()) ?? null;
    } catch (error) {
      // An error in the merge check never stops the CI waits (owner's correction, step J1).
      this.options.log.error({ err: error }, 'pull requests not checked');
    }
    if (limited !== null) {
      this.loop.pauseUntil(limited.getTime());
      return;
    }
    const waiting = await this.options.db
      .select({
        run: schema.runs,
        ticket: schema.tickets,
        project: schema.projects,
      })
      .from(schema.runs)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(
        or(
          and(eq(schema.runs.status, 'running'), isNotNull(schema.runs.ciCommit)),
          // A round not confirmed yet: the session may be starting again with `run.resume`.
          and(
            inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
            isNotNull(schema.runs.ciRoundMessageId),
          ),
        ),
      )
      .orderBy(schema.runs.createdAt);
    for (const row of waiting) {
      let until: Date | null;
      try {
        until = await this.checkRun(row);
      } catch (error) {
        // One run that cannot be checked never stops the runs after it.
        this.options.log.error(
          {
            err: error,
            run: row.run.id,
            ticket: ticketReference(row.project.key, row.ticket.number),
          },
          'CI check of a run failed',
        );
        continue;
      }
      if (until !== null) {
        this.loop.pauseUntil(until.getTime());
        return;
      }
    }
    let cleanUpUntil: Date | null = null;
    try {
      cleanUpUntil = (await this.options.branchCleanUps?.check()) ?? null;
    } catch (error) {
      this.options.log.error({ err: error }, 'branch clean-ups not tried');
    }
    if (cleanUpUntil !== null) this.loop.pauseUntil(cleanUpUntil.getTime());
  }

  /** One waiting run; returns when GitHub allows requests again after its request limit. */
  private async checkRun(row: {
    run: RunRow;
    ticket: typeof schema.tickets.$inferSelect;
    project: typeof schema.projects.$inferSelect;
  }): Promise<Date | null> {
    const { run, ticket, project } = row;
    const commit = run.ciCommit;
    const deadlines = ciDeadlines(run);
    if (commit === null || deadlines === null) return null;
    const now = this.now();
    const { outcomes } = this.options;
    if (run.ciRoundMessageId !== null) {
      // An unanswered round: nothing is read on GitHub until the machine answered it.
      if (now >= deadlines.deadline) {
        await outcomes.timedOut(run.id, commit, 'CI round not confirmed');
        return null;
      }
      const pending = z.array(CiRound).parse(run.ciRounds).at(-1);
      const { dispatchAckTimeoutSeconds, pushTimeoutSeconds } = await resolveSettings(
        this.options.db,
        ['dispatchAckTimeoutSeconds', 'pushTimeoutSeconds'],
      );
      const waitMs = (dispatchAckTimeoutSeconds + pushTimeoutSeconds) * 1000;
      if (
        pending?.sentAt === null ||
        pending === undefined ||
        now.getTime() - new Date(pending.sentAt).getTime() >= waitMs
      ) {
        await outcomes.roundDue(run.id);
      }
      return null;
    }
    if (run.ciWaitStartedAt === null) {
      if (now >= deadlines.deadline) {
        await outcomes.timedOut(run.id, commit, 'the pull request could not be opened');
        return null;
      }
      // The loop tries again the pull requests not opened (lot 3 plan, step G1).
      await this.options.retryPullRequest(ticket.id);
      return null;
    }
    const check = await this.check(
      { owner: project.repoOwner, name: project.repoName },
      commit,
      ticket.pullRequestNumber,
      now >= (deadlines.startDeadline ?? now),
    );
    if (!check.ok) {
      await outcomes.recorded(run.id, commit, { failure: check.failure });
      if (now >= deadlines.deadline) {
        await outcomes.timedOut(
          run.id,
          commit,
          `GitHub could not be checked: ${check.failure.message}`,
        );
      }
      return check.retryAt ?? null;
    }
    // Every read of the pull request refreshes the ticket's, and may find it merged: the run is
    // then stopped, and the result below decides nothing for it.
    if (check.pullRequest) {
      try {
        await this.options.pullRequests?.seen(ticket.id, check.pullRequest);
      } catch (error) {
        // The merge check's error never stops this run's CI decision.
        this.options.log.error(
          { err: error, ticket: ticketReference(project.key, ticket.number) },
          'pull request read by the CI wait not handled',
        );
      }
    }
    const { result } = check;
    if (
      result.state === 'passed' ||
      result.state === 'no_ci' ||
      result.state === 'failed' ||
      result.state === 'conflict'
    ) {
      // The run service weighs the deadline: only an accepting result wins over it.
      await outcomes.decided(run.id, commit, {
        result: { ...result, state: result.state },
        pullRequestHead: check.pullRequestHead,
        ...(check.branchMoved ? { branchMoved: true } : {}),
      });
      return null;
    }
    await outcomes.recorded(run.id, commit, { result });
    if (now >= deadlines.deadline) {
      await outcomes.timedOut(
        run.id,
        commit,
        check.pullRequestClosed && ticket.pullRequestNumber !== null
          ? `no CI run or status appeared, and pull request #${String(ticket.pullRequestNumber)} is closed on GitHub`
          : check.statusesOnly !== undefined && ticket.pullRequestNumber !== null
            ? statusesOnlyDetail(check.statusesOnly, ticket.pullRequestNumber, run.baseBranch)
            : result.checks.length === 0
              ? 'no CI run or status appeared yet'
              : 'CI had not finished',
      );
    }
    return null;
  }

  /** Reads the CI result of `commit` (2 requests), and the pull request when it is needed. */
  private async check(
    repo: { owner: string; name: string },
    commit: string,
    pullRequest: number | null,
    startWaitOver: boolean,
  ): Promise<CiRead & { retryAt?: Date }> {
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient({ ...this.options, log: this.options.log });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return {
        ok: false,
        failure: {
          reason: 'token',
          message:
            'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
          fields: [],
          retryAt: null,
        },
      };
    }
    if (client === null) {
      return {
        ok: false,
        failure: {
          reason: 'token',
          message: 'No GitHub token is saved: connect GitHub in Settings',
          fields: [],
          retryAt: null,
        },
      };
    }
    try {
      return await this.read(client, repo, commit, pullRequest, startWaitOver);
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return {
        ok: false,
        failure: {
          reason: 'unreachable',
          message: 'GitHub could not be reached, or answered with a server error',
          fields: [],
          retryAt: null,
        },
      };
    }
  }

  private async read(
    client: GitHubClient,
    repo: { owner: string; name: string },
    commit: string,
    pullRequest: number | null,
    startWaitOver: boolean,
  ): Promise<CiRead & { retryAt?: Date }> {
    const refused = (refusal: GitHubRefusal): CiRead & { retryAt?: Date } => {
      const at = retryAt(refusal, this.now());
      return {
        ok: false,
        failure: { ...failureOf(refusal), retryAt: at?.toISOString() ?? null },
        ...(at === null ? {} : { retryAt: at }),
      };
    };
    const runs = await listCommitRuns(client, repo, commit);
    if (!runs.ok) return refused(runs.refusal);
    const status = await readCommitStatus(client, repo, commit);
    if (!status.ok) return refused(status.refusal);
    if (status.value.sha !== commit) {
      // Asked by its hash: another commit's statuses would not be this submission's result.
      const fields = ['sha: expected the submitted commit, received another commit'];
      client.unreadable(
        { method: 'GET', path: `/repos/${repo.owner}/${repo.name}/commits/<commit>/status` },
        200,
        fields,
      );
      return {
        ok: false,
        failure: {
          reason: 'unreadable',
          message: `GitHub's answer does not fit what the Orchestrator reads: ${fields.join('; ')}`,
          fields,
          retryAt: null,
        },
      };
    }
    const checks = ciChecks(commit, runs.value, status.value);
    const state = ciChecksState(checks);
    let decided: CiState;
    let pullRequestHead: string | null = null;
    let pullRequestClosed = false;
    let statusesOnly: CiStatusesOnly | undefined;
    let pullRead: PullRequest | undefined;
    const readPull = async (number: number) => {
      const read = await readPullRequest(client, repo, number);
      if (read.ok) pullRead = read.value;
      return read;
    };
    const head = async (): Promise<void> => {
      if (pullRequest === null) return;
      // Only to say so in the result's event: never part of the result (owner's answer 2).
      const read = await readPull(pullRequest);
      if (read.ok && read.value.headSha !== commit) pullRequestHead = read.value.headSha;
    };
    if (state === 'none') {
      if (!startWaitOver || pullRequest === null) {
        decided = 'pending';
      } else {
        // GitHub starts no `pull_request` run on a conflict (A18): read it before "No CI found".
        const read = await readPull(pullRequest);
        if (!read.ok) return refused(read.refusal);
        if (read.value.headSha !== commit) pullRequestHead = read.value.headSha;
        // Null while GitHub computes it (A5): read again at the next check. While the pull
        // request is closed, "No CI found" never accepts the work (owner's addition, lot 3 step
        // J3a): GitHub starts no CI for it, and the wait ends at **CI wait at submission**.
        // A conflict decides nothing either while it is closed (lot 3 step J3b): no round can
        // make it mergeable while nothing can be merged.
        pullRequestClosed = read.value.state === 'closed' && !read.value.merged;
        decided =
          read.value.mergeable === null || pullRequestClosed
            ? 'pending'
            : read.value.mergeable
              ? 'no_ci'
              : 'conflict';
      }
    } else if (
      state === 'passed' &&
      pullRequest !== null &&
      !checks.some((check) => check.kind === 'workflow_run')
    ) {
      // Passed on statuses alone (another service's): GitHub starts no `pull_request` run on a
      // conflict (A18), so the pull request's `mergeable` decides (owner's answer 6 of step J,
      // lot 3 step J3b). False: a conflict, a CI round; null or a failed read: nothing decided
      // until the next check; while the pull request is closed, a conflict decides nothing.
      const read = await readPull(pullRequest);
      if (!read.ok) return refused(read.refusal);
      if (read.value.headSha !== commit) pullRequestHead = read.value.headSha;
      const closed = read.value.state === 'closed' && !read.value.merged;
      if (read.value.mergeable === null) {
        decided = 'pending';
        statusesOnly = 'mergeable_unknown';
      } else if (!read.value.mergeable) {
        decided = closed ? 'pending' : 'conflict';
        if (closed) statusesOnly = 'conflict_closed';
      } else {
        decided = 'passed';
      }
    } else {
      decided = state;
      const failed = checks.filter((check) => check.state === 'failed');
      if (
        state === 'failed' &&
        pullRequest !== null &&
        failed.every((check) => check.kind === 'workflow_run' && check.cancelled)
      ) {
        // Cancelled runs: the agent's failure, or the branch moving on GitHub (a workflow
        // cancelling the run in progress)? Only the pull request's head tells; while it cannot
        // be read, nothing is decided (owner's answer 4, lot 3 step G2b).
        const read = await readPull(pullRequest);
        if (!read.ok) return refused(read.refusal);
        if (read.value.headSha !== commit) pullRequestHead = read.value.headSha;
        return {
          ok: true,
          result: { state, checks, failed_jobs: [], jobs_read: false, jobs_problem: null },
          pullRequestHead,
          branchMoved: pullRequestHead !== null,
          pullRequest: read.value,
        };
      }
      if (state !== 'pending') await head().catch(() => undefined);
    }
    return {
      ok: true,
      result: { state: decided, checks, failed_jobs: [], jobs_read: false, jobs_problem: null },
      pullRequestHead,
      branchMoved: false,
      ...(pullRequestClosed ? { pullRequestClosed: true as const } : {}),
      ...(statusesOnly === undefined ? {} : { statusesOnly }),
      ...(pullRead === undefined ? {} : { pullRequest: pullRead }),
    };
  }
}

/** The `ci_timeout` detail when green statuses alone did not decide (lot 3 step J3b). */
function statusesOnlyDetail(why: CiStatusesOnly, pullRequest: number, base: string): string {
  return why === 'conflict_closed'
    ? `only statuses from other services passed, and pull request #${String(pullRequest)} conflicts with ${base} while it is closed on GitHub`
    : `only statuses from other services passed, and GitHub had not said whether pull request #${String(pullRequest)} conflicts with ${base}`;
}
