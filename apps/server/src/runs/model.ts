import { schema } from '@orchestrator/db';
import {
  AccountState,
  CiCheckFailure,
  CiResult,
  CommitSummary,
  FailureReason,
  PauseReason,
  PushResult,
  RunEndReason,
  RunPurpose,
  RunStatus,
  UNCOUNTED_FAILURES,
  WAITING_RUN_STATUSES,
  WORKING_RUN_STATUSES,
  type DaemonRunState,
  type PullRequestState,
  type Run,
  type RunCiWait,
  SubmissionRecord,
} from '@orchestrator/protocol';
import { z } from 'zod';
import { ciHistory } from './ci-outcome.js';
import { runDownload } from './download.js';
import { runReview } from './review-view.js';

export type RunRow = typeof schema.runs.$inferSelect;
export type AccountRow = typeof schema.claudeAccounts.$inferSelect;

const Commits = z.array(CommitSummary);

/** The commits a run reported at its end, newest first; null before its report. */
export function reportedCommits(row: Pick<RunRow, 'commits'>): CommitSummary[] | null {
  return row.commits === null ? null : Commits.parse(row.commits);
}

/**
 * Whether the account is `limited` now: once `limited_until` has passed it is available (07,
 * section 3). A limit reached while the owner stopped new runs is kept on the paused account,
 * which goes back to it at **Resume** (lot 4 step C).
 */
/**
 * The wait after a usage limit with no reset time (07, section 5.2; lot 4 step E): **Quota wait
 * when the reset time is unknown** the first time, then double the previous wait, never above
 * **Longest quota wait**. `previous` is null when the doubling starts afresh.
 */
export function nextQuotaWait(
  previous: number | null,
  settings: { quotaFallbackDelayMinutes: number; quotaFallbackMaxDelayMinutes: number },
): number {
  const { quotaFallbackDelayMinutes: first, quotaFallbackMaxDelayMinutes: longest } = settings;
  return Math.min(longest, previous === null ? first : Math.max(first, previous * 2));
}

export function isLimited(account: Pick<AccountRow, 'state' | 'limitedUntil'>, now: Date): boolean {
  return (
    (account.state === 'limited' || account.state === 'paused_manual') &&
    account.limitedUntil !== null &&
    account.limitedUntil.getTime() > now.getTime()
  );
}

/** The state screens show: a limit whose time has passed is shown available, before its event. */
export function effectiveAccountState(
  account: Pick<AccountRow, 'state' | 'limitedUntil' | 'limitedUntilEstimated'>,
  now: Date,
): { state: AccountState; limitedUntil: Date | null; estimated: boolean } {
  if (account.state === 'limited' && !isLimited(account, now)) {
    return { state: 'available', limitedUntil: null, estimated: false };
  }
  if (account.state === 'paused_manual') {
    const limited = isLimited(account, now);
    return {
      state: 'paused_manual',
      limitedUntil: limited ? account.limitedUntil : null,
      estimated: limited && account.limitedUntilEstimated,
    };
  }
  return {
    state: AccountState.parse(account.state),
    limitedUntil: account.limitedUntil,
    estimated: account.state === 'limited' && account.limitedUntilEstimated,
  };
}

/**
 * When a run paused on a detected limit can be resumed: its account's limit time, marked
 * `estimated` when it comes from the fallback delay (02, section 4). Null when it can be resumed now.
 */
export function resumeAfter(
  run: Pick<RunRow, 'status' | 'pauseReason'>,
  account: Pick<AccountRow, 'state' | 'limitedUntil' | 'limitedUntilEstimated'>,
  now: Date,
): { at: string; estimated: boolean } | null {
  if (run.status !== 'paused_quota' || run.pauseReason !== 'usage_limit') return null;
  const effective = effectiveAccountState(account, now);
  if (effective.state === 'available' || effective.limitedUntil === null) return null;
  return { at: effective.limitedUntil.toISOString(), estimated: effective.estimated };
}

/** The server's status for a daemon state that does not end the run (05, section 4.7). */
export function statusOfDaemonState(state: Exclude<DaemonRunState, 'ended'>): RunStatus {
  switch (state) {
    case 'preparing':
    case 'starting':
      return 'starting';
    case 'working':
    case 'idle':
    case 'waiting_ci':
      return 'running';
    case 'waiting_human':
      return 'waiting_human';
    case 'quota_paused':
      return 'paused_quota';
  }
}

/** How a run ends for the daemon's reason (05, section 4.7; 01, section 3.7). */
export function endOfReason(
  reason: RunEndReason,
): { status: 'succeeded' } | { status: 'failed' | 'cancelled'; failureReason: FailureReason } {
  switch (reason) {
    case 'submitted':
      return { status: 'succeeded' };
    case 'gave_up':
    case 'nudges_exhausted':
      return { status: 'failed', failureReason: 'agent_gave_up' };
    case 'max_duration':
    case 'idle_timeout':
      return { status: 'failed', failureReason: 'timeout' };
    case 'session_start_timeout':
    case 'crashed':
      return { status: 'failed', failureReason: 'crash' };
    case 'claude_code_unsupported':
      return { status: 'failed', failureReason: 'claude_code_unsupported' };
    case 'process_scope_failed':
      return { status: 'failed', failureReason: 'machine_problem' };
    case 'stopped':
      return { status: 'cancelled', failureReason: 'cancelled' };
    case 'ci_failed':
    case 'ci_timeout':
    case 'review_branch_moved':
    case 'push_failed':
    case 'download_failed':
      return { status: 'failed', failureReason: reason };
  }
}

/** Whether a failure counts as a failed attempt (04, section 5). */
export function isCounted(reason: FailureReason): boolean {
  return !UNCOUNTED_FAILURES.includes(reason);
}

/** The failure reason in words, for the ticket's `system` comment. */
export function failureWords(reason: FailureReason): string {
  switch (reason) {
    case 'timeout':
      return 'it ran out of time';
    case 'crash':
      return 'its Claude Code session stopped unexpectedly or never started';
    case 'agent_gave_up':
      return 'the agent gave up';
    case 'dod_failed':
      return 'its work did not pass the checks';
    case 'machine_offline':
      return 'its machine is offline';
    case 'machine_revoked':
      return 'its machine was revoked';
    case 'claude_code_unsupported':
      return "its machine's Claude Code is missing or too old";
    case 'machine_problem':
      return 'its machine could not start Claude Code in a process scope';
    case 'cancelled':
      return 'it was cancelled';
    case 'ci_failed':
      return 'CI failed more times than the run allows';
    case 'ci_timeout':
      return 'CI wait at submission was reached';
    case 'review_branch_moved':
      return 'the branch changed during the review';
    case 'push_failed':
      return 'its branch could not be pushed to GitHub';
    case 'ci_cancelled':
      return 'CI was cancelled on GitHub because the branch changed there';
    case 'download_failed':
      return 'the project could not be downloaded from GitHub';
  }
}

export interface RunViewContext {
  projectKey: string;
  ticketNumber: number;
  profile: { key: string; name: string };
  machine: { id: string; name: string; online: boolean };
  account: { id: string; label: string };
  /** For a run paused on a detected limit: when it can be resumed (02, section 4). */
  resumeAfter: { at: string; estimated: boolean } | null;
  /** The ticket's pull request and the project's default branch, for the wait for CI. */
  pullRequest: { number: number; url: string; state: PullRequestState } | null;
  base: string | null;
}

export function toRun(row: RunRow, context: RunViewContext): Run {
  return {
    id: row.id,
    projectKey: context.projectKey,
    ticket: `${context.projectKey}-${String(context.ticketNumber)}`,
    purpose: RunPurpose.parse(row.purpose),
    profile: { ...context.profile, version: row.profileVersion },
    machine: context.machine,
    account: context.account,
    status: RunStatus.parse(row.status),
    pauseReason: row.pauseReason === null ? null : PauseReason.parse(row.pauseReason),
    resumeAfter: context.resumeAfter,
    schedulerResumes: row.schedulerResumes,
    failureReason: row.failureReason === null ? null : FailureReason.parse(row.failureReason),
    endReason: row.endReason === null ? null : RunEndReason.parse(row.endReason),
    endDetail: row.endDetail,
    attempt: row.attempt,
    sessionAlive: row.sessionAlive,
    branch: { name: row.branchName, head: row.branchHead, commits: reportedCommits(row) ?? [] },
    push:
      row.push === null || row.pushAt === null
        ? null
        : { result: PushResult.parse(row.push), at: row.pushAt.toISOString() },
    download: runDownload(row),
    estimatedUsageUsd: row.estimatedUsageUsd,
    progress:
      row.progressShown === null || row.progressShownAt === null
        ? null
        : { text: row.progressShown, at: row.progressShownAt.toISOString() },
    outcome: row.outcome,
    ci: ciWait(row, context),
    ciHistory: ciHistory(row),
    review: runReview(row, context.pullRequest?.number ?? null),
    workingMs: row.workingMs,
    waitingMs: row.waitingMs,
    statusSince: row.statusSince.toISOString(),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

/**
 * The run's working and waiting totals when its status changes at `now` (01, section 3.7): the
 * time since `statusSince` goes to the total of the status it leaves, if any.
 */
export function statusTimes(
  row: Pick<RunRow, 'status' | 'statusSince' | 'workingMs' | 'waitingMs'> & {
    ciWaitingSince?: Date | null;
  },
  now: Date,
): Pick<RunRow, 'statusSince' | 'workingMs' | 'waitingMs'> {
  const status = RunStatus.parse(row.status);
  const spent = Math.max(0, now.getTime() - row.statusSince.getTime());
  // A run waiting for CI is `running`, its time waiting (01, section 3.7; lot 3 step G1a).
  const waitingForCi = status === 'running' && (row.ciWaitingSince ?? null) !== null;
  return {
    statusSince: now,
    workingMs: row.workingMs + (WORKING_RUN_STATUSES.includes(status) && !waitingForCi ? spent : 0),
    waitingMs: row.waitingMs + (WAITING_RUN_STATUSES.includes(status) || waitingForCi ? spent : 0),
  };
}

const MINUTE_MS = 60_000;

/**
 * When the run's wait for CI ends: **CI wait at submission** after its start, or after the
 * submission while the pull request is not opened (owner's point 1, step G1); and **Wait for
 * CI to start** after its start. Null for a run without a wait.
 */
export function ciDeadlines(
  row: Pick<
    RunRow,
    'ciCommit' | 'ciWaitStartedAt' | 'ciStartWaitMinutes' | 'ciWaitTimeoutMinutes' | 'submission'
  >,
): { deadline: Date; startDeadline: Date | null } | null {
  if (row.ciCommit === null || row.submission === null) return null;
  const submitted = new Date(SubmissionRecord.parse(row.submission).at);
  const from = row.ciWaitStartedAt ?? submitted;
  return {
    deadline: new Date(from.getTime() + (row.ciWaitTimeoutMinutes ?? 0) * MINUTE_MS),
    startDeadline:
      row.ciWaitStartedAt === null
        ? null
        : new Date(row.ciWaitStartedAt.getTime() + (row.ciStartWaitMinutes ?? 0) * MINUTE_MS),
  };
}

function ciWait(
  row: RunRow,
  context: Pick<RunViewContext, 'pullRequest' | 'base'>,
): RunCiWait | null {
  const deadlines = ciDeadlines(row);
  if (row.ciCommit === null || deadlines === null) return null;
  return {
    commit: row.ciCommit,
    submittedAt: SubmissionRecord.parse(row.submission).at,
    since: row.ciWaitStartedAt?.toISOString() ?? null,
    waitingSince: row.ciWaitingSince?.toISOString() ?? null,
    deadline: deadlines.deadline.toISOString(),
    startDeadline: deadlines.startDeadline?.toISOString() ?? null,
    result: row.ciResult === null ? null : CiResult.parse(row.ciResult),
    checkedAt: row.ciCheckedAt?.toISOString() ?? null,
    checkFailure: row.ciCheckFailure === null ? null : CiCheckFailure.parse(row.ciCheckFailure),
    pullRequest: context.pullRequest,
    base: context.base,
  };
}

/**
 * The ticket branch: `t/<number>-<slug>` (04, section 4), a name Git and the daemon accept, or
 * `t/<number>` when the title gives no usable slug.
 */
export function ticketBranchName(number: number, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `t/${String(number)}` : `t/${String(number)}-${slug}`;
}
