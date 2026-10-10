import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  CiAcceptedLater,
  CiRound,
  CiCheckFailure,
  CiResult,
  MCP_OUTPUT_MAX_CHARACTERS,
  SETTINGS,
  SubmissionRecord,
  maskSecrets,
  type CiExcerpt,
  type CiFailedJob,
  type CiReadProblem,
  type McpCiStatus,
} from '@orchestrator/protocol';
import { and, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { Templates } from '../agents/files.js';
import { fill, part } from '../agents/messages.js';
import type { Database } from '../database.js';
import type { GitHubRefusal, GitHubResult } from '../github/answers.js';
import {
  isFailedStep,
  listCommitRuns,
  listRunJobs,
  readCommitStatus,
  readFailedStepLogs,
  type WorkflowJob,
} from '../github/ci.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import type { ProjectRow } from '../projects/model.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { resolveSettings } from '../settings/store.js';
import type { TicketRow } from '../tickets/model.js';
import { jsonLength } from '../mcp/output.js';
import { ciChecks, ciChecksState, failedChecks } from './ci-result.js';
import type { RunRow } from './model.js';

// `ci_status` (06, section 4.1; owner's answers, lot 3 step G1b): the CI result of one accepted
// submission's commit of the run's ticket, named, never the branch, the pull request's head or a
// refused submission's commit. It only reads: the wait for CI decides (ci-wait.ts).
//
// What it costs on GitHub: during the wait nothing for the result (the wait's stored result);
// otherwise a commit is read at most once per **GitHub check interval** (2 requests), calls at the
// same moment sharing one read, the result stored on the run that handed it in. A finished result
// is never read again; the failed jobs are listed once (1 request per failed workflow run) and each
// job's log read once (1 request and a download of at most **Longest CI log read**), except after
// GitHub was unreachable or limited, then again after the interval. Nothing is asked while GitHub's
// request limit holds.

/** The smallest excerpt worth reading a log for: **Longest CI log excerpt**'s minimum. */
const EXCERPT_MIN_CHARACTERS = SETTINGS.ciLogExcerptMaxLength.min;

/** Characters of the answer kept for everything but the excerpts: checks, names, sentences. */
const ANSWER_ROOM = 10_000;

/** Failed steps whose log can be read: each excerpt still gets at least the minimum. */
export const CI_EXCERPTS_MAX = Math.floor(
  (MCP_OUTPUT_MAX_CHARACTERS - ANSWER_ROOM) / EXCERPT_MIN_CHARACTERS,
);

/**
 * How many failed jobs, in GitHub's order, get their log read: job by job while every failed step
 * (one for a job naming none) can still get at least the minimum excerpt; the first always does
 * (owner's answer 3, step G1b).
 */
export function jobsWithLogs(failedSteps: number[], max = CI_EXCERPTS_MAX): number {
  let used = 0;
  for (const [index, count] of failedSteps.entries()) {
    const needed = Math.max(1, count);
    if (index > 0 && used + needed > max) return index;
    used += needed;
  }
  return failedSteps.length;
}

const FINISHED = new Set(['passed', 'failed', 'no_ci']);
const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);

export interface CiStatusOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  now: () => Date;
  templates: () => Promise<Templates>;
}

/** Thrown inside a read: GitHub could not be asked or answered with a refusal. */
class ReadStopped extends Error {
  constructor(readonly problem: Omit<CiReadProblem, 'at'>) {
    super(problem.message);
  }
}

function problemOf(refusal: GitHubRefusal, now: Date): Omit<CiReadProblem, 'at'> {
  const message = maskSecrets(refusal.message);
  switch (refusal.kind) {
    case 'rate_limited': {
      const retry =
        refusal.retry === null
          ? null
          : 'afterSeconds' in refusal.retry
            ? new Date(now.getTime() + refusal.retry.afterSeconds * 1000)
            : new Date(refusal.retry.resetAtSeconds * 1000);
      return { reason: 'rate_limited', message, retry_at: retry?.toISOString() ?? null };
    }
    case 'permission_missing':
      return { reason: 'permission_missing', message, retry_at: null };
    case 'unreadable':
      return {
        reason: 'unreadable',
        message: `GitHub's answer does not fit what the Orchestrator reads: ${refusal.fields.join('; ')}`,
        retry_at: null,
      };
    default:
      return { reason: 'refused', message, retry_at: null };
  }
}

/**
 * GitHub's request limit without a time (no `retry-after`, no `x-ratelimit-reset`) holds for the
 * longer of one minute, what GitHub's documentation asks before trying again, and **GitHub check
 * interval**: a stated time, said to the agent (owner's addition, lot 3 step G2b).
 */
export const LIMIT_WITHOUT_TIME_MIN_MS = 60_000;

function withLimitTime<T extends Omit<CiReadProblem, 'at'>>(
  problem: T,
  now: Date,
  githubPollSeconds: number,
): T {
  if (problem.reason !== 'rate_limited' || problem.retry_at !== null) return problem;
  const holdMs = Math.max(LIMIT_WITHOUT_TIME_MIN_MS, githubPollSeconds * 1000);
  return { ...problem, retry_at: new Date(now.getTime() + holdMs).toISOString() };
}

/** The run whose result answers, and the CI round it comes from when it does. */
interface Source {
  row: RunRow;
  round: { index: number; messageId: string; round: number } | null;
}

/**
 * The run as its latest confirmed CI round left it: the round's commit and the result it sent,
 * read when the round was decided; null without a round, or once the agent handed in again.
 */
function latestRound(run: RunRow): Source | null {
  if (run.ciCommit !== null || run.submission === null) return null;
  const rounds = z.array(CiRound).parse(run.ciRounds);
  const index = rounds.findLastIndex((each) => each.confirmedAt !== null);
  const round = rounds[index];
  if (round === undefined) return null;
  return {
    row: {
      ...run,
      ciCommit: round.commit,
      ciResult: round.result,
      ciCheckedAt: new Date(round.readAt),
      ciWaitStartedAt: new Date(round.decidedAt),
    },
    round: { index, messageId: round.messageId, round: round.round },
  };
}

/**
 * Whether a failed result misses something GitHub may still give, due now: its failed jobs not
 * listed, or a log not read for a passing reason, once one **GitHub check interval** passed since.
 */
function jobsDue(result: CiResult | null, now: Date, intervalMs: number): boolean {
  const due = (at: string) => now.getTime() - new Date(at).getTime() >= intervalMs;
  if (result?.state !== 'failed') return false;
  if (!result.jobs_read) return result.jobs_problem === null || due(result.jobs_problem.at);
  return result.failed_jobs.some(
    (job) => job.log.state === 'unavailable' && passing(job.log.problem) && due(job.log.problem.at),
  );
}

/** The key of a round's reads, apart from its run's own wait. */
function roundKey(runId: string, messageId: string): string {
  return `${runId}:round:${messageId}`;
}

/** A problem after which GitHub is asked again, once the interval or the limit is over. */
function passing(problem: CiReadProblem | null): boolean {
  return (
    problem !== null && (problem.reason === 'unreachable' || problem.reason === 'rate_limited')
  );
}

function ok<T>(result: GitHubResult<T>, now: Date): T {
  if (!result.ok) throw new ReadStopped(problemOf(result.refusal, now));
  return result.value;
}

export class CiStatusReader {
  /** Reads in flight, by the run holding the commit: calls at the same moment share one. */
  private readonly reads = new Map<string, Promise<void>>();
  /** GitHub's request limit, as a read of `ci_status` met it. */
  private limitedUntil: Date | null = null;
  /**
   * The latest failed read of a run's result, by run: not tried again before one **GitHub check
   * interval** (owner's addition, lot 3 step G2b), its problem said meanwhile.
   */
  private readonly failedReads = new Map<string, CiReadProblem>();

  constructor(private readonly options: CiStatusOptions) {}

  private now(): Date {
    return this.options.now();
  }

  /** The answer to a `ci_status` call of `run`. */
  async answer(call: {
    run: RunRow;
    ticket: TicketRow;
    project: ProjectRow;
  }): Promise<McpCiStatus> {
    const templates = await this.options.templates();
    const t = templates['ci-status'];
    const notes: string[] = [];
    const refused = call.run.refusedSubmission !== null && call.run.ciCommit === null;
    // After a CI round, before the agent hands in again: the result the round sent, as kept on
    // the run (owner's addition 2 of step G2b); only what it could not read then is read again.
    const found = await this.source(call.run, call.ticket.id);
    if (found === null) {
      if (refused) notes.push(part(t, 'refused'));
      notes.push(part(t, 'no-submission'));
      return { commit: null, pull_request: null, read_at: null, note: notes.join(' '), ci: null };
    }
    const { round } = found;
    let source = found.row;
    const settings = await resolveSettings(this.options.db, [
      'githubPollSeconds',
      'ciLogExcerptMaxLength',
      'ciLogReadMaxMegabytes',
    ]);
    const commit = source.ciCommit ?? '';
    const submitted = SubmissionRecord.parse(source.submission).at;
    const byThisRun = source.id === call.run.id;
    notes.push(
      byThisRun
        ? fill(t, t.main, { commit, submitted })
        : part(t, 'earlier-run', { commit, submitted, attempt: String(source.attempt) }),
    );
    if (refused) notes.push(part(t, 'refused'));
    const pullRequest =
      call.ticket.pullRequestNumber !== null &&
      call.ticket.pullRequestUrl !== null &&
      call.ticket.pullRequestHead !== null
        ? {
            number: call.ticket.pullRequestNumber,
            url: call.ticket.pullRequestUrl,
            head: call.ticket.pullRequestHead,
          }
        : null;
    const answer = {
      commit: {
        hash: commit,
        by: byThisRun ? ('this_run' as const) : ('earlier_run' as const),
        attempt: source.attempt,
        submitted_at: submitted,
      },
      pull_request: pullRequest,
    };
    if (pullRequest !== null && pullRequest.head !== commit) {
      notes.push(part(t, 'head-moved', { head: pullRequest.head }));
    }
    // Work the owner's **Check CI again** accepted after the run ended: what it found, never the
    // result read before it (owner's review of step H1). A finished result is not read again.
    if (round === null && source.ciAcceptedLater !== null) {
      const later = CiAcceptedLater.parse(source.ciAcceptedLater);
      notes.push(
        part(t, later.state === 'passed' ? 'accepted-later' : 'accepted-later-no-ci', {
          at: later.at,
        }),
      );
      const before = source.ciResult === null ? null : CiResult.parse(source.ciResult);
      if (before?.state === 'failed') {
        notes.push(part(t, 'before-again', { checks: failedChecks(before) }));
      }
      const accepted: CiResult = {
        state: later.state,
        checks: [],
        failed_jobs: [],
        jobs_read: false,
        jobs_problem: null,
      };
      return {
        ...answer,
        read_at: later.at,
        note: notes.join(' '),
        ci: ciOutput(t, accepted, settings),
      };
    }
    const waiting = ACTIVE.has(source.status);
    if (pullRequest === null || (waiting && source.ciWaitStartedAt === null)) {
      notes.push(part(t, 'no-pull-request'));
      return { ...answer, read_at: null, note: notes.join(' '), ci: null };
    }

    // A round asks GitHub only for what it misses (owner's review, step G2b).
    const asks =
      round === null ||
      jobsDue(CiResult.parse(source.ciResult), this.now(), settings.githubPollSeconds * 1000) ||
      this.failedReads.has(roundKey(source.id, round.messageId));
    const held = asks ? await this.heldUntil() : null;
    let problem: CiReadProblem | null = null;
    if (held === null && round === null) {
      problem = await this.refresh(source, call.project, waiting, settings);
    } else if (held === null && asks && round !== null) {
      problem = await this.refreshRound(source, round, call.project, settings);
    }
    if (round === null) source = (await this.run(source.id)) ?? source;
    else {
      const reread = await this.run(source.id);
      const kept =
        reread === undefined ? null : z.array(CiRound).parse(reread.ciRounds)[round.index];
      if (kept?.messageId === round.messageId) source = { ...source, ciResult: kept.result };
    }
    const result = source.ciResult === null ? null : CiResult.parse(source.ciResult);
    const readAt = source.ciCheckedAt?.toISOString() ?? null;

    notes.push(readAt === null ? part(t, 'not-read-yet') : part(t, 'read-at', { at: readAt }));
    if (round !== null) {
      const said = byThisRun ? 'round' : 'round-earlier-run';
      notes.push(part(t, said, { round: String(round.round) }));
    } else if (result !== null && FINISHED.has(result.state)) notes.push(part(t, 'finished'));
    else notes.push(part(t, 'not-finished', { seconds: String(settings.githubPollSeconds) }));
    if (held !== null) {
      notes.push(part(t, 'limited', { at: held.toISOString() }));
    } else if (problem !== null) {
      notes.push(part(t, 'read-failed', { problem: problem.message }));
    }
    if (result === null) return { ...answer, read_at: readAt, note: notes.join(' '), ci: null };

    switch (result.state) {
      case 'pending':
        if (result.checks.length === 0) notes.push(part(t, 'nothing-yet'));
        break;
      case 'conflict':
        notes.push(part(t, 'conflict', { base: call.project.defaultBranch ?? 'its base branch' }));
        break;
      case 'no_ci':
        notes.push(part(t, 'no-ci'));
        break;
      case 'passed':
        notes.push(part(t, 'passed'));
        break;
      case 'failed':
        notes.push(part(t, 'failed'));
        if (result.jobs_problem !== null) {
          notes.push(part(t, 'jobs-problem', { problem: this.problemText(result.jobs_problem) }));
        }
        break;
    }
    const ci = ciOutput(t, result, settings);
    if (ci.logs_not_read.count > 0) {
      notes.push(part(t, 'logs-not-read', { count: String(ci.logs_not_read.count) }));
    }
    return fitAnswer(t, { ...answer, read_at: readAt, note: notes.join(' '), ci });
  }

  /**
   * A failed result with its failed jobs and their excerpts, for a CI round's message (lot 3 step
   * G2b): what the run already holds for `commit` when its jobs were listed, else read now
   * (1 request per failed workflow run, 1 per failed job's log). A problem reading them is kept in
   * the result (`jobs_problem`, or the job's log `unavailable`): the message says it.
   */
  async withFailedJobs(
    run: RunRow,
    project: ProjectRow,
    commit: string,
    result: CiResult,
  ): Promise<CiResult> {
    if (result.state !== 'failed') return result;
    const stored =
      run.ciCommit === commit && run.ciResult !== null ? CiResult.parse(run.ciResult) : null;
    if (stored?.state === 'failed' && stored.jobs_read) {
      return { ...result, failed_jobs: stored.failed_jobs, jobs_read: true, jobs_problem: null };
    }
    const settings = await resolveSettings(this.options.db, [
      'githubPollSeconds',
      'ciLogExcerptMaxLength',
      'ciLogReadMaxMegabytes',
    ]);
    const now = this.now();
    const repo = { owner: project.repoOwner, name: project.repoName };
    let read: CiResult = result;
    try {
      const client = await this.client();
      await this.withClient(async () => {
        read = await this.readJobs(client, repo, result, settings, now);
      });
    } catch (error) {
      if (!(error instanceof ReadStopped)) throw error;
      const problem = {
        ...withLimitTime(error.problem, now, settings.githubPollSeconds),
        at: now.toISOString(),
      };
      return { ...result, jobs_problem: problem };
    }
    return read;
  }

  private problemText(problem: CiReadProblem): string {
    return problem.message === '' ? problem.reason : problem.message;
  }

  /**
   * The run whose accepted submission answers: this run's wait, else its latest confirmed CI
   * round; else the ticket's latest run holding either, its wait first (owner's review, step G2b).
   */
  private async source(run: RunRow, ticketId: string): Promise<Source | null> {
    if (run.ciCommit !== null && run.submission !== null) return { row: run, round: null };
    const own = latestRound(run);
    if (own !== null) return own;
    const [latest] = await this.options.db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.ticketId, ticketId),
          isNotNull(schema.runs.submission),
          or(
            isNotNull(schema.runs.ciCommit),
            sql`jsonb_path_exists(${schema.runs.ciRounds}, '$[*] ? (@.confirmedAt != null)')`,
          ),
        ),
      )
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);
    if (latest === undefined) return null;
    return latest.ciCommit !== null ? { row: latest, round: null } : latestRound(latest);
  }

  private async run(id: string): Promise<RunRow | undefined> {
    const [row] = await this.options.db.select().from(schema.runs).where(eq(schema.runs.id, id));
    return row;
  }

  /**
   * When GitHub allows requests again, while its request limit holds: as the wait for CI met it
   * on a waiting run, or as `ci_status` met it (a limit without a time held for a stated time).
   */
  private async heldUntil(): Promise<Date | null> {
    const now = this.now();
    const failures = await this.options.db
      .select({ failure: schema.runs.ciCheckFailure })
      .from(schema.runs)
      .where(
        and(
          isNotNull(schema.runs.ciCommit),
          sql`${schema.runs.ciCheckFailure} ->> 'reason' = 'rate_limited'`,
        ),
      );
    let until = this.limitedUntil !== null && this.limitedUntil > now ? this.limitedUntil : null;
    for (const { failure } of failures) {
      const parsed = CiCheckFailure.safeParse(failure);
      if (!parsed.success || parsed.data.retryAt === null) continue;
      const at = new Date(parsed.data.retryAt);
      if (at > now && (until === null || at > until)) until = at;
    }
    return until;
  }

  /** Reads what is due for `run`'s commit, sharing a read in flight; the problem met, if any. */
  private async refresh(
    run: RunRow,
    project: ProjectRow,
    waiting: boolean,
    settings: {
      githubPollSeconds: number;
      ciLogExcerptMaxLength: number;
      ciLogReadMaxMegabytes: number;
    },
  ): Promise<CiReadProblem | null> {
    let problem: CiReadProblem | null = null;
    const inFlight = this.reads.get(run.id);
    if (inFlight) {
      await inFlight;
      return null;
    }
    const failed = this.failedReads.get(run.id);
    if (
      failed !== undefined &&
      this.now().getTime() - new Date(failed.at).getTime() < settings.githubPollSeconds * 1000
    ) {
      return failed;
    }
    this.failedReads.delete(run.id);
    const read = (async () => {
      try {
        await this.read(run, project, waiting, settings);
      } catch (error) {
        if (error instanceof ReadStopped) {
          const now = this.now();
          problem = {
            ...withLimitTime(error.problem, now, settings.githubPollSeconds),
            at: now.toISOString(),
          };
          if (problem.retry_at !== null && problem.reason === 'rate_limited') {
            this.limitedUntil = new Date(problem.retry_at);
          }
          this.failedReads.set(run.id, problem);
          return;
        }
        throw error;
      }
    })();
    this.reads.set(run.id, read);
    try {
      await read;
    } finally {
      this.reads.delete(run.id);
    }
    return problem;
  }

  /**
   * Reads again what a CI round's failed result misses (its failed jobs, or a log GitHub could not
   * give for a passing reason), at most once per **GitHub check interval**, sharing a read in
   * flight, and keeps it on that round (owner's review, step G2b); the problem met, if any.
   */
  private async refreshRound(
    row: RunRow,
    round: NonNullable<Source['round']>,
    project: ProjectRow,
    settings: {
      githubPollSeconds: number;
      ciLogExcerptMaxLength: number;
      ciLogReadMaxMegabytes: number;
    },
  ): Promise<CiReadProblem | null> {
    const key = roundKey(row.id, round.messageId);
    const inFlight = this.reads.get(key);
    if (inFlight) {
      await inFlight;
      return null;
    }
    const failed = this.failedReads.get(key);
    if (
      failed !== undefined &&
      this.now().getTime() - new Date(failed.at).getTime() < settings.githubPollSeconds * 1000
    ) {
      return failed;
    }
    this.failedReads.delete(key);
    const result = CiResult.parse(row.ciResult);
    if (!jobsDue(result, this.now(), settings.githubPollSeconds * 1000)) return null;
    let problem: CiReadProblem | null = null;
    const read = (async () => {
      const now = this.now();
      const repo = { owner: project.repoOwner, name: project.repoName };
      try {
        const client = await this.client();
        await this.withClient(async () => {
          let after: CiResult;
          try {
            after = await this.readJobs(client, repo, result, settings, now);
          } catch (error) {
            if (!(error instanceof ReadStopped) || result.jobs_read) throw error;
            const stopped = { ...error.problem, at: now.toISOString() };
            await this.storeRound(row.id, round, { ...result, jobs_problem: stopped });
            throw error;
          }
          await this.storeRound(row.id, round, after);
        });
      } catch (error) {
        if (!(error instanceof ReadStopped)) throw error;
        problem = {
          ...withLimitTime(error.problem, now, settings.githubPollSeconds),
          at: now.toISOString(),
        };
        if (problem.retry_at !== null && problem.reason === 'rate_limited') {
          this.limitedUntil = new Date(problem.retry_at);
        }
        this.failedReads.set(key, problem);
      }
    })();
    this.reads.set(key, read);
    try {
      await read;
    } finally {
      this.reads.delete(key);
    }
    return problem;
  }

  /** Keeps `result` on the run's round, when the run still holds that round where it was. */
  private async storeRound(
    runId: string,
    round: NonNullable<Source['round']>,
    result: CiResult,
  ): Promise<void> {
    const at = String(round.index);
    await this.options.db
      .update(schema.runs)
      .set({
        ciRounds: sql`jsonb_set(${schema.runs.ciRounds}, ARRAY[${at}, 'result'], ${JSON.stringify(result)}::jsonb)`,
      })
      .where(
        and(
          eq(schema.runs.id, runId),
          sql`${schema.runs.ciRounds} -> ${round.index}::int ->> 'messageId' = ${round.messageId}`,
        ),
      );
  }

  private async read(
    run: RunRow,
    project: ProjectRow,
    waiting: boolean,
    settings: {
      githubPollSeconds: number;
      ciLogExcerptMaxLength: number;
      ciLogReadMaxMegabytes: number;
    },
  ): Promise<void> {
    const commit = run.ciCommit;
    if (commit === null) return;
    const now = this.now();
    const intervalMs = settings.githubPollSeconds * 1000;
    let result = run.ciResult === null ? null : CiResult.parse(run.ciResult);
    let checkedAt = run.ciCheckedAt;
    const repo = { owner: project.repoOwner, name: project.repoName };
    const due = (at: string | Date | null) =>
      at === null || now.getTime() - new Date(at).getTime() >= intervalMs;

    // The result: during the wait, the wait's own; a finished one is never read again.
    const readResult =
      !waiting && (result === null || !FINISHED.has(result.state)) && due(checkedAt);
    const readJobs = (candidate: CiResult | null) => jobsDue(candidate, now, intervalMs);
    if (!readResult && !readJobs(result)) return;

    const client = await this.client();
    await this.withClient(async () => {
      if (readResult) {
        const runs = ok(await listCommitRuns(client, repo, commit), now);
        const status = ok(await readCommitStatus(client, repo, commit), now);
        if (status.sha !== commit) {
          throw new ReadStopped({
            reason: 'unreadable',
            message:
              "GitHub's answer does not fit what the Orchestrator reads: sha: expected the submitted commit, received another commit",
            retry_at: null,
          });
        }
        const checks = ciChecks(commit, runs, status);
        const state = ciChecksState(checks);
        result = {
          state: state === 'none' ? (result?.state === 'conflict' ? 'conflict' : 'pending') : state,
          checks,
          failed_jobs: [],
          jobs_read: false,
          jobs_problem: null,
        };
        checkedAt = now;
        await this.store(run.id, commit, result, checkedAt);
      }
      if (result !== null && readJobs(result)) {
        const before: CiResult = result;
        let after: CiResult;
        try {
          after = await this.readJobs(client, repo, before, settings, now);
        } catch (error) {
          if (!(error instanceof ReadStopped)) throw error;
          const problem = { ...error.problem, at: now.toISOString() };
          await this.store(run.id, commit, { ...before, jobs_problem: problem }, checkedAt);
          throw error;
        }
        await this.store(run.id, commit, after, checkedAt);
      }
    });
  }

  /** Keeps `result` on the run holding `commit`, when it still does. */
  private async store(
    runId: string,
    commit: string,
    result: CiResult,
    checkedAt: Date | null,
  ): Promise<void> {
    await this.options.db
      .update(schema.runs)
      .set({ ciResult: result, ciCheckedAt: checkedAt })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.ciCommit, commit)));
  }

  private async client(): Promise<GitHubClient> {
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient(this.options);
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      throw new ReadStopped({
        reason: 'refused',
        message:
          'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): the owner must save the token again',
        retry_at: null,
      });
    }
    if (client === null) {
      throw new ReadStopped({
        reason: 'refused',
        message: 'No GitHub token is saved: the owner must connect GitHub',
        retry_at: null,
      });
    }
    return client;
  }

  private async withClient(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      throw new ReadStopped({
        reason: 'unreachable',
        message: 'GitHub could not be reached, or answered with a server error',
        retry_at: null,
      });
    }
  }

  /**
   * Lists the failed jobs of the failed workflow runs (once), then reads the logs due, job by job
   * in GitHub's order while each excerpt can still get at least the minimum (owner's answer 3).
   */
  private async readJobs(
    client: GitHubClient,
    repo: { owner: string; name: string },
    result: CiResult,
    settings: {
      githubPollSeconds: number;
      ciLogExcerptMaxLength: number;
      ciLogReadMaxMegabytes: number;
    },
    now: Date,
  ): Promise<CiResult> {
    const workflows = result.checks.filter(
      (check) => check.kind === 'workflow_run' && check.state === 'failed' && check.run_id !== null,
    );
    const listed: { workflow: string; job: WorkflowJob }[] = [];
    for (const workflow of workflows) {
      const jobs = ok(await listRunJobs(client, repo, workflow.run_id ?? 0), now);
      for (const job of jobs) {
        if (
          job.status === 'completed' &&
          !['success', 'skipped', 'neutral'].includes(job.conclusion ?? '')
        ) {
          listed.push({ workflow: workflow.name, job });
        }
      }
    }
    const before = new Map(
      result.jobs_read
        ? result.failed_jobs.map((job) => [`${job.workflow}\n${job.job}\n${job.url ?? ''}`, job])
        : [],
    );
    const failedJobs: CiFailedJob[] = [];
    const reading = jobsWithLogs(listed.map(({ job }) => job.steps.filter(isFailedStep).length));
    for (const [index, { workflow, job }] of listed.entries()) {
      const failedSteps = job.steps.filter(isFailedStep).map((step) => step.name);
      const url = job.url !== null && URL.canParse(job.url) ? job.url : null;
      const entry: CiFailedJob = {
        workflow: maskSecrets(workflow),
        job: maskSecrets(job.name),
        url,
        failed_steps: failedSteps.map(maskSecrets),
        log: { state: 'not_read' },
      };
      if (index >= reading) {
        failedJobs.push(entry);
        continue;
      }
      const kept = before.get(`${entry.workflow}\n${entry.job}\n${url ?? ''}`);
      const due =
        kept === undefined ||
        kept.log.state === 'not_read' ||
        (kept.log.state === 'unavailable' && passing(kept.log.problem));
      if (!due) {
        failedJobs.push({ ...entry, log: kept.log });
        continue;
      }
      entry.log = await this.readLog(client, repo, job, settings, now);
      failedJobs.push(entry);
    }
    return { ...result, failed_jobs: failedJobs, jobs_read: true, jobs_problem: null };
  }

  private async readLog(
    client: GitHubClient,
    repo: { owner: string; name: string },
    job: WorkflowJob,
    settings: {
      githubPollSeconds: number;
      ciLogExcerptMaxLength: number;
      ciLogReadMaxMegabytes: number;
    },
    now: Date,
  ): Promise<CiFailedJob['log']> {
    let read;
    try {
      read = await readFailedStepLogs(client, repo, job, {
        maxCharacters: settings.ciLogExcerptMaxLength,
        maxReadBytes: settings.ciLogReadMaxMegabytes * 1_048_576,
      });
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return {
        state: 'unavailable',
        problem: {
          reason: 'unreachable',
          message: '',
          retry_at: null,
          at: now.toISOString(),
        },
      };
    }
    if (!read.ok) {
      const refusal = read.refusal;
      // A finished job's log GitHub no longer has: expired, or deleted (lot 3 plan, A14).
      if (refusal.kind === 'not_found' || ('status' in refusal && refusal.status === 410)) {
        return {
          state: 'unavailable',
          problem: { reason: 'expired', message: '', retry_at: null, at: now.toISOString() },
        };
      }
      const problem = {
        ...withLimitTime(problemOf(refusal, now), now, settings.githubPollSeconds),
        at: now.toISOString(),
      };
      if (problem.reason === 'rate_limited' && problem.retry_at !== null) {
        this.limitedUntil = new Date(problem.retry_at);
      }
      return { state: 'unavailable', problem };
    }
    return {
      state: 'read',
      excerpts: read.value.excerpts.map((excerpt): CiExcerpt => ({
        step: maskSecrets(excerpt.step),
        fallback: excerpt.cut === 'job' ? excerpt.why : null,
        read_to_end: excerpt.cut === 'job' ? excerpt.readToEnd : true,
        text: excerpt.text,
        cut: excerpt.truncated,
      })),
    };
  }
}

type Template = Templates['ci-status'];
type CiOutput = NonNullable<McpCiStatus['ci']>;

/** The sentence introducing an excerpt: which step, and for the fallback, what it is and why. */
function excerptAbout(t: Template, excerpt: CiExcerpt, megabytes: number): string {
  const cut = excerpt.cut ? ` ${part(t, 'excerpt-cut')}` : '';
  if (excerpt.fallback === null) return part(t, 'excerpt-step', { step: excerpt.step }) + cut;
  if (excerpt.fallback === 'no_failed_step') return part(t, 'excerpt-no-step') + cut;
  const why =
    excerpt.fallback === 'ceiling'
      ? part(t, 'why-ceiling', { megabytes: String(megabytes) })
      : part(t, `why-${excerpt.fallback.replaceAll('_', '-')}`);
  return (
    part(t, excerpt.read_to_end ? 'excerpt-job-end' : 'excerpt-job-end-partial', {
      step: excerpt.step,
      why,
    }) + cut
  );
}

/** Why a log could not be read, for the agent; `again` is when it is read again at the earliest. */
function problemAbout(t: Template, problem: CiReadProblem, again: string): string {
  switch (problem.reason) {
    case 'expired':
      return part(t, 'log-expired');
    case 'unreachable':
      return part(t, 'log-unreachable', { at: again });
    case 'rate_limited':
      return part(t, 'log-rate-limited', { at: problem.retry_at ?? again });
    default:
      return part(t, 'log-refused', { message: problem.message });
  }
}

/** The result as the agent reads it: sentences instead of facts. */
export function ciOutput(
  t: Template,
  result: CiResult,
  settings: { githubPollSeconds: number; ciLogReadMaxMegabytes: number },
): CiOutput {
  const megabytes = settings.ciLogReadMaxMegabytes;
  const failedJobs: CiOutput['failed_jobs'] = [];
  const notRead: CiOutput['logs_not_read']['jobs'] = [];
  for (const job of result.failed_jobs) {
    const { workflow, url } = job;
    const name = job.job;
    if (job.log.state === 'not_read') {
      notRead.push({ workflow, job: name, url, failed_steps: job.failed_steps });
      continue;
    }
    if (job.log.state === 'unavailable') {
      const { problem } = job.log;
      const again = new Date(
        new Date(problem.at).getTime() + settings.githubPollSeconds * 1000,
      ).toISOString();
      const about = problemAbout(t, problem, again);
      const steps = job.failed_steps.length === 0 ? [''] : job.failed_steps;
      failedJobs.push({
        workflow,
        job: name,
        url,
        failed_steps: steps.map((step) => ({ step, about, log: null })),
      });
      continue;
    }
    failedJobs.push({
      workflow,
      job: name,
      url,
      failed_steps: job.log.excerpts.map((excerpt) => ({
        step: excerpt.step,
        about: excerptAbout(t, excerpt, megabytes),
        log: excerpt.text,
      })),
    });
  }
  return {
    state: result.state,
    checks: result.checks.map((check) => ({
      kind: check.kind,
      name: check.name,
      state: check.state,
      url: check.url,
    })),
    failed_jobs: failedJobs,
    logs_not_read: { count: notRead.length, jobs: notRead },
  };
}

/** The end of `text` with the cut marker first, at most about `max` characters. */
export function keepEnd(t: Template, text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (count: number) => part(t, 'log-cut-to-fit', { count: String(count) });
  const room = Math.max(0, max - marker(text.length).length - 1);
  const kept = text.slice(text.length - room);
  const newline = kept.indexOf('\n');
  // On a line boundary when one is near, so the first line shown is whole.
  const whole = newline >= 0 && newline < 200 ? kept.slice(newline + 1) : kept;
  return `${marker(text.length - whole.length)}\n${whole}`;
}

/**
 * The answer within `MCP_OUTPUT_MAX_CHARACTERS` (06, section 4.1): the excerpts cut further, the
 * longest first, each keeping its end with a marker; then, if still needed, the jobs whose log was
 * not read and the checks are listed while they fit, their counts kept and said.
 */
export function fitAnswer(
  t: Template,
  answer: McpCiStatus,
  budget = MCP_OUTPUT_MAX_CHARACTERS,
): McpCiStatus {
  const ci = answer.ci;
  if (ci === null || jsonLength(answer) <= budget) return answer;
  const logs = ci.failed_jobs
    .flatMap((job) => job.failed_steps)
    .filter((step) => step.log !== null);
  for (let round = 0; round < 1000 && jsonLength(answer) > budget; round++) {
    const longest = logs.reduce<(typeof logs)[number] | null>(
      (most, step) => ((step.log?.length ?? 0) > (most?.log?.length ?? 0) ? step : most),
      null,
    );
    const length = longest?.log?.length ?? 0;
    if (longest === null || length <= 300) break;
    const over = jsonLength(answer) - budget;
    const others = logs.filter((step) => step !== longest).map((step) => step.log?.length ?? 0);
    const second = Math.max(0, ...others.filter((size) => size < length));
    const tied = 1 + others.filter((size) => size === length).length;
    // Down to the next longest at most, so the longest are cut first and end up alike; ties share
    // what is still too much. JSON escapes make a log longer as JSON than as text: a margin.
    const target = Math.max(second, length - Math.ceil(over / tied) - 50);
    longest.log = keepEnd(t, longest.log ?? '', Math.max(300, Math.min(target, length - 100)));
  }
  while (jsonLength(answer) > budget && ci.logs_not_read.jobs.length > 0) {
    ci.logs_not_read.jobs.pop();
  }
  const count = ci.checks.length;
  const note = answer.note;
  while (jsonLength(answer) > budget && ci.checks.length > 1) {
    ci.checks.pop();
    const shown = String(ci.checks.length);
    answer.note = `${note} ${part(t, 'checks-cut', { shown, count: String(count) })}`;
  }
  return answer;
}
