import type {
  BranchCleanUpFailure,
  BranchCleanUpWait,
  BranchKeptReason,
  MachineBranchCleanUp,
  MachineBusy,
  MachineCleanUpWait,
  TicketBranchCleanUp,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

// The clean-up after a merge in the owner's words (lot 3 step J2): why a ticket branch was kept
// on GitHub or on a machine, and what a machine's clean-up waits for, from the facts the server
// keeps. The activity log uses it since J2a, the ticket page's lines since J2c.

const short = (commit: string) => commit.slice(0, 7);

/** The facts a reason is told with: the ticket's reference, its pull request, the merged head. */
export interface KeptContext {
  ticket: string;
  pullRequest: number;
  mergedHead: string;
}

/**
 * Why the branch was kept, as the end of "Branch t/12-… kept on GitHub: …" or "… kept on machine
 * laptop: …", without a full stop.
 */
export function keptReasonText(reason: BranchKeptReason, context: KeptContext): string {
  const pull = `pull request #${String(context.pullRequest)}`;
  switch (reason.kind) {
    case 'ticket_reopened':
      return `${context.ticket} was reopened`;
    case 'another_pull_request':
      return reason.number === null
        ? `${context.ticket}'s merge is no longer recorded as it was`
        : `${context.ticket} has another pull request now (#${String(reason.number)})`;
    case 'not_merged_into_default':
      return reason.merged
        ? `${pull} was merged into ${reason.base} on GitHub, not into the project's default branch`
        : `GitHub no longer says ${pull} is merged`;
    case 'head_branch_differs':
      return `${pull}'s branch on GitHub is ${reason.headBranch}, not this one`;
    case 'fork':
      return reason.headRepository === null
        ? `${pull} comes from a repository that no longer exists`
        : `${pull} comes from another repository (${reason.headRepository})`;
    case 'default_branch_changed':
      return `the repository's default branch on GitHub is now ${reason.github}, not ${reason.stored}`;
    case 'protected_name':
      return reason.which === 'default_branch'
        ? "it is the project's default branch"
        : `it is the base branch of ${pull}`;
    case 'not_a_ticket_branch':
      return `its name is not ${context.ticket}'s branch name`;
    case 'used_as_head':
      return `open pull request #${String(reason.pullRequest)} uses it`;
    case 'used_as_base':
      return `open pull request #${String(reason.pullRequest)} is based on it`;
    case 'moved':
      return `its head on GitHub is ${short(reason.head)}, not the merged head ${short(context.mergedHead)}: commits were pushed after the merge`;
    case 'ref_differs':
      return `GitHub answered for ${reason.ref} instead of this branch`;
    case 'read_failed': {
      const what =
        reason.what === 'pull_request'
          ? pull
          : reason.what === 'open_pull_requests'
            ? 'the open pull requests'
            : 'the branch';
      return `reading ${what} on GitHub failed: ${reason.message.replace(/[.\s]+$/, '')}`;
    }
    case 'refused':
      return `GitHub refused to delete it: ${reason.message.replace(/[.\s]+$/, '')}`;
    case 'local_head_differs':
      return `its head ${short(reason.head)} is not the merged head ${short(context.mergedHead)}; it may hold work that was not merged`;
    case 'bare_head':
      return "it is the current branch of the machine's copy of the repository";
    case 'machine_revoked':
      return 'the machine was revoked';
  }
}

/**
 * What a machine's clean-up waits for, as the end of "Branch t/12-… not deleted on machine laptop
 * yet: …", without a full stop. `offlineSince` is already in the owner's words; `busy`, the
 * machine's latest answer that it is busy with the branch.
 */
export function machineWaitText(
  wait: MachineCleanUpWait,
  offlineSince: string | null,
  busy: MachineBusy | null = null,
): string {
  switch (wait) {
    case 'runs_ending':
      return 'a run stopped by the merge has not reported its end yet';
    case 'offline':
      return offlineSince === null
        ? 'the machine is offline; it is asked when it reconnects'
        : `the machine is offline since ${offlineSince}; it is asked when it reconnects`;
    case 'daemon_outdated':
      return "the machine's daemon is too old to be asked; it is asked once the daemon is updated";
    case 'busy':
      return busy === 'worktree'
        ? 'a run waiting for an answer or paused has it checked out; it is asked again at the next check'
        : 'a run of the same repository was working on the machine; it is asked again at the next check';
    case 'next_check':
      return 'it is asked at the next check';
    case 'answer':
      return 'the machine was asked and has not answered yet';
  }
}

/** A line of the ticket page's clean-up: `kept` lines are framed as a warning. */
export interface CleanUpLine {
  text: string;
  tone: 'done' | 'waiting' | 'kept';
}

/** Why a try on GitHub could not end, tried again at the next check. */
function failureReasonText(failure: BranchCleanUpFailure): string {
  switch (failure.reason) {
    case 'unreachable':
      return 'GitHub could not be reached, or answered with a server error';
    case 'rate_limited':
      return "GitHub's request limit was reached";
    case 'token':
      return 'the saved GitHub token cannot be used (Settings > GitHub)';
    case 'permission_missing':
      return `the token is missing a permission: ${failure.message.replace(/[.\s]+$/, '')}`;
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/**
 * The wait for the end of the runs the merge stopped (owner's answer 1, lot 3 step J2): "the run
 * on laptop was stopped by the merge and laptop has not reported its end yet (offline since …).
 * The branch is deleted once laptop reports its end, or if you revoke laptop."
 */
function endWaitText(waits: BranchCleanUpWait[]): string {
  const machines = new Map<string, { name: string; runs: number; offlineSince: string | null }>();
  for (const wait of waits) {
    const known = machines.get(wait.machine.id);
    if (known) known.runs += 1;
    else {
      machines.set(wait.machine.id, {
        name: wait.machine.name,
        runs: 1,
        offlineSince: wait.offlineSince,
      });
    }
  }
  const each = [...machines.values()].map((machine) => {
    const offline =
      machine.offlineSince === null
        ? ''
        : ` (offline since ${formatDateTime(machine.offlineSince)})`;
    const runs = machine.runs === 1 ? 'the run' : 'the runs';
    const was = machine.runs === 1 ? 'was' : 'were';
    return `${runs} on ${machine.name} ${was} stopped by the merge and ${machine.name} has not reported ${machine.runs === 1 ? 'its' : 'their'} end yet${offline}`;
  });
  const names = joinNames([...machines.values()].map((machine) => machine.name));
  const reports = machines.size === 1 ? `${names} reports its end` : `${names} report their end`;
  const revoke = machines.size === 1 ? names : 'the machine';
  return `${each.join('; ')}. The branch is deleted once ${reports}, or if you revoke ${revoke}.`;
}

/**
 * The clean-up on GitHub, in one line or two (lot 3 step J2c): deleted, already gone, kept with its
 * reason, or waiting with what it waits for; then, after a deletion, a push recorded since.
 */
export function gitHubCleanUpLines(cleanUp: TicketBranchCleanUp, ticket: string): CleanUpLine[] {
  const branch = `Branch ${cleanUp.branch}`;
  const at = cleanUp.decidedAt === null ? '' : ` at ${formatDateTime(cleanUp.decidedAt)}`;
  const lines: CleanUpLine[] = [];
  switch (cleanUp.state) {
    case 'deleted':
      lines.push({ text: `${branch} deleted on GitHub${at}.`, tone: 'done' });
      break;
    case 'already_gone':
      lines.push({
        text: `${branch} was already gone from GitHub when the Orchestrator checked${at}: nothing to delete.`,
        tone: 'done',
      });
      break;
    case 'kept':
      lines.push({
        text: `${branch} kept on GitHub: ${
          cleanUp.reason === null
            ? 'no reason was recorded'
            : keptReasonText(cleanUp.reason, {
                ticket,
                pullRequest: cleanUp.pullRequest,
                mergedHead: cleanUp.mergedHead,
              })
        }.`,
        tone: 'kept',
      });
      break;
    case 'wanted':
      if (cleanUp.waitingFor.length > 0) {
        lines.push({
          text: `${branch} kept on GitHub for now: ${endWaitText(cleanUp.waitingFor)}`,
          tone: 'waiting',
        });
      } else if (cleanUp.failure !== null) {
        lines.push({
          text: `${branch} not deleted on GitHub yet: at ${formatDateTime(cleanUp.failure.at)}, ${failureReasonText(cleanUp.failure)}. The Orchestrator tries again at the next check.`,
          tone: 'waiting',
        });
      } else {
        lines.push({
          text: `${branch} is deleted on GitHub at the next check.`,
          tone: 'waiting',
        });
      }
      break;
  }
  const again = cleanUp.pushedAgain;
  if (again !== null) {
    lines.push({
      text: `${branch} is on GitHub again since ${formatDateTime(again.at)}: ${again.machine} pushed ${short(again.head)} after the deletion, a commit that was not merged. It is kept; delete it on GitHub if you do not need it.`,
      tone: 'kept',
    });
  }
  return lines;
}

/** The clean-up on one machine (lot 3 step J2c): deleted, already gone, kept, or waiting. */
export function machineCleanUpLine(
  row: MachineBranchCleanUp,
  cleanUp: TicketBranchCleanUp,
  ticket: string,
): CleanUpLine {
  const branch = `Branch ${cleanUp.branch}`;
  const machine = `machine ${row.machine.name}`;
  const at = row.decidedAt === null ? '' : ` at ${formatDateTime(row.decidedAt)}`;
  switch (row.state) {
    case 'deleted':
      return { text: `${branch} deleted on ${machine}${at}.`, tone: 'done' };
    case 'already_gone':
      return {
        text: `${branch} was already gone from ${machine}${at}: nothing to delete.`,
        tone: 'done',
      };
    case 'kept':
      return {
        text: `${branch} kept on ${machine}: ${
          row.reason === null
            ? 'no reason was recorded'
            : keptReasonText(row.reason, {
                ticket,
                pullRequest: cleanUp.pullRequest,
                mergedHead: cleanUp.mergedHead,
              })
        }.`,
        tone: 'kept',
      };
    case 'wanted':
      return {
        text: `${branch} not deleted on ${machine} yet: ${machineWaitText(
          row.waiting ?? 'next_check',
          row.offlineSince === null ? null : formatDateTime(row.offlineSince),
          row.busy,
        )}.`,
        tone: 'waiting',
      };
  }
}
