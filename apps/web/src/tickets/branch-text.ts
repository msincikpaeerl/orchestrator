import type { Run, TicketBranch } from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import { shortHash } from '../runs/text';

/**
 * The ticket branch in plain words (02, section 6.4; lot 3 step D3). "Pushed" always comes with
 * its date: the Orchestrator does not read GitHub's branch, so it says what it pushed and when,
 * never what GitHub holds now.
 */
export function branchStateText(branch: TicketBranch): string {
  const machine = branch.machine?.name ?? 'unknown';
  switch (branch.where) {
    case 'no_commits':
      return ': no commits reported yet';
    case 'machine':
      return ` on machine ${machine}, not on GitHub yet`;
    case 'github': {
      const holder = branch.machine?.name ?? branch.pushed?.machine?.name;
      return `: every commit reported was on GitHub when ${holder ? `machine ${holder}` : 'its machine'} last pushed or downloaded the branch`;
    }
    case 'machine_ahead': {
      const count = branch.notOnGitHubCount;
      return `: ${String(count)} newer commit${count === 1 ? '' : 's'} on machine ${machine}, not on GitHub yet`;
    }
    case 'diverged':
      return ` on machine ${machine}, not on GitHub yet: GitHub's branch has commits this machine does not have, so the push was refused. The Orchestrator never overwrites GitHub's branch.`;
  }
}

function from(machine: TicketBranch['machine']): string {
  return machine ? ` from machine ${machine.name}` : '';
}

/** The last push done, with its date and machine; null when nothing was pushed. */
export function pushedText(branch: TicketBranch): string | null {
  const { pushed } = branch;
  if (!pushed) return null;
  return `Last pushed to GitHub on ${formatDateTime(pushed.at)}${from(pushed.machine)} (latest commit ${shortHash(pushed.head)}).`;
}

/** The latest failed push since the last one done, shown while commits are not on GitHub. */
export function pushFailureText(branch: TicketBranch): string | null {
  const failure = branch.pushFailure;
  if (!failure) return null;
  return `The push to GitHub on ${formatDateTime(failure.at)}${from(failure.machine)} failed: ${failure.message}`;
}

/** A run's own latest push, on its page: what it did, not where the branch is now. */
export function runPushText(push: NonNullable<Run['push']>): string {
  const at = formatDateTime(push.at);
  return push.result.status === 'pushed'
    ? `This run pushed it to GitHub on ${at} (latest commit ${shortHash(push.result.head)}). The ticket page says where the branch is now.`
    : `This run's push to GitHub on ${at} failed: ${push.result.message}`;
}
