import {
  ACTIVE_RUN_STATUSES,
  PROGRESS_CARD_MAX_LENGTH,
  WAITING_RUN_STATUSES,
  WORKING_RUN_STATUSES,
  type AccountStatus,
  type Comment,
  type BlockingItem,
  type FailureReason,
  type HoldCause,
  type MachineFailureCause,
  type MachineUnavailable,
  type PauseReason,
  type QueueReason,
  type Run,
  type RunChangeCause,
  type RunLogEntry,
  type RunPurpose,
  type RunRefusal,
  type RunStatus,
  type TicketDetail,
  type TicketSummary,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

/** **Stop new runs** in force (07, section 5.5): the account's screens and Run now's refusal. */
export const PAUSED_TEXT = 'you stopped new runs on it';
import { WAITING_FOR_CI } from './ci-text';
import { statusLabel } from '../tickets/text';

// Runs in plain words (02, section 1: the owner never reads codes), for the run screens, the
// refusals and the event log.

export const runStatusLabel: Record<RunStatus, string> = {
  queued: 'Queued',
  dispatched: 'Sent to its machine',
  starting: 'Starting',
  running: 'Running',
  waiting_human: 'Waiting for you',
  paused_quota: 'Paused',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const failureText: Record<FailureReason, string> = {
  timeout: 'it ran out of time',
  crash: 'its Claude Code session stopped unexpectedly or never started',
  agent_gave_up: 'the agent gave up',
  dod_failed: 'its work did not pass the checks',
  machine_offline: 'its machine was offline',
  machine_revoked: 'its machine was revoked',
  claude_code_unsupported: "its machine's Claude Code was missing or too old",
  machine_problem: 'its machine could not start Claude Code in a process scope',
  cancelled: 'it was cancelled',
  ci_failed: 'CI failed more times than the run allows',
  ci_timeout: 'CI wait at submission was reached',
  review_branch_moved: 'the branch changed during the review',
  push_failed: 'its branch could not be pushed to GitHub',
  ci_cancelled: 'CI was cancelled on GitHub because the branch changed there',
  download_failed: 'the project could not be downloaded from GitHub',
};

export const pauseText: Record<PauseReason, string> = {
  usage_limit: 'the Claude usage limit was reached',
  suspected_usage_limit: 'suspected usage limit (an error that may be the limit)',
};

export const causeText: Record<RunChangeCause, string> = {
  daemon: 'reported by its machine',
  run_now: 'Run now',
  scheduler: 'started by the scheduler',
  resume: 'Resume',
  owner_stopped: 'stopped by you',
  ticket_cancelled: 'the ticket was cancelled',
  ticket_done: 'the ticket was marked as done',
  dispatch_timeout: 'the machine did not confirm in time',
  dispatch_refused: 'the machine refused it',
  machine_offline: 'the machine was offline',
  machine_revoked: 'the machine was revoked',
  claude_code_unsupported: "the machine's Claude Code is missing or too old",
  answer: 'you answered its question',
  ci_result: 'its CI result on GitHub',
  ci_timeout: '"CI wait at submission" was reached',
  review_decision: "the pull request changed on GitHub before Quality's decision",
  pull_request_merged: 'its pull request was merged on GitHub',
};

/** A failure a machine caused, which leaves it out for the ticket (07, section 4; lot 4). */
export const machineFailureText: Record<MachineFailureCause, string> = {
  machine_offline: 'the machine went offline',
  machine_revoked: 'the machine was revoked',
  claude_code_unsupported: "the machine's Claude Code was missing or too old",
  machine_problem: 'the machine could not start Claude Code in a process scope',
  dispatch_timeout: 'the machine did not confirm the start in time',
  dispatch_refused: 'the machine refused the start',
};

/**
 * Why one machine cannot take a run, for the refusal of **Run now** or **Resume**, and the
 * scheduler's queue, whose account windows, budget and machines left out Run now never gives.
 */
export function unavailableText(unavailable: MachineUnavailable): string {
  switch (unavailable.why) {
    case 'waiting_enrollment':
      return 'it is not enrolled yet';
    case 'offline':
      return 'it is offline';
    case 'disabled':
      return 'it is disabled';
    case 'revoked':
      return 'it is revoked';
    case 'daemon_incompatible':
      return 'its daemon must be updated';
    case 'unusable':
      return 'it cannot receive runs (see its page)';
    case 'missing_capabilities':
      return `it lacks ${unavailable.capabilities.join(', ')}`;
    case 'account_limited':
      return `its Claude account ${unavailable.account.label} reached its usage limit, until ${formatDateTime(unavailable.until)}`;
    case 'account_paused':
      return `its Claude account ${unavailable.account.label} is paused: ${PAUSED_TEXT}`;
    case 'account_busy':
      return `its Claude account ${unavailable.account.label} already runs its maximum of ${String(unavailable.maxConcurrentRuns)} run${unavailable.maxConcurrentRuns === 1 ? '' : 's'} at a time`;
    case 'account_outside_window':
      return unavailable.next === null
        ? `its Claude account ${unavailable.account.label} is outside its windows`
        : `its Claude account ${unavailable.account.label} is outside its window until ${formatDateTime(unavailable.next)}`;
    case 'account_budget_used':
      return `its Claude account ${unavailable.account.label} has used its daily budget for today, until ${formatDateTime(unavailable.until)}`;
    case 'left_out':
      return `it is left out for this ticket since ${formatDateTime(unavailable.at)}, when ${machineFailureText[unavailable.cause]}, until it connects again or you use Run now`;
  }
}

/** A held ticket (07, section 1; lot 4): why, and how to release it. */
export const holdText: Record<HoldCause, string> = {
  stop_run: 'Held: you stopped its run. Run now releases it and starts it.',
  stop_review: 'Held: you stopped its review. Start review releases it and starts it.',
  request_changes:
    'Held: you asked to edit its acceptance criteria first. Run now releases it and starts it.',
};

/** A held ticket on its page (02, section 6.4; lot 4 step D2b). */
export const ticketHoldText: Record<HoldCause, string> = {
  stop_run:
    'Held: you stopped its run. The scheduler does not start it again until you use Run now.',
  stop_review:
    'Held: you stopped its review. The scheduler does not start it again until you use Start review.',
  request_changes:
    'Held: you asked to edit its acceptance criteria first. The scheduler does not start the fix until you use Run now.',
};

/** The blocking "Needs you" item a ticket waits on (04, section 5.1; 07, section 4; lot 4). */
export function blockingItemText(item: BlockingItem, machine: string | null): string {
  const on = machine === null ? '' : ` on ${machine}`;
  switch (item) {
    case 'ci_timeout':
      return 'its run ended before CI finished on GitHub';
    case 'ci_cancelled':
      return 'CI was cancelled on GitHub because the branch changed there';
    case 'push_failed':
      return 'its branch could not be pushed to GitHub';
    case 'download_failed':
      return `the project could not be downloaded from GitHub${on}`;
    case 'review_not_finished':
      return 'its review did not finish';
    case 'machine_failures':
      return `it could not start${on}`;
  }
}

/**
 * Why a candidate of the scheduler's queue is not running (07, section 7; lot 4): Run now's words
 * for Run now's reasons, and the two only the scheduler has.
 */
export function queueReasonText(reason: QueueReason): string {
  switch (reason.reason) {
    case 'held':
      return holdText[reason.cause];
    case 'needs_you':
      return `Waiting for you in Needs you: ${blockingItemText(reason.item, reason.machine?.name ?? null)}.`;
    default:
      return runRefusalText(reason);
  }
}

/** Why **Run now** or **Resume** cannot start (07, section 3). */
export function runRefusalText(refusal: RunRefusal): string {
  switch (refusal.reason) {
    case 'ticket_not_todo':
      return `Run now is for a ticket in To do; this one is ${statusLabel[refusal.status]}.`;
    case 'no_assignee':
      return 'Choose an assignee first: the agent that should do this ticket.';
    case 'ticket_stopped':
      // Owner's answer 2, lot 3 step I; the failed attempts' words, owner's answer 3 of step K.
      return refusal.cause === 'review_rounds'
        ? `This ticket is stopped after ${String(refusal.count)} requests for changes by Quality (Most review rounds per ticket: ${String(refusal.limit)}): use Try again, Cancel or Mark as done manually.`
        : `This ticket is stopped after ${String(refusal.count)} failed attempt${refusal.count === 1 ? '' : 's'} (Failed attempts before asking you: ${String(refusal.limit)}): use Try again, Cancel or Mark as done manually.`;
    case 'blocked': {
      // A cancelled blocker blocks until the dependency is removed (owner, review of lot 4 D1).
      const cancelled = new Set(refusal.cancelled);
      const waiting = refusal.tickets.filter((ticket) => !cancelled.has(ticket));
      const named = [...cancelled];
      const removal =
        named.length === 0
          ? ''
          : `Blocked by ${named.map((ticket) => `${ticket} (cancelled)`).join(', ')}: remove the ${named.length === 1 ? 'dependency' : 'dependencies'} to let it start.`;
      if (waiting.length === 0) return removal;
      const sentence = `This ticket waits for ${waiting.join(', ')}, which ${waiting.length === 1 ? 'is' : 'are'} not done yet.`;
      return removal === '' ? sentence : `${sentence} ${removal}`;
    }
    case 'project_archived':
      return 'This project is archived. Unarchive it first.';
    case 'project_not_ready':
      return 'The repository setup of this project is not finished.';
    case 'github_not_connected':
      return 'GitHub is not connected. Connect it in Settings > GitHub connection first.';
    case 'github_token_unreadable':
      return 'The saved GitHub token cannot be read any more. Enter it again in Settings > GitHub connection.';
    case 'github_token_invalid':
      return 'GitHub does not accept the saved token. Enter a new one in Settings > GitHub connection.';
    case 'github_account_unknown':
      return 'GitHub could not be reached to read your account, which agents sign their commits with. Check the internet connection and try again.';
    case 'first_message_too_large':
      return "This ticket is too large for an agent's first message, even with its description shortened. Shorten the ticket, for example its dependencies or acceptance criteria.";
    case 'machine_unavailable':
      return refusal.commits === null
        ? `This run can only continue on machine ${refusal.machine.name}, and ${unavailableText(refusal.unavailable)}.`
        : `The ticket's branch has ${String(refusal.commits)} commit${refusal.commits === 1 ? '' : 's'} not on GitHub, only on machine ${refusal.machine.name}, and ${unavailableText(refusal.unavailable)}. The run can only continue there.`;
    case 'no_machine':
      return refusal.machines.length === 0
        ? 'No machine can take the run: add a machine in Machines first.'
        : `No machine can take the run: ${refusal.machines
            .map((entry) => `${entry.machine.name}: ${unavailableText(entry.unavailable)}`)
            .join('; ')}.`;
    case 'run_not_paused':
      return 'This run is not paused any more. Reload the page.';
    case 'account_limited':
      return `The Claude account ${refusal.account.label} reached its usage limit. You can resume after ${formatDateTime(refusal.until)}.`;
    case 'account_paused':
      return `The Claude account ${refusal.account.label} is paused: ${PAUSED_TEXT}. Resume the account in Machines first.`;
    case 'account_busy':
      return `The Claude account ${refusal.account.label} already runs its maximum of ${String(refusal.maxConcurrentRuns)} run${refusal.maxConcurrentRuns === 1 ? '' : 's'} at a time. Try again when one finishes.`;
    case 'ticket_not_in_review':
      return `Start review is for a ticket In review; this one is ${statusLabel[refusal.status]}.`;
    case 'no_pull_request':
      return 'This ticket has no pull request to review: check its work yourself, then use Mark as done manually or Request changes.';
    case 'review_active':
      return 'A review of this ticket is already running.';
    case 'review_head_moved':
      return `The pull request's head on GitHub (${refusal.head.slice(0, 7)}) is not the commit CI checked (${refusal.commit.slice(0, 7)}): the branch was changed on GitHub. Use Skip review and check it yourself, or Request changes.`;
    case 'pull_request_not_open':
      return refusal.merged
        ? `Pull request #${String(refusal.pullRequest)} was merged on GitHub. Use Mark as done manually.`
        : `Pull request #${String(refusal.pullRequest)} is closed on GitHub, so there is nothing to review. Reopen it first, with Reopen pull request on the ticket page or in Needs you.`;
    case 'github_problem':
      return `GitHub could not be read to check the pull request (${refusal.message.replace(/\.$/, '')}). Try again in a moment.`;
  }
}

export const purposeLabel: Record<RunPurpose, string> = {
  implement: 'Implement the ticket',
  review: 'Review',
  plan: 'Plan',
  document: 'Document',
  fix_review: 'Fix after review',
};

export const logKindLabel: Record<RunLogEntry['kind'], string> = {
  agent_text: 'Agent',
  tool_call: 'Tool',
  tool_result: 'Result',
  input: 'Message sent to the agent',
  warning: 'Warning',
};

export function isActive(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * The run page's Branch sentence (02, section 7): the branch as the run left it, or what is true
 * when the run ended without one on its machine, or at its download, before working on it (lot 3
 * step L). `commits` is false when there is no branch whose commits could be listed.
 */
export function runBranchText(
  run: Pick<Run, 'branch' | 'status' | 'endReason'> & { machine: { name: string } },
): { text: string; commits: boolean } {
  const { name, head } = run.branch;
  const machine = run.machine.name;
  if (isActive(run.status)) return { text: `${name} on machine ${machine}`, commits: true };
  if (head === null) {
    return {
      text:
        run.endReason === 'download_failed'
          ? `No branch was made on machine ${machine}: the run ended before the project was downloaded.`
          : `Machine ${machine} reported no branch ${name} at the end of this run.`,
      commits: false,
    };
  }
  if (run.endReason === 'download_failed') {
    return {
      text: `${name} on machine ${machine}, as it was before this run: the run ended before the project was downloaded, so it never worked on the branch.`,
      commits: true,
    };
  }
  return { text: `${name} on machine ${machine}, as this run left it`, commits: true };
}

/** "1 h 5 min", "3 min", "45 s": a run's working or waiting time. */
export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/**
 * The run's working and waiting times at `now`: the stored totals, plus the current period of an
 * active run (01, section 3.7).
 */
export function runTimes(
  run: Pick<Run, 'status' | 'workingMs' | 'waitingMs' | 'statusSince'> & {
    ci?: Run['ci'];
  },
  now: number,
): { workingMs: number; waitingMs: number } {
  const current = Math.max(0, now - new Date(run.statusSince).getTime());
  // A run waiting for CI is running, its time waiting (lot 3 step G1a).
  const waitingForCi = run.status === 'running' && (run.ci?.waitingSince ?? null) !== null;
  return {
    workingMs:
      run.workingMs + (WORKING_RUN_STATUSES.includes(run.status) && !waitingForCi ? current : 0),
    waitingMs:
      run.waitingMs + (WAITING_RUN_STATUSES.includes(run.status) || waitingForCi ? current : 0),
  };
}

/** "$0.42 (estimated by Claude Code)", or "Not known yet". */
/**
 * The ticket's estimated usage, its runs' together (07, section 5.4; lot 4 step C): a run Claude
 * Code gave no estimate for counts as nothing and is named apart.
 */
export function ticketUsageText(runs: readonly Pick<Run, 'estimatedUsageUsd'>[]): string {
  const total = runs.reduce((sum, run) => sum + (run.estimatedUsageUsd ?? 0), 0);
  const unknown = runs.filter((run) => run.estimatedUsageUsd === null).length;
  const amount = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const runCount = `${String(runs.length)} run${runs.length === 1 ? '' : 's'}`;
  return `Estimated usage: ${amount} over ${runCount} (estimated by Claude Code)${
    unknown === 0
      ? ''
      : `; ${String(unknown)} of them ${unknown === 1 ? 'has' : 'have'} no estimate yet and count${unknown === 1 ? 's' : ''} as $0.00`
  }.`;
}

export function usageText(usd: number | null): string {
  return usd === null
    ? 'Not known yet'
    : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (estimated by Claude Code)`;
}

/**
 * Why a run is paused, with what the owner can do (02, section 4): after a detected limit, from
 * when it can be resumed, "estimated" when that time comes from the fallback delay.
 */
export function pausedText(run: Pick<Run, 'pauseReason' | 'resumeAfter'>): string {
  if (run.pauseReason === 'suspected_usage_limit') {
    return 'Run paused: possible Claude usage limit. You can resume it now; the run may pause again if it was the limit.';
  }
  if (run.resumeAfter === null) {
    return 'Claude usage limit reached. Its time has passed: you can resume the run now.';
  }
  return `Claude usage limit reached: you can resume after ${formatDateTime(run.resumeAfter.at)}${
    run.resumeAfter.estimated ? ' (estimated)' : ''
  }.`;
}

/**
 * A Claude account's compact status line (02, section 4): "Available" or "Limited until <time>",
 * "estimated" when that time comes from the fallback delay; "Paused" (lot 4), with a usage limit
 * reached meanwhile.
 */
export function accountStatusText(
  account: Pick<AccountStatus, 'state' | 'limitedUntil' | 'limitedUntilEstimated'>,
): string {
  switch (account.state) {
    case 'available':
      return 'Available';
    case 'paused_manual':
      return account.limitedUntil === null
        ? 'Paused'
        : `Paused, and limited until ${formatDateTime(account.limitedUntil)}${account.limitedUntilEstimated ? ' (estimated)' : ''}`;
    case 'limited':
      return account.limitedUntil === null
        ? 'Limited'
        : `Limited until ${formatDateTime(account.limitedUntil)}${account.limitedUntilEstimated ? ' (estimated)' : ''}`;
  }
}

/** The run's status in one sentence, for the run page and the lists of runs. */
export function runStateText(
  run: Pick<Run, 'status' | 'pauseReason' | 'failureReason' | 'machine'> & { ci?: Run['ci'] },
): string {
  const offline = isActive(run.status) && !run.machine.online ? ' (machine offline)' : '';
  // Its work accepted, the run waits for CI on GitHub (lot 3 step G1b).
  if (run.status === 'running' && (run.ci ?? null) !== null) return `${WAITING_FOR_CI}${offline}`;
  switch (run.status) {
    case 'paused_quota':
      return `Paused: ${run.pauseReason ? pauseText[run.pauseReason] : 'usage limit'}${offline}`;
    case 'failed':
    case 'cancelled':
      return `${runStatusLabel[run.status]}: ${run.failureReason ? failureText[run.failureReason] : 'no reason given'}`;
    default:
      return `${runStatusLabel[run.status]}${offline}`;
  }
}

/** The board card's run indicator: its status, and its progress line cut to the card's length. */
export function cardRunText(run: NonNullable<TicketSummary['activeRun']>): {
  status: string;
  progress: string | null;
} {
  const where = run.machine.online ? `on ${run.machine.name}` : `on ${run.machine.name}, offline`;
  const status =
    run.status === 'paused_quota'
      ? `Paused ${where}`
      : run.status === 'waiting_human'
        ? `Waiting for your answer (${run.machine.name})`
        : run.waitingForCi
          ? `${WAITING_FOR_CI} ${where}`
          : `${runStatusLabel[run.status]} ${where}`;
  const text = run.progress?.text ?? null;
  return {
    status,
    progress:
      text === null || text.length <= PROGRESS_CARD_MAX_LENGTH
        ? text
        : `${text.slice(0, PROGRESS_CARD_MAX_LENGTH - 1).trimEnd()}…`,
  };
}

/** The first 7 characters of a commit hash, as Git shows it. */
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * The question waiting for the owner's answer: the ticket is `waiting_human` and its last
 * question has no answer yet (04, section 6).
 */
export function openQuestion(ticket: Pick<TicketDetail, 'status' | 'timeline'>): Comment | null {
  if (ticket.status !== 'waiting_human') return null;
  const comments = ticket.timeline.flatMap((entry) =>
    entry.type === 'comment' ? [entry.comment] : [],
  );
  const question = comments.filter((comment) => comment.kind === 'question').at(-1);
  if (!question) return null;
  return comments.some((comment) => comment.answers === question.id) ? null : question;
}

/** The time of a log entry, to the second: entries often come within one minute. */
export function logTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** The run page (02, section 7). */
export function runPath(id: string): string {
  return `/activity/runs/${encodeURIComponent(id)}`;
}

/**
 * The run page's refused submission followed by the accepted one (owner's correction, step F4):
 * one sentence with its date, so the refusal is not read as the run's outcome; null otherwise.
 */
export function acceptedAfterText(run: {
  refusedSubmission: { at: string } | null;
  acceptedSubmissionAt: string | null;
}): string | null {
  const refused = run.refusedSubmission;
  if (!refused || run.acceptedSubmissionAt === null) return null;
  if (Date.parse(run.acceptedSubmissionAt) <= Date.parse(refused.at)) return null;
  return `The agent then handed its work in again, and it was accepted on ${formatDateTime(run.acceptedSubmissionAt)}.`;
}
