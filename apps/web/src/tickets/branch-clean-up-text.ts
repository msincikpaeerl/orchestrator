import type { BranchKeptReason, MachineCleanUpWait } from '@orchestrator/protocol';

// The clean-up after a merge in the owner's words (lot 3 step J2): why a ticket branch was kept
// on GitHub or on a machine, and what a machine's clean-up waits for, from the facts the server
// keeps. The activity log uses it since J2a; the ticket page lines come with J2c.

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
      return `its head ${short(reason.head)} is not the merged head ${short(context.mergedHead)}`;
    case 'in_use':
      return reason.by === 'worktree'
        ? 'a run waiting for an answer or paused still has it checked out'
        : reason.by === 'run'
          ? 'a run of the same repository was working on the machine'
          : "it is the current branch of the machine's copy of the repository";
    case 'machine_revoked':
      return 'the machine was revoked';
  }
}

/**
 * What a machine's clean-up waits for, as the end of "Branch t/12-… not deleted on machine laptop
 * yet: …", without a full stop. `offlineSince` is already in the owner's words.
 */
export function machineWaitText(wait: MachineCleanUpWait, offlineSince: string | null): string {
  switch (wait) {
    case 'runs_ending':
      return 'a run stopped by the merge has not reported its end yet';
    case 'offline':
      return offlineSince === null
        ? 'the machine is offline; it is asked when it reconnects'
        : `the machine is offline since ${offlineSince}; it is asked when it reconnects`;
    case 'daemon_outdated':
      return "the machine's daemon is too old to be asked; it is asked once the daemon is updated";
    case 'next_check':
      return 'it is asked at the next check';
    case 'answer':
      return 'the machine was asked and has not answered yet';
  }
}
