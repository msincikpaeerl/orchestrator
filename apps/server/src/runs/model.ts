import { schema } from '@orchestrator/db';
import {
  AccountState,
  CommitSummary,
  FailureReason,
  PauseReason,
  RunEndReason,
  RunPurpose,
  RunStatus,
  UNCOUNTED_FAILURES,
  type DaemonRunState,
  type Run,
} from '@orchestrator/protocol';
import { z } from 'zod';

export type RunRow = typeof schema.runs.$inferSelect;
export type AccountRow = typeof schema.claudeAccounts.$inferSelect;

const Commits = z.array(CommitSummary);

/** The commits a run reported at its end, newest first; null before its report. */
export function reportedCommits(row: Pick<RunRow, 'commits'>): CommitSummary[] | null {
  return row.commits === null ? null : Commits.parse(row.commits);
}

/** Whether the account is `limited` now: once `limited_until` has passed it is available (07, section 3). */
export function isLimited(account: Pick<AccountRow, 'state' | 'limitedUntil'>, now: Date): boolean {
  return (
    account.state === 'limited' &&
    account.limitedUntil !== null &&
    account.limitedUntil.getTime() > now.getTime()
  );
}

/** The state screens show: a limit whose time has passed is shown available, before its event. */
export function effectiveAccountState(
  account: Pick<AccountRow, 'state' | 'limitedUntil'>,
  now: Date,
): { state: AccountState; limitedUntil: Date | null } {
  if (account.state === 'limited' && !isLimited(account, now)) {
    return { state: 'available', limitedUntil: null };
  }
  return { state: AccountState.parse(account.state), limitedUntil: account.limitedUntil };
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
    case 'stopped':
      return { status: 'cancelled', failureReason: 'cancelled' };
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
    case 'cancelled':
      return 'it was cancelled';
  }
}

export interface RunViewContext {
  projectKey: string;
  ticketNumber: number;
  profile: { key: string; name: string };
  machine: { id: string; name: string; online: boolean };
  account: { id: string; label: string };
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
    failureReason: row.failureReason === null ? null : FailureReason.parse(row.failureReason),
    endReason: row.endReason === null ? null : RunEndReason.parse(row.endReason),
    endDetail: row.endDetail,
    attempt: row.attempt,
    sessionAlive: row.sessionAlive,
    branch: { name: row.branchName, head: row.branchHead, commits: reportedCommits(row) ?? [] },
    estimatedUsageUsd: row.estimatedUsageUsd,
    progress:
      row.progressShown === null || row.progressShownAt === null
        ? null
        : { text: row.progressShown, at: row.progressShownAt.toISOString() },
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
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
