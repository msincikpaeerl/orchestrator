import type { BranchKeptReason } from '@orchestrator/protocol';

// The clean-up after a merge in the owner's words (lot 3 step J2): why a ticket branch was kept
// on GitHub, from the facts the server keeps. The activity log uses it since J2a; the ticket page
// lines come with J2c.

const short = (commit: string) => commit.slice(0, 7);

/** The facts a reason is told with: the ticket's reference, its pull request, the merged head. */
export interface KeptContext {
  ticket: string;
  pullRequest: number;
  mergedHead: string;
}

/** Why the branch was kept, as the end of "Branch t/12-… kept on GitHub: …", without a full stop. */
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
  }
}
