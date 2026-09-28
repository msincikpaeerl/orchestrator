import type {
  FailureReason,
  MachineUnavailable,
  PauseReason,
  RunChangeCause,
  RunRefusal,
  RunStatus,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { statusLabel } from '../tickets/text';

// Runs in plain words (02, section 1: the owner never reads codes). The run screens come with
// lot 2 step L; the refusals and the event log use these texts from step J.

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
  cancelled: 'it was cancelled',
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
