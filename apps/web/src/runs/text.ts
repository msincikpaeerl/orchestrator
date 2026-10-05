import {
  ACTIVE_RUN_STATUSES,
  PROGRESS_CARD_MAX_LENGTH,
  WAITING_RUN_STATUSES,
  WORKING_RUN_STATUSES,
  type AccountStatus,
  type Comment,
  type FailureReason,
  type MachineUnavailable,
  type PauseReason,
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
  ci_timeout: 'CI did not finish in time',
  review_branch_moved: 'the branch changed during the review',
};

export const pauseText: Record<PauseReason, string> = {
  usage_limit: 'the Claude usage limit was reached',
  suspected_usage_limit: 'suspected usage limit (an error that may be the limit)',
};

export const causeText: Record<RunChangeCause, string> = {
  daemon: 'reported by its machine',
  run_now: 'Run now',
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
};

/** Why one machine cannot take a run, for the refusal of **Run now** or **Resume**. */
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
    case 'account_busy':
      return `its Claude account ${unavailable.account.label} already runs its maximum of ${String(unavailable.maxConcurrentRuns)} run${unavailable.maxConcurrentRuns === 1 ? '' : 's'} at a time`;
  }
}

/** Why **Run now** or **Resume** cannot start (07, section 3). */
export function runRefusalText(refusal: RunRefusal): string {
  switch (refusal.reason) {
    case 'ticket_not_todo':
      return `Run now is for a ticket in To do; this one is ${statusLabel[refusal.status]}.`;
    case 'no_assignee':
      return 'Choose an assignee first: the agent that should do this ticket.';
    case 'blocked':
      return `This ticket waits for ${refusal.tickets.join(', ')}, which ${refusal.tickets.length === 1 ? 'is' : 'are'} not done yet.`;
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
        : `The ticket's work (${String(refusal.commits)} commit${refusal.commits === 1 ? '' : 's'}) is on machine ${refusal.machine.name}, and ${unavailableText(refusal.unavailable)}. The run can only continue there.`;
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
    case 'account_busy':
      return `The Claude account ${refusal.account.label} already runs its maximum of ${String(refusal.maxConcurrentRuns)} run${refusal.maxConcurrentRuns === 1 ? '' : 's'} at a time. Try again when one finishes.`;
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
  run: Pick<Run, 'status' | 'workingMs' | 'waitingMs' | 'statusSince'>,
  now: number,
): { workingMs: number; waitingMs: number } {
  const current = Math.max(0, now - new Date(run.statusSince).getTime());
  return {
    workingMs: run.workingMs + (WORKING_RUN_STATUSES.includes(run.status) ? current : 0),
    waitingMs: run.waitingMs + (WAITING_RUN_STATUSES.includes(run.status) ? current : 0),
  };
}

/** "$0.42 (estimated by Claude Code)", or "Not known yet". */
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
 * "estimated" when that time comes from the fallback delay; "Paused" comes with lot 4.
 */
export function accountStatusText(
  account: Pick<AccountStatus, 'state' | 'limitedUntil' | 'limitedUntilEstimated'>,
): string {
  switch (account.state) {
    case 'available':
      return 'Available';
    case 'paused_manual':
      return 'Paused';
    case 'limited':
      return account.limitedUntil === null
        ? 'Limited'
        : `Limited until ${formatDateTime(account.limitedUntil)}${account.limitedUntilEstimated ? ' (estimated)' : ''}`;
  }
}

/** The run's status in one sentence, for the run page and the lists of runs. */
export function runStateText(
  run: Pick<Run, 'status' | 'pauseReason' | 'failureReason' | 'machine'>,
): string {
  const offline = isActive(run.status) && !run.machine.online ? ' (machine offline)' : '';
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
